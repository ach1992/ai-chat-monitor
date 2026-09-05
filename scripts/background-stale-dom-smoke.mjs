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
<title>AI Chat Monitor response lifecycle smoke</title>
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
if (browser === undefined) throw new Error("Chrome for Testing/Chromium was not found. Set CHROME_BIN to run the response-lifecycle smoke test.");
const xvfbRun = findOnPath("xvfb-run");
if (process.platform !== "win32" && xvfbRun === undefined) throw new Error("xvfb-run is required for the response-lifecycle smoke test on Linux.");

const profilePath = await mkdtemp(resolve(tmpdir(), "ai-chat-monitor-response-lifecycle-profile-"));
const certificatePath = await mkdtemp(resolve(tmpdir(), "ai-chat-monitor-response-lifecycle-cert-"));
const keyPath = resolve(certificatePath, "key.pem");
const certPath = resolve(certificatePath, "cert.pem");
const openssl = findOnPath("openssl");
if (openssl === undefined) throw new Error("openssl is required for the response-lifecycle smoke test.");
const certificate = spawnSync(openssl, [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath,
  "-subj", "/CN=chatgpt.com", "-days", "1",
], { stdio: "ignore" });
if (certificate.status !== 0) throw new Error("Unable to create the response-lifecycle smoke certificate.");

let statusMarkerWrittenAt;
let statusDoneWrittenAt;

