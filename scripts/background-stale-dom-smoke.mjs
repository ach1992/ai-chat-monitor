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

const CONVERSATION_ID = "stale-dom-smoke-chat";
const TEST_HTML = `<!doctype html>
<meta charset="utf-8">
<title>AI Chat Monitor response-episode smoke</title>
<div id="conversation">
  <div data-message-author-role="user" data-message-id="user-old">Previous request.</div>
  <article><div data-message-author-role="assistant" data-message-id="assistant-old" id="assistant-old">Previous response complete.
AI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}</div></article>
</div>
<div id="prompt-textarea" data-testid="composer" contenteditable="true">New request.</div>`;

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
if (browser === undefined) throw new Error("Chrome for Testing/Chromium was not found. Set CHROME_BIN to run the stale-DOM smoke test.");
const xvfbRun = findOnPath("xvfb-run");
if (process.platform !== "win32" && xvfbRun === undefined) throw new Error("xvfb-run is required for the stale-DOM smoke test on Linux.");

const profilePath = await mkdtemp(resolve(tmpdir(), "ai-chat-monitor-stale-dom-profile-"));
const certificatePath = await mkdtemp(resolve(tmpdir(), "ai-chat-monitor-stale-dom-cert-"));
const keyPath = resolve(certificatePath, "key.pem");
const certPath = resolve(certificatePath, "cert.pem");
const openssl = findOnPath("openssl");
if (openssl === undefined) throw new Error("openssl is required for the stale-DOM smoke test.");
const certificate = spawnSync(openssl, [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath,
  "-subj", "/CN=chatgpt.com", "-days", "1",
], { stdio: "ignore" });
if (certificate.status !== 0) throw new Error("Unable to create the stale-DOM smoke certificate.");

