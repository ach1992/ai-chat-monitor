(() => {
  const CHANNEL = "AI_CHAT_MONITOR_NETWORK_DIAGNOSTIC_V1";
  const MAX_EPISODE_MS = 180_000;
  const SNAPSHOT_INTERVAL_MS = 5_000;
  const MAX_IDS = 8;
  const MAX_PATH_CHARS = 240;
  const MAX_CONTENT_TYPE_CHARS = 160;

  type DiagnosticKind =
    | "EPISODE_ARMED"
    | "FETCH_RESPONSE"
    | "FETCH_ERROR"
    | "STREAM_SNAPSHOT"
    | "STREAM_DONE"
    | "STREAM_END"
    | "STREAM_ERROR";

  interface ControlMessage {
    channel: typeof CHANNEL;
    type: "control";
    protocolVersion: 1;
    enabled: boolean;
  }

  interface StreamState {
    episodeId: string;
    episodeStartedAt: number;
    streamId: string;
    requestOrdinal: number;
    requestStartedAt: number;
    responseAt: number;
    method: string;
    path: string;
    status: number;
    contentType: string;
    chunkCount: number;
    byteCount: number;
    eventCount: number;
    firstChunkAt?: number;
    lastChunkAt?: number;
    assistantMessageIds: string[];
    parentMessageIds: string[];
    conversationIds: string[];
    assistantTextLength?: number;
    doneSeen: boolean;
    markerDecision?: string;
    endedAt?: number;
    endReason?: "DONE" | "EOF" | "ERROR";
    lastSnapshotAt: number;
  }

  if (typeof window.fetch !== "function") return;
  const originalFetch = window.fetch.bind(window);
  let enabled = false;
  let episodeId: string | undefined;
  let episodeStartedAt: number | undefined;
  let requestOrdinal = 0;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isControlMessage(value: unknown): value is ControlMessage {
    return isRecord(value) &&
      value.channel === CHANNEL &&
      value.type === "control" &&
      value.protocolVersion === 1 &&
      typeof value.enabled === "boolean";
  }

  function boundedString(value: unknown, max: number): string | undefined {
    return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
  }

  function pushUnique(target: string[], value: unknown): void {
    const candidate = boundedString(value, 200);
    if (candidate === undefined || target.includes(candidate) || target.length >= MAX_IDS) return;
    target.push(candidate);
  }

  function post(kind: DiagnosticKind, details: Record<string, unknown> = {}): void {
    window.postMessage({
      channel: CHANNEL,
      type: "network-diagnostic",
      protocolVersion: 1,
      event: {
        kind,
        at: Date.now(),
        visibility: document.visibilityState,
        ...details,
      },
    }, location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || !isControlMessage(event.data)) return;
    enabled = event.data.enabled;
    if (!enabled) {
      episodeId = undefined;
      episodeStartedAt = undefined;
      requestOrdinal = 0;
    }
  });

  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'textarea[name="prompt-textarea"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '[contenteditable="true"][role="textbox"]',
  ] as const;
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
  ] as const;

  function matchesTarget(target: EventTarget | null, selectors: readonly string[]): boolean {
    if (!(target instanceof Element)) return false;
    return selectors.some((selector) => {
      try { return target.matches(selector) || target.closest(selector) !== null; } catch { return false; }
    });
  }

  function armFromTrustedSend(): void {
    if (!enabled) return;
    episodeStartedAt = Date.now();
    episodeId = crypto.randomUUID();
    requestOrdinal = 0;
    post("EPISODE_ARMED", { episodeId, episodeStartedAt });
  }

  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (matchesTarget(event.target, COMPOSER_SELECTORS)) armFromTrustedSend();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted || !matchesTarget(event.target, SEND_SELECTORS)) return;
    armFromTrustedSend();
  }, true);

  function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
    if (typeof init?.method === "string" && init.method.length > 0) return init.method.toUpperCase();
    if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
    return "GET";
  }

  function requestPath(input: RequestInfo | URL): string | undefined {
    try {
      const raw = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof Request !== "undefined" && input instanceof Request
            ? input.url
            : undefined;
      if (raw === undefined) return undefined;
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return undefined;
      if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return undefined;
      return url.pathname.slice(0, MAX_PATH_CHARS);
    } catch {
      return undefined;
    }
  }

  function textLikeLength(value: unknown): number {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce((sum, entry) => sum + textLikeLength(entry), 0);
    if (!isRecord(value)) return 0;
    if (typeof value.text === "string") return value.text.length;
    if (typeof value.value === "string") return value.value.length;
    return 0;
  }

  function assistantContentLength(message: Record<string, unknown>): number | undefined {
    const content = message.content;
    if (!isRecord(content)) return undefined;
    if (Array.isArray(content.parts)) return textLikeLength(content.parts);
    if (typeof content.text === "string") return content.text.length;
    return undefined;
  }

  function scanMessage(message: Record<string, unknown>, state: StreamState): void {
    const author = message.author;
    if (!isRecord(author) || author.role !== "assistant") return;
    pushUnique(state.assistantMessageIds, message.id);
    const length = assistantContentLength(message);
    if (length !== undefined) state.assistantTextLength = Math.max(state.assistantTextLength ?? 0, length);
  }

  function scanPayload(value: unknown, state: StreamState, depth = 0): void {
    if (depth > 7) return;
    if (Array.isArray(value)) {
      for (const entry of value) scanPayload(entry, state, depth + 1);
      return;
    }
    if (!isRecord(value)) return;

    pushUnique(state.conversationIds, value.conversation_id);
    pushUnique(state.parentMessageIds, value.parent_id);
    pushUnique(state.parentMessageIds, value.parent_message_id);
    scanMessage(value, state);

    for (const nested of Object.values(value)) {
      if (typeof nested === "object" && nested !== null) scanPayload(nested, state, depth + 1);
    }
  }

  function normalizeJsonEscapes(value: string): string {
    let normalized = value;
    for (let pass = 0; pass < 3; pass += 1) {
      normalized = normalized
        .replace(/\\u0022/gi, '"')
        .replace(/\\"/g, '"');
    }
    return normalized;
  }

  function markerDecisionFromTail(value: string): string | undefined {
    const normalized = normalizeJsonEscapes(value.slice(-8_192));
    return /AI_CHAT_MONITOR_STATUS=\{"decision":"([A-Z_]+)"\}/.exec(normalized)?.[1];
  }

  function stateDetails(state: StreamState): Record<string, unknown> {
    return {
      episodeId: state.episodeId,
      episodeStartedAt: state.episodeStartedAt,
      streamId: state.streamId,
      requestOrdinal: state.requestOrdinal,
      requestStartedAt: state.requestStartedAt,
      responseAt: state.responseAt,
      method: state.method,
      path: state.path,
      status: state.status,
      contentType: state.contentType,
      chunkCount: state.chunkCount,
      byteCount: state.byteCount,
      eventCount: state.eventCount,
      firstChunkAt: state.firstChunkAt,
      lastChunkAt: state.lastChunkAt,
      assistantMessageIds: [...state.assistantMessageIds],
      parentMessageIds: [...state.parentMessageIds],
      conversationIds: [...state.conversationIds],
      assistantTextLength: state.assistantTextLength,
      doneSeen: state.doneSeen,
      markerDecision: state.markerDecision,
      endedAt: state.endedAt,
      endReason: state.endReason,
    };
  }

  function snapshot(state: StreamState, kind: DiagnosticKind, force = false): void {
    const now = Date.now();
    if (!force && now - state.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    state.lastSnapshotAt = now;
    post(kind, stateDetails(state));
  }

  function processSseData(data: string, state: StreamState): boolean {
    state.eventCount += 1;
    if (data.trim() === "[DONE]") {
      state.doneSeen = true;
      state.endedAt = Date.now();
      state.endReason = "DONE";
      return true;
    }
    try { scanPayload(JSON.parse(data), state); } catch { /* non-JSON SSE metadata is diagnostic-noise only */ }
    return false;
  }

  async function observeSse(response: Response, state: StreamState): Promise<void> {
    try {
      const clone = response.clone();
      const reader = clone.body?.getReader();
      if (reader === undefined) return;
      const decoder = new TextDecoder();
      let buffer = "";
      let markerTail = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value === undefined) continue;
          const now = Date.now();
          state.chunkCount += 1;
          state.byteCount += chunk.value.byteLength;
          state.firstChunkAt ??= now;
          state.lastChunkAt = now;
          const decoded = decoder.decode(chunk.value, { stream: true });
          markerTail = (markerTail + decoded).slice(-16_384);
          const markerDecision = markerDecisionFromTail(markerTail);
          if (markerDecision !== undefined) state.markerDecision = markerDecision;
          buffer = (buffer + decoded).replace(/\r\n/g, "\n");

          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = rawEvent
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data.length > 0 && processSseData(data, state)) {
              snapshot(state, "STREAM_DONE", true);
              return;
            }
            boundary = buffer.indexOf("\n\n");
          }
          snapshot(state, "STREAM_SNAPSHOT");
        }

        state.endedAt = Date.now();
        state.endReason = "EOF";
        snapshot(state, "STREAM_END", true);
      } finally {
        try { reader.releaseLock(); } catch { /* stream already released */ }
      }
    } catch {
      state.endedAt = Date.now();
      state.endReason = "ERROR";
      snapshot(state, "STREAM_ERROR", true);
    }
  }

  const monitoredFetch: typeof window.fetch = async (...args) => {
    const startedAt = Date.now();
    const currentEpisodeId = episodeId;
    const currentEpisodeStartedAt = episodeStartedAt;
    const method = requestMethod(args[0], args[1]);
    const path = requestPath(args[0]);
    const eligible = enabled &&
      currentEpisodeId !== undefined &&
      currentEpisodeStartedAt !== undefined &&
      method === "POST" &&
      path !== undefined &&
      startedAt - currentEpisodeStartedAt <= MAX_EPISODE_MS;

    let response: Response;
    try {
      response = await originalFetch(...args);
    } catch (error) {
      if (eligible && currentEpisodeId !== undefined && currentEpisodeStartedAt !== undefined && path !== undefined) {
        post("FETCH_ERROR", {
          episodeId: currentEpisodeId,
          episodeStartedAt: currentEpisodeStartedAt,
          requestStartedAt: startedAt,
          method,
          path,
          errorName: error instanceof Error ? error.name.slice(0, 80) : "Error",
        });
      }
      throw error;
    }

    if (!eligible || currentEpisodeId === undefined || currentEpisodeStartedAt === undefined || path === undefined) return response;

    requestOrdinal += 1;
    const ordinal = requestOrdinal;
    const contentType = (response.headers.get("content-type") ?? "").slice(0, MAX_CONTENT_TYPE_CHARS);
    const state: StreamState = {
      episodeId: currentEpisodeId,
      episodeStartedAt: currentEpisodeStartedAt,
      streamId: `${currentEpisodeId}:${ordinal}`,
      requestOrdinal: ordinal,
      requestStartedAt: startedAt,
      responseAt: Date.now(),
      method,
      path,
      status: response.status,
      contentType,
      chunkCount: 0,
      byteCount: 0,
      eventCount: 0,
      assistantMessageIds: [],
      parentMessageIds: [],
      conversationIds: [],
      doneSeen: false,
      lastSnapshotAt: 0,
    };
    post("FETCH_RESPONSE", stateDetails(state));

    if (contentType.toLowerCase().includes("text/event-stream") && response.body !== null) {
      void observeSse(response, state);
    }
    return response;
  };

  window.fetch = monitoredFetch;
})();