const server = createServer(
  { key: await readFile(keyPath), cert: await readFile(certPath) },
  (request, response) => {
    const rawPath = request.url ?? "/";
    const url = new URL(rawPath, "https://chatgpt.com");
    if (url.pathname === "/backend-api/f/conversation" && url.searchParams.get("probe") === "json") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end('{"ok":true,"kind":"not-a-response-stream"}');
      return;
    }
    if (url.pathname === "/backend-api/f/conversation") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write('data: {"type":"message","status":"streaming"}\n\n');
      const mode = url.searchParams.get("mode") ?? "generic";
      if (mode === "status") {
        setTimeout(() => {
          statusMarkerWrittenAt = Date.now();
          response.write('data: {"type":"message","text":"done\\nAI_CHAT_MONITOR_STATUS={\\"decision\\":\\"COMPLETE\\"}"}\n\n');
        }, 400);
      }
      setTimeout(() => {
        if (mode === "status") statusDoneWrittenAt = Date.now();
        response.write("data: [DONE]\n\n");
        response.end();
      }, 1_200);
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
if (address === null || typeof address === "string") throw new Error("Unable to resolve the response-lifecycle smoke server port.");

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
      browserEvents: ["RESPONSE_COMPLETE", "TASK_COMPLETE"],
      soundEvents: [],
      stallThresholdMs: 300_000,
      suppressLowPriorityWhileFocused: false,
    },
    chats: [{
      conversationId: CONVERSATION_ID,
      enabled: true,
      browserEvents: ["RESPONSE_COMPLETE", "TASK_COMPLETE"],
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
  await waitFor(async () => (await evaluate(chatPage, "document.readyState")) === "complete", "synthetic response-lifecycle ChatGPT page");
  queryPage = await createPage(secondBrowser, `chrome-extension://${secondBrowser.extensionId}/sidepanel/index.html`);
  await secondBrowser.browserClient.send("Target.activateTarget", { targetId: chatPage.targetId });
  await waitFor(async () => (await evaluate(chatPage, "document.visibilityState")) === "visible", "visible monitored tab");

  const tab = await waitFor(async () => {
    const tabs = await evaluate(queryPage, "chrome.tabs.query({}).then((items) => items.map((item) => ({id:item.id,url:item.url,active:item.active,discarded:item.discarded,frozen:item.frozen,autoDiscardable:item.autoDiscardable})))");
    return tabs.find((candidate) => candidate.url?.includes(`/c/${CONVERSATION_ID}`)) ?? false;
  }, "response-lifecycle ChatGPT tab");

  await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.generation === "IDLE" && session?.observation?.latestAssistant?.domMessageId === "assistant-old" ? session : false;
  }, "initial completed assistant observation");

  await waitFor(async () => {
    const current = await evaluate(queryPage, `chrome.tabs.get(${tab.id}).then((item) => ({autoDiscardable:item.autoDiscardable}))`);
    return current.autoDiscardable === false;
  }, "automatic-discard protection");

  await evaluate(queryPage, "chrome.runtime.sendMessage({type:'panel:history-clear',protocolVersion:2})");
  await evaluate(chatPage, "document.querySelector('#prompt-textarea')?.focus(); true");
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

  const episode = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.pendingResponse?.baselineAssistantDomMessageId === "assistant-old" ? session.pendingResponse : false;
  }, "manual-send response episode boundary");

  const blank = await secondBrowser.browserClient.send("Target.createTarget", { url: "about:blank" });
  await secondBrowser.browserClient.send("Target.activateTarget", { targetId: blank.targetId });
  await waitFor(async () => (await evaluate(chatPage, "document.visibilityState")) === "hidden", "hidden monitored tab");

  const probe = await evaluate(
    chatPage,
    "fetch('/backend-api/f/conversation?probe=json', {method:'POST', headers:{'content-type':'application/json'}, body:'{}'}).then((response) => response.json())",
  );
  if (probe?.ok !== true) throw new Error(`Synthetic non-SSE probe failed: ${JSON.stringify(probe)}`);
  await sleep(250);

  const eventsAfterProbe = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  if (eventsAfterProbe.some((candidate) => candidate.at >= episode.startedAt)) {
    throw new Error(`Non-SSE probe or MANUAL_SEND produced a premature event: ${JSON.stringify(eventsAfterProbe)}`);
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
  }, "new user turn outranking previous assistant");

  await evaluate(chatPage, `(() => {
    const conversation = document.querySelector('#conversation');
    const article = document.createElement('article');
    const assistant = document.createElement('div');
    assistant.id = 'assistant-new';
    assistant.setAttribute('data-message-author-role', 'assistant');
    assistant.setAttribute('data-message-id', 'assistant-new');
    assistant.textContent = 'partial';
    article.append(assistant);
    conversation?.append(article);
  })()`);

  const partialSession = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.latestAssistant?.domMessageId === "assistant-new" &&
      session?.observation?.latestAssistant?.normalizedText === "partial" &&
      session?.observation?.generation === "GENERATING" &&
      session?.observation?.stopControlPresent === false ? session : false;
  }, "hidden partial assistant held as generating without Stop control");
  if (partialSession.observation.responseCompletion !== undefined) {
    throw new Error(`Partial hidden assistant carried completion evidence: ${JSON.stringify(partialSession.observation.responseCompletion)}`);
  }
  const eventsDuringPartial = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  if (eventsDuringPartial.some((candidate) => candidate.at >= episode.startedAt)) {
    throw new Error(`Hidden transient IDLE/partial assistant produced a premature semantic/completion event: ${JSON.stringify(eventsDuringPartial)}`);
  }

  await evaluate(chatPage, `(() => {
    globalThis.__rev10GenericFetch = fetch('/backend-api/f/conversation?mode=generic', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:'{}'
    }).then((response) => response.text()).then((text) => ({done:true,text,visibility:document.visibilityState}));
    return true;
  })()`);

  await evaluate(chatPage, "document.querySelector('#assistant-new').textContent = 'partial response still streaming'; true");
  const streamingSession = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.latestAssistant?.normalizedText === "partial response still streaming" &&
      session?.observation?.generation === "GENERATING" &&
      session?.observation?.stopControlPresent === false ? session : false;
  }, "changing hidden assistant remaining generating before page-stream DONE");
  if (streamingSession.observation.responseCompletion !== undefined || streamingSession.observation.responseTerminalStatus !== undefined) {
    throw new Error(`Open response stream carried premature completion evidence: ${JSON.stringify(streamingSession.observation)}`);
  }

  const eventsWhileGenericOpen = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  if (eventsWhileGenericOpen.some((candidate) => candidate.at >= episode.startedAt)) {
    throw new Error(`Open response stream produced a premature event: ${JSON.stringify(eventsWhileGenericOpen)}`);
  }

  const genericFetchResult = await evaluate(chatPage, "globalThis.__rev10GenericFetch");
  if (genericFetchResult?.done !== true || genericFetchResult.visibility !== "hidden" || !String(genericFetchResult.text).includes("[DONE]")) {
    throw new Error(`Synthetic generic SSE did not finish while hidden: ${JSON.stringify(genericFetchResult)}`);
  }

  const genericEvent = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events')");
    return stored["guardian:monitoring-history:events"]?.events?.find(
      (candidate) => candidate.conversationId === CONVERSATION_ID && candidate.type === "RESPONSE_COMPLETE" && candidate.delivery?.browser === "DELIVERED",
    ) ?? false;
  }, "one delivered RESPONSE_COMPLETE after actual page-stream DONE", 6_000);

  const genericEvents = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  const genericDelivered = genericEvents.filter((candidate) =>
    candidate.conversationId === CONVERSATION_ID &&
    candidate.at >= episode.startedAt &&
    (candidate.delivery?.browser === "DELIVERED" || candidate.delivery?.sound === "DELIVERED" || candidate.delivery?.telegram === "DELIVERED"),
  );
  if (genericDelivered.length !== 1 || genericDelivered[0].id !== genericEvent.id) {
    throw new Error(`Generic response emitted duplicate notification delivery: ${JSON.stringify(genericEvents)}`);
  }

  const genericSessionState = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
  const genericSession = genericSessionState["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
  if (genericSession?.observation?.latestAssistant?.normalizedText !== "partial response still streaming") {
    throw new Error(`Generic completion unexpectedly depended on final DOM text: ${JSON.stringify(genericSession?.observation?.latestAssistant)}`);
  }
  if (genericSession?.observation?.responseCompletion?.visibility !== "hidden") {
    throw new Error(`Generic page-stream DONE evidence was not retained: ${JSON.stringify(genericSession?.observation?.responseCompletion)}`);
  }
  if (genericSession?.observation?.responseTerminalStatus !== undefined) {
    throw new Error(`Generic response unexpectedly carried terminal semantic evidence: ${JSON.stringify(genericSession.observation.responseTerminalStatus)}`);
  }
  if (genericSession?.hiddenDiagnostic?.transportCompletedAt === undefined) {
    throw new Error(`Generic completion diagnostic was not retained: ${JSON.stringify(genericSession?.hiddenDiagnostic)}`);
  }

  await evaluate(queryPage, "chrome.runtime.sendMessage({type:'panel:history-clear',protocolVersion:2})");
  await evaluate(chatPage, "document.querySelector('#prompt-textarea')?.focus(); true");
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

  const episode2 = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.pendingResponse?.startedAt > episode.startedAt ? session.pendingResponse : false;
  }, "second manual-send response episode boundary");

  await evaluate(chatPage, `(() => {
    globalThis.__rev10StatusFetch = fetch('/backend-api/f/conversation?mode=status', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:'{}'
    }).then((response) => response.text()).then((text) => ({done:true,text,visibility:document.visibilityState}));
    return true;
  })()`);

  await waitFor(
    () => statusMarkerWrittenAt !== undefined && statusDoneWrittenAt === undefined,
    "terminal marker written while response stream is still open",
    1_000,
  );
  const statusEventsBeforeDone = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  if (statusEventsBeforeDone.some((candidate) => candidate.at >= episode2.startedAt)) {
    throw new Error(`Status response notified before actual SSE DONE: ${JSON.stringify(statusEventsBeforeDone)}`);
  }

  const statusFetchResult = await evaluate(chatPage, "globalThis.__rev10StatusFetch");
  if (statusFetchResult?.done !== true || statusFetchResult.visibility !== "hidden" || !String(statusFetchResult.text).includes("AI_CHAT_MONITOR_STATUS")) {
    throw new Error(`Synthetic status SSE did not finish while hidden: ${JSON.stringify(statusFetchResult)}`);
  }

  const statusEvent = await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events')");
    return stored["guardian:monitoring-history:events"]?.events?.find(
      (candidate) => candidate.conversationId === CONVERSATION_ID && candidate.at >= episode2.startedAt && candidate.type === "TASK_COMPLETE" && candidate.delivery?.browser === "DELIVERED",
    ) ?? false;
  }, "one delivered TASK_COMPLETE from terminal page-stream status", 6_000);

  const statusEvents = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  const statusDelivered = statusEvents.filter((candidate) =>
    candidate.conversationId === CONVERSATION_ID &&
    candidate.at >= episode2.startedAt &&
    (candidate.delivery?.browser === "DELIVERED" || candidate.delivery?.sound === "DELIVERED" || candidate.delivery?.telegram === "DELIVERED"),
  );
  if (statusDelivered.length !== 1 || statusDelivered[0].id !== statusEvent.id) {
    throw new Error(`Terminal status emitted duplicate delivery: ${JSON.stringify(statusEvents)}`);
  }
  if (statusEvents.some((candidate) => candidate.at >= episode2.startedAt && candidate.type === "RESPONSE_COMPLETE")) {
    throw new Error(`Terminal status response incorrectly emitted generic RESPONSE_COMPLETE: ${JSON.stringify(statusEvents)}`);
  }

  const statusSessionState = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
  const statusSession = statusSessionState["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
  if (statusSession?.observation?.responseTerminalStatus?.decision !== "COMPLETE" || statusSession?.observation?.responseTerminalStatus?.visibility !== "hidden") {
    throw new Error(`Terminal status stream evidence was not retained: ${JSON.stringify(statusSession?.observation?.responseTerminalStatus)}`);
  }
  if (statusSession?.observation?.responseCompletion !== undefined) {
    throw new Error(`Terminal status stream also carried generic completion evidence: ${JSON.stringify(statusSession.observation.responseCompletion)}`);
  }

  const lateDomText = 'Final DOM response\nAI_CHAT_MONITOR_STATUS={"decision":"COMPLETE"}';
  await evaluate(chatPage, `document.querySelector('#assistant-new').textContent = ${JSON.stringify(lateDomText)}; true`);
  await waitFor(async () => {
    const stored = await evaluate(queryPage, "chrome.storage.session.get('guardian:session-registry:runtime')");
    const session = stored["guardian:session-registry:runtime"]?.sessions?.find((candidate) => candidate.conversationId === CONVERSATION_ID);
    return session?.observation?.latestAssistant?.normalizedText?.includes("AI_CHAT_MONITOR_STATUS") ? session : false;
  }, "late DOM terminal marker catch-up");
  await sleep(300);

  const afterDomCatchup = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  const deliveredAfterCatchup = afterDomCatchup.filter((candidate) =>
    candidate.conversationId === CONVERSATION_ID &&
    candidate.at >= episode2.startedAt &&
    (candidate.delivery?.browser === "DELIVERED" || candidate.delivery?.sound === "DELIVERED" || candidate.delivery?.telegram === "DELIVERED"),
  );
  if (deliveredAfterCatchup.length !== 1 || deliveredAfterCatchup[0].id !== statusEvent.id) {
    throw new Error(`Late DOM marker produced duplicate semantic delivery: ${JSON.stringify(afterDomCatchup)}`);
  }

  if (await evaluate(chatPage, "document.visibilityState") !== "hidden") {
    throw new Error("Monitored tab was activated before both background outcomes completed.");
  }
  await secondBrowser.browserClient.send("Target.activateTarget", { targetId: chatPage.targetId });
  await waitFor(async () => (await evaluate(chatPage, "document.visibilityState")) === "visible", "foreground after background outcomes");
  await sleep(300);
  const afterForeground = await evaluate(queryPage, "chrome.storage.local.get('guardian:monitoring-history:events').then((stored) => stored['guardian:monitoring-history:events']?.events ?? [])");
  const deliveredAfterForeground = afterForeground.filter((candidate) =>
    candidate.conversationId === CONVERSATION_ID &&
    candidate.at >= episode2.startedAt &&
    (candidate.delivery?.browser === "DELIVERED" || candidate.delivery?.sound === "DELIVERED" || candidate.delivery?.telegram === "DELIVERED"),
  );
  if (deliveredAfterForeground.length !== 1 || deliveredAfterForeground[0].id !== statusEvent.id) {
    throw new Error(`Foreground reconciliation produced duplicate delivery: ${JSON.stringify(afterForeground)}`);
  }

  await evaluate(chatPage, `(() => {
    globalThis.__rev10ArmsAfterDisable = [];
    window.addEventListener('message', (event) => {
      if (event?.data?.channel === 'AI_CHAT_MONITOR_PAGE_STREAM_V1' && event.data.type === 'stream-armed') {
        globalThis.__rev10ArmsAfterDisable.push(event.data.episodeStartedAt);
      }
    });
    return true;
  })()`);
  const disabled = await evaluate(queryPage, `chrome.tabs.sendMessage(${tab.id}, {
    type:'background:monitoring-state',
    protocolVersion:2,
    enabled:false
  }, {documentId:${JSON.stringify(statusSession.documentId)}})`);
  if (disabled?.type !== 'content:monitoring-state-ack') {
    throw new Error(`Unable to disable the content observer for gating regression: ${JSON.stringify(disabled)}`);
  }
  await evaluate(chatPage, "document.querySelector('#prompt-textarea')?.focus(); true");
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await chatPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(200);
  const armsAfterDisable = await evaluate(chatPage, "globalThis.__rev10ArmsAfterDisable");
  if (!Array.isArray(armsAfterDisable) || armsAfterDisable.length !== 0) {
    throw new Error(`Monitoring-off chat still armed the MAIN response observer: ${JSON.stringify(armsAfterDisable)}`);
  }

  console.log(`Rev10 page-stream priority passed: generic=${genericEvent.type}, semantic=${statusEvent.type}, no duplicate after DOM/foreground catch-up, monitoring-off observer stayed disarmed`);
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
