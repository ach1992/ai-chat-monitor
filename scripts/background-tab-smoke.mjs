import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { verifyManifestAssets } from "./verify-manifest-assets.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionPath = await realpath(resolve(repoRoot, "dist"));
await verifyManifestAssets(extensionPath);

const CONVERSATION_ID = "background-smoke-chat";
const STATUS_LINE = 'AI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}';
const TEST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>AI Chat Monitor background smoke</title>
<div data-message-author-role="user" data-message-id="user-1">Please finish the task.</div>
<div data-message-author-role="assistant" data-message-id="assistant-1" id="assistant">Working...</div>
<div id="prompt-textarea" data-testid="composer" contenteditable="true"></div>
<button data-testid="stop-button" id="stop">Stop generating</button>`;

function findOnPath(command) {
  if (command.includes("/")) return existsSync(command) ? command : undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const browser = [process.env.CHROME_BIN, "google-chrome-for-testing", "chromium", "chromium-browser"]
  .filter((candidate) => typeof candidate === "string" && candidate.length > 0)
  .map(findOnPath)
  .find((candidate) => candidate !== undefined);
if (browser === undefined) {
  throw new Error("Chrome for Testing/Chromium was not found. Set CHROME_BIN to run the background-tab smoke test.");
}
const xvfbRun = findOnPath("xvfb-run");
if (process.platform !== "win32" && xvfbRun === undefined) {
  throw new Error("xvfb-run is required for the background-tab smoke test on Linux.");
}

const profilePath = await mkdtemp(resolve(tmpdir(), "ai-chat-monitor-background-profile-"));
const certificatePath = await mkdtemp(resolve(tmpdir(), "ai-chat-monitor-background-cert-"));
const keyPath = resolve(certificatePath, "key.pem");
const certPath = resolve(certificatePath, "cert.pem");
const openssl = findOnPath("openssl");
if (openssl === undefined) throw new Error("openssl is required for the background-tab smoke test.");
const certificate = spawnSync(openssl, [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath,
  "-subj", "/CN=chatgpt.com", "-days", "1",
], { stdio: "ignore" });
if (certificate.status !== 0) throw new Error("Unable to create the background-tab smoke certificate.");

const server = createServer(
  { key: await readFile(keyPath), cert: await readFile(certPath) },
  (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(TEST_HTML);
  },
);
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Unable to resolve the local smoke server port.");

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
let launchSequence = 0;

async function waitFor(operation, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await operation();
      if (lastValue) return lastValue;
    } catch (error) {
      lastValue = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolvePromise, reject) => {
      this.socket.onopen = resolvePromise;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }

  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolvePromise, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails !== undefined) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

async function launchBrowser() {
  launchSequence += 1;
  const debugPort = 10_000 + (process.pid % 20_000) + launchSequence;
  const browserArgs = [
    "--disable-gpu",
    "--no-first-run",
    "--disable-default-apps",
    "--ignore-certificate-errors",
    `--remote-debugging-port=${debugPort}`,
    `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${address.port}`,
    `--user-data-dir=${profilePath}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "about:blank",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) browserArgs.unshift("--no-sandbox");
  const command = xvfbRun ?? browser;
  const args = xvfbRun === undefined ? browserArgs : ["-a", browser, ...browserArgs];
  const detached = process.platform !== "win32";
  const stderrChunks = [];
  const child = spawn(command, args, { detached, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const port = debugPort;


  const json = async (path) => {
    if (child.exitCode !== null) throw new Error(`browser exited with code ${child.exitCode}: ${Buffer.concat(stderrChunks).toString("utf8").split("\n").slice(-20).join("\n")}`);
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
    return response.json();
  };
  const version = await waitFor(() => json("/json/version"), "Chrome DevTools version");
  const browserClient = new CdpClient(version.webSocketDebuggerUrl);
  const extensionWorker = await waitFor(async () => {
    const targets = await json("/json/list");
    return targets.find((target) => target.type === "service_worker" && /chrome-extension:\/\/[^/]+\/background\/worker\.js$/.test(target.url)) ?? false;
  }, "AI Chat Monitor service worker");
  const extensionId = /chrome-extension:\/\/([^/]+)/.exec(extensionWorker.url)?.[1];
  if (extensionId === undefined) throw new Error("Unable to resolve the AI Chat Monitor extension id.");

  return {
    child,
    detached,
    browserClient,
    extensionId,
    json,
    stderrText: () => Buffer.concat(stderrChunks).toString("utf8"),
    async stop() {
      try { await browserClient.send("Browser.close"); } catch { /* closing or already closed */ }
      browserClient.close();
      await sleep(300);
      if (child.pid !== undefined && child.exitCode === null) {
        try { detached ? process.kill(-child.pid, "SIGTERM") : child.kill("SIGTERM"); } catch { /* already exited */ }
      }
      await sleep(200);
      if (child.pid !== undefined && child.exitCode === null) {
        try { detached ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch { /* already exited */ }
      }
    },
  };
}

async function createPage(environment, url) {
  const target = await environment.browserClient.send("Target.createTarget", { url });
  const info = await waitFor(async () => {
    const targets = await environment.json("/json/list");
    return targets.find((candidate) => candidate.id === target.targetId) ?? false;
  }, `target ${url}`);
  const client = new CdpClient(info.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  return client;
}

let firstBrowser;
let secondBrowser;
let settingsPage;
let chatPage;
let queryPage;
try {
  firstBrowser = await launchBrowser();
  settingsPage = await createPage(firstBrowser, `chrome-extension://${firstBrowser.extensionId}/sidepanel/index.html`);
  const policy = {
    version: 2,
    revision: 1,
    defaults: {
      browserEvents: ["TASK_COMPLETE", "RESPONSE_COMPLETE", "SEMANTIC_UNKNOWN"],
      soundEvents: [],
      stallThresholdMs: 300_000,
      suppressLowPriorityWhileFocused: false,
    },
    chats: [{
      conversationId: CONVERSATION_ID,
      enabled: true,
      browserEvents: ["TASK_COMPLETE", "RESPONSE_COMPLETE", "SEMANTIC_UNKNOWN"],
    }],
  };
  await evaluate(settingsPage, `chrome.storage.local.set({'guardian:monitoring-policy:config':${JSON.stringify(policy)}})`);
  settingsPage.close();
  settingsPage = undefined;
  await firstBrowser.stop();
  firstBrowser = undefined;
  await sleep(400);

  secondBrowser = await launchBrowser();
  chatPage = await createPage(secondBrowser, `https://chatgpt.com/c/${CONVERSATION_ID}`);
  await waitFor(async () => (await evaluate(chatPage, "document.readyState")) === "complete", "synthetic ChatGPT page");
  queryPage = await createPage(secondBrowser, `chrome-extension://${secondBrowser.extensionId}/sidepanel/index.html`);

  const tab = await waitFor(async () => {
    const tabs = await evaluate(queryPage, "chrome.tabs.query({}).then((items) => items.map((item) => ({id:item.id,url:item.url,active:item.active,discarded:item.discarded,frozen:item.frozen,autoDiscardable:item.autoDiscardable})))");
    return tabs.find((candidate) => candidate.url?.includes(`/c/${CONVERSATION_ID}`)) ?? false;
  }, "synthetic ChatGPT tab");

  const session = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    return stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID) ?? false;
  }, "background content-agent registration");
  if (session.observation?.generation !== "GENERATING") throw new Error("Synthetic monitored chat did not begin in GENERATING state.");

  await waitFor(async () => {
    const current = await evaluate(queryPage, `chrome.tabs.get(${tab.id}).then((item) => ({autoDiscardable:item.autoDiscardable}))`);
    return current.autoDiscardable === false;
  }, "automatic-discard protection");

  const blank = await secondBrowser.browserClient.send("Target.createTarget", { url: "about:blank" });
  await secondBrowser.browserClient.send("Target.activateTarget", { targetId: blank.targetId });
  await waitFor(async () => (await evaluate(chatPage, "document.visibilityState")) === "hidden", "hidden monitored tab");

  await evaluate(
    chatPage,
    `(() => { document.querySelector('#assistant').textContent = 'Task done.\\n${STATUS_LINE}'; document.querySelector('#stop')?.remove(); return document.visibilityState; })()`,
  );

  const event = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events')");
    return stored["guardian:monitoring-history:events"]?.events?.find(
      (candidate) => candidate.conversationId === CONVERSATION_ID && candidate.type === "TASK_COMPLETE",
    ) ?? false;
  }, "TASK_COMPLETE event while the monitored tab remains hidden", 6_000);

  const updatedSession = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
  const observation = updatedSession["guardian:session-registry:runtime"]?.sessions?.find(
    (candidate) => candidate.conversationId === CONVERSATION_ID,
  )?.observation;
  if (observation?.latestAssistant?.normalizedText !== `Task done.\n${STATUS_LINE}`) {
    throw new Error(`Hidden observation lost the terminal status boundary: ${JSON.stringify(observation?.latestAssistant?.normalizedText)}`);
  }

  const tabAfter = await evaluate(
    queryPage,
    `chrome.tabs.get(${tab.id}).then((item) => ({active:item.active,discarded:item.discarded,frozen:item.frozen,autoDiscardable:item.autoDiscardable}))`,
  );
  if (tabAfter.active !== false || tabAfter.discarded !== false || tabAfter.frozen !== false || tabAfter.autoDiscardable !== false) {
    throw new Error(`Unexpected monitored-tab lifecycle state: ${JSON.stringify(tabAfter)}`);
  }

  const notifications = await evaluate(queryPage, "chrome.notifications.getAll()");
  if (notifications[event.id] !== true) throw new Error("TASK_COMPLETE browser notification was not created while the tab was hidden.");

  console.log(`Background-tab monitoring passed in real Chromium: ${event.type}, notification=${event.id}`);
} finally {
  for (const client of [queryPage, chatPage, settingsPage]) {
    try { client?.close(); } catch { /* ignore cleanup */ }
  }
  try { await secondBrowser?.stop(); } catch { /* ignore cleanup */ }
  try { await firstBrowser?.stop(); } catch { /* ignore cleanup */ }
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(profilePath, { recursive: true, force: true });
  await rm(certificatePath, { recursive: true, force: true });
}
