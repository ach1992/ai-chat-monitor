interface ResponseStreamRecord {
  requestId: string;
  tabId: number;
  documentId: string;
  startedAt: number;
}

interface ResponseStreamState {
  version: 1;
  requests: ResponseStreamRecord[];
}

const RESPONSE_STREAM_STORAGE_KEY = "guardian:response-transport:inflight";
const MAX_INFLIGHT_STREAMS = 24;
const CHATGPT_STREAM_PATHS = new Set([
  "/backend-api/f/conversation",
  "/backend-api/f/conversation/resume",
  "/backend-api/conversation",
  "/backend-anon/f/conversation",
]);
const RESPONSE_STREAM_FILTER: chrome.webRequest.RequestFilter = {
  urls: [
    "https://chatgpt.com/backend-api/f/conversation*",
    "https://chatgpt.com/backend-api/f/conversation/resume*",
    "https://chatgpt.com/backend-api/conversation*",
    "https://chatgpt.com/backend-anon/f/conversation*",
    "https://chat.openai.com/backend-api/f/conversation*",
    "https://chat.openai.com/backend-api/f/conversation/resume*",
    "https://chat.openai.com/backend-api/conversation*",
    "https://chat.openai.com/backend-anon/f/conversation*",
  ],
  types: ["xmlhttprequest"],
};

let stateQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validStreamRecord(value: unknown): value is ResponseStreamRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.requestId === "string" && value.requestId.length > 0 &&
    Number.isInteger(value.tabId) && (value.tabId as number) >= 0 &&
    typeof value.documentId === "string" && value.documentId.length > 0 &&
    typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt > 0
  );
}

async function loadState(): Promise<ResponseStreamState> {
  const stored = await chrome.storage.session.get(RESPONSE_STREAM_STORAGE_KEY);
  const value = stored[RESPONSE_STREAM_STORAGE_KEY];
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.requests)) {
    return { version: 1, requests: [] };
  }
  return {
    version: 1,
    requests: value.requests.filter(validStreamRecord).slice(-MAX_INFLIGHT_STREAMS),
  };
}

async function saveState(state: ResponseStreamState): Promise<void> {
  await chrome.storage.session.set({
    [RESPONSE_STREAM_STORAGE_KEY]: {
      version: 1,
      requests: state.requests.slice(-MAX_INFLIGHT_STREAMS),
    },
  });
}

function enqueueState(operation: () => Promise<void>): void {
  const run = stateQueue.then(operation, operation);
  stateQueue = run.catch(() => undefined);
}

function eventAt(timeStamp: number): number {
  return Number.isFinite(timeStamp) && timeStamp > 0 ? Math.round(timeStamp) : Date.now();
}

function supportedStreamUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
      CHATGPT_STREAM_PATHS.has(url.pathname)
    );
  } catch {
    return false;
  }
}

function responseContentType(headers: chrome.webRequest.HttpHeader[] | undefined): string | undefined {
  const header = headers?.find((candidate) => candidate.name.toLowerCase() === "content-type");
  return typeof header?.value === "string" ? header.value.toLowerCase() : undefined;
}

function eligibleStreamStart(details: chrome.webRequest.OnResponseStartedDetails): details is chrome.webRequest.OnResponseStartedDetails & { documentId: string } {
  const contentType = responseContentType(details.responseHeaders);
  return (
    details.tabId >= 0 &&
    details.frameId === 0 &&
    typeof details.documentId === "string" && details.documentId.length > 0 &&
    details.method.toUpperCase() === "POST" &&
    details.statusCode >= 200 && details.statusCode < 300 &&
    supportedStreamUrl(details.url) &&
    contentType !== undefined && contentType.startsWith("text/event-stream")
  );
}

async function sendToDocument(record: ResponseStreamRecord, message: Record<string, unknown>): Promise<void> {
  try {
    await chrome.tabs.sendMessage(record.tabId, message, { documentId: record.documentId });
  } catch {
    // Navigation/removal races are expected. Exact document identity prevents cross-turn delivery.
  }
}

chrome.webRequest.onResponseStarted.addListener((details) => {
  if (!eligibleStreamStart(details)) return;
  const record: ResponseStreamRecord = {
    requestId: details.requestId,
    tabId: details.tabId,
    documentId: details.documentId,
    startedAt: eventAt(details.timeStamp),
  };
  enqueueState(async () => {
    const state = await loadState();
    state.requests = [
      ...state.requests.filter((candidate) => candidate.requestId !== record.requestId),
      record,
    ].slice(-MAX_INFLIGHT_STREAMS);
    await saveState(state);
    await sendToDocument(record, {
      type: "background:response-stream-started",
      protocolVersion: 2,
      requestId: record.requestId,
      startedAt: record.startedAt,
    });
  });
}, RESPONSE_STREAM_FILTER, ["responseHeaders"]);

chrome.webRequest.onCompleted.addListener((details) => {
  enqueueState(async () => {
    const state = await loadState();
    const record = state.requests.find((candidate) => candidate.requestId === details.requestId);
    if (record === undefined) return;
    if (
      details.tabId !== record.tabId ||
      (details.documentId !== undefined && details.documentId !== record.documentId)
    ) {
      return;
    }
    state.requests = state.requests.filter((candidate) => candidate.requestId !== details.requestId);
    await saveState(state);
    await sendToDocument(record, {
      type: "background:response-stream-completed",
      protocolVersion: 2,
      requestId: record.requestId,
      startedAt: record.startedAt,
      completedAt: eventAt(details.timeStamp),
    });
  });
}, RESPONSE_STREAM_FILTER);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  enqueueState(async () => {
    const state = await loadState();
    const record = state.requests.find((candidate) => candidate.requestId === details.requestId);
    if (record === undefined) return;
    state.requests = state.requests.filter((candidate) => candidate.requestId !== details.requestId);
    await saveState(state);
    await sendToDocument(record, {
      type: "background:response-stream-aborted",
      protocolVersion: 2,
      requestId: record.requestId,
      startedAt: record.startedAt,
    });
  });
}, RESPONSE_STREAM_FILTER);