const server = createServer(
  { key: await readFile(keyPath), cert: await readFile(certPath) },
  (request, response) => {
    const path = request.url ?? "/";
    if (path.startsWith("/backend-api/f/conversation")) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write('data: {"type":"message","status":"streaming"}\n\n');
      setTimeout(() => {
        response.write("data: [DONE]\n\n");
        response.end();
      }, 250);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(TEST_HTML);
  },
);
await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Unable to resolve the stale-DOM smoke server port.");

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
  const debugPort = 13_000 + (process.pid % 15_000) + launchSequence;
  const browserArgs = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
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
  if ((typeof process.getuid === "function" && process.getuid() === 0) || process.env.CI === "true") browserArgs.unshift("--no-sandbox");
  const command = xvfbRun ?? browser;
  const args = xvfbRun === undefined ? browserArgs : ["-a", browser, ...browserArgs];
  const detached = process.platform !== "win32";
  const stderrChunks = [];
  const child = spawn(command, args, { detached, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const json = async (path) => {
    if (child.exitCode !== null) throw new Error(`browser exited with code ${child.exitCode}: ${Buffer.concat(stderrChunks).toString("utf8").split("\n").slice(-20).join("\n")}`);
    const response = await fetch(`http://127.0.0.1:${debugPort}${path}`);
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
    async stop() {
      try { await browserClient.send("Browser.close"); } catch { /* already closed */ }
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
  client.targetId = target.targetId;
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
      browserEvents: ["RESPONSE_COMPLETE"],
      soundEvents: [],
      stallThresholdMs: 300_000,
      suppressLowPriorityWhileFocused: false,
    },
    chats: [{
      conversationId: CONVERSATION_ID,
      enabled: true,
      browserEvents: ["RESPONSE_COMPLETE"],
      soundEvents: [],
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
  await waitFor(async () => (await evaluate(chatPage, "document.readyState")) === "complete", "synthetic stale-DOM ChatGPT page");
  queryPage = await createPage(secondBrowser, `chrome-extension://${secondBrowser.extensionId}/sidepanel/index.html`);
  await secondBrowser.browserClient.send("Target.activateTarget", { targetId: chatPage.targetId });
  await waitFor(async () => (await evaluate(chatPage, "document.visibilityState")) === "visible", "visible stale-DOM monitored tab");

  const tab = await waitFor(async () => {
    const tabs = await evaluate(queryPage, "chrome.tabs.query({}).then((items) => items.map((item) => ({id:item.id,url:item.url,active:item.active,discarded:item.discarded,frozen:item.frozen,autoDiscardable:item.autoDiscardable})))");
    return tabs.find((candidate) => candidate.url?.includes(`/c/${CONVERSATION_ID}`)) ?? false;
  }, "stale-DOM ChatGPT tab");

  await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.generation === "IDLE" && session?.observation?.latestAssistant?.domMessageId === "assistant-old" ? session : false;
  }, "initial completed assistant observation");

  await waitFor(async () => {
    const current = await evaluate(queryPage, `chrome.tabs.get(${tab.id}).then((item) => ({autoDiscardable:item.autoDiscardable}))`);
    return current.autoDiscardable === false;
  }, "stale-DOM automatic-discard protection");

  await evaluate(queryPage, `chrome.runtime.sendMessage({type:'panel:history-clear',protocolVersion:2})`);
  await evaluate(chatPage, "document.querySelector('#prompt-textarea')?.focus(); true");
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

  const episode = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.pendingResponse?.baselineAssistantDomMessageId === "assistant-old" ? session.pendingResponse : false;
  }, "manual-send response episode boundary");

  await sleep(250);
  const eventsAfterSend = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  if (eventsAfterSend.some((candidate) => candidate.at >= episode.startedAt)) {
    throw new Error(`MANUAL_SEND reprocessed the previous assistant into a fresh event: ${JSON.stringify(eventsAfterSend)}`);
  }

  await evaluate(chatPage, `(() => {
    const conversation = document.querySelector('#conversation');
    const user = document.createElement('div');
    user.setAttribute('data-message-author-role', 'user');
    user.setAttribute('data-message-id', 'user-new');
    user.textContent = 'New request.';
    conversation?.append(user);
  })()`);
  await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.latestAssistant === undefined ? session : false;
  }, "new user turn outranking the previous assistant");

  await evaluate(chatPage, `(() => {
    const conversation = document.querySelector('#conversation');
    const article = document.createElement('article');
    const assistant = document.createElement('div');
    assistant.id = 'assistant-new';
    assistant.setAttribute('data-message-author-role', 'assistant');
    assistant.setAttribute('data-message-id', 'assistant-new');
    assistant.textContent = '...';
    article.append(assistant);
    conversation?.append(article);
  })()`);
  await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.latestAssistant?.domMessageId === "assistant-new" && session?.observation?.generation === "IDLE" ? session : false;
  }, "fresh partial assistant with transient IDLE UI");

  await sleep(250);
  const eventsDuringPartial = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  if (eventsDuringPartial.some((candidate) => candidate.at >= episode.startedAt)) {
    throw new Error(`Partial fresh assistant emitted a premature completion event: ${JSON.stringify(eventsDuringPartial)}`);
  }

  await evaluate(chatPage, `(() => {
    const stop = document.createElement('button');
    stop.id = 'stop';
    stop.setAttribute('data-testid', 'stop-button');
    stop.textContent = 'Stop generating';
    document.body.append(stop);
  })()`);
  await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.generation === "GENERATING" && session?.observation?.latestAssistant?.domMessageId === "assistant-new" ? session : false;
  }, "current response generating observation");

  const blank = await secondBrowser.browserClient.send("Target.createTarget", { url: "about:blank" });
  await secondBrowser.browserClient.send("Target.activateTarget", { targetId: blank.targetId });
  await waitFor(async () => (await evaluate(chatPage, "document.visibilityState")) === "hidden", "hidden stale-DOM monitored tab");

  const fetchResult = await evaluate(
    chatPage,
    `fetch('/backend-api/f/conversation', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'}).then((response) => response.text()).then(() => ({done:true,visibility:document.visibilityState,assistant:document.querySelector('#assistant-new')?.textContent,stop:document.querySelector('#stop') !== null}))`,
  );
  if (fetchResult?.done !== true || fetchResult.visibility !== "hidden" || fetchResult.assistant !== "..." || fetchResult.stop !== true) {
    throw new Error(`Synthetic stream did not finish with the monitored DOM still stale and hidden: ${JSON.stringify(fetchResult)}`);
  }

  const event = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events')");
    return stored["guardian:monitoring-history:events"]?.events?.find(
      (candidate) => candidate.conversationId === CONVERSATION_ID && candidate.type === "RESPONSE_COMPLETE" && candidate.delivery?.browser === "DELIVERED",
    ) ?? false;
  }, "RESPONSE_COMPLETE from hidden transport while rendered DOM stays stale", 6_000);

  const sessionState = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
  const session = sessionState["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
  const observation = session?.observation;
  const diagnostic = session?.hiddenDiagnostic;
  if (observation?.latestAssistant?.normalizedText !== "..." || observation?.latestAssistant?.textLength !== 3) {
    throw new Error(`Transport completion incorrectly depended on a final assistant DOM: ${JSON.stringify(observation?.latestAssistant)}`);
  }
  if (observation?.responseCompletion?.visibility !== "hidden" || observation?.responseCompletion?.transport !== "CHATGPT_CONVERSATION_STREAM") {
    throw new Error(`Hidden response transport completion evidence was not retained: ${JSON.stringify(observation?.responseCompletion)}`);
  }
  if (observation?.generation !== "GENERATING" || observation?.stopControlPresent !== true) {
    throw new Error(`Stale generation UI did not remain intentionally unresolved: ${JSON.stringify({generation:observation?.generation,stop:observation?.stopControlPresent})}`);
  }
  if (diagnostic?.transportCompletedAt === undefined || diagnostic?.tabActivatedAt !== undefined || diagnostic?.visibleObservedAt !== undefined) {
    throw new Error(`Diagnostic did not prove transport completion before activation: ${JSON.stringify(diagnostic)}`);
  }
  if (event.delivery?.browserAt === undefined || event.delivery.browserAt < event.at) {
    throw new Error(`Browser delivery timing is incomplete: ${JSON.stringify(event.delivery)}`);
  }
  if (await evaluate(chatPage, "document.visibilityState") !== "hidden") {
    throw new Error("Stale-DOM monitored tab was activated before the notification completed.");
  }
  if (await evaluate(chatPage, "document.querySelector('#assistant-new')?.textContent") !== "...") {
    throw new Error("Stale-DOM smoke accidentally installed final assistant content.");
  }

  console.log(`Stale-DOM background monitoring passed: ${event.type}, browser=${event.delivery.browser}, transportAt=${diagnostic.transportCompletedAt}, browserAt=${event.delivery.browserAt}`);
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
