(() => {
  const CHANNEL = "AI_CHAT_MONITOR_NETWORK_DIAGNOSTIC_V1";
  const MAX_EPISODE_MS = 180_000;
  const MAX_PATH_CHARS = 240;
  const MAX_CONTENT_TYPE_CHARS = 160;
  const MAX_SERVER_STATUS_CHARS = 80;
  const MAX_SOCKET_HOST_CHARS = 160;
  const MAX_MARKER_DECISION_CHARS = 40;
  const MAX_WEBSOCKETS = 4;
  const WEBSOCKET_SNAPSHOT_INTERVAL_MS = 10_000;

  type DiagnosticKind =
    | "EPISODE_ARMED"
    | "FETCH_RESPONSE"
    | "FETCH_ERROR"
    | "LIFECYCLE_STATUS"
    | "WEBSOCKET_PRESENT"
    | "WEBSOCKET_ACTIVITY"
    | "WEBSOCKET_CLOSE"
    | "WEBSOCKET_ERROR";

  interface ControlMessage {
    channel: typeof CHANNEL;
    type: "control";
    protocolVersion: 1;
    enabled: boolean;
  }

  interface RequestState {
    episodeId: string;
    episodeStartedAt: number;
    requestId: string;
    requestOrdinal: number;
    requestStartedAt: number;
    responseAt: number;
    method: string;
    path: string;
    status: number;
    contentType: string;
  }

  interface WebSocketState {
    socketId: string;
    socketCreatedAt: number;
    socketHost: string;
    socketPath: string;
    messageCount: number;
    firstMessageAt?: number;
    lastMessageAt?: number;
    lastSnapshotAt?: number;
    frameKindReported: boolean;
    currentConversationSeen: boolean;
    markerDecision?: string;
  }

  if (typeof window.fetch !== "function") return;
  const originalFetch = window.fetch.bind(window);
  let enabled = false;
  let episodeId: string | undefined;
  let episodeStartedAt: number | undefined;
  let requestOrdinal = 0;
  let socketOrdinal = 0;
  const socketStates = new Map<WebSocket, WebSocketState>();

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

  function activeEpisode(): { episodeId: string; episodeStartedAt: number } | undefined {
    if (!enabled || episodeId === undefined || episodeStartedAt === undefined) return undefined;
    if (Date.now() - episodeStartedAt > MAX_EPISODE_MS) return undefined;
    return { episodeId, episodeStartedAt };
  }

  function webSocketDetails(socket: WebSocket, state: WebSocketState): Record<string, unknown> {
    const episode = activeEpisode();
    return {
      ...(episode === undefined ? {} : episode),
      socketId: state.socketId,
      socketCreatedAt: state.socketCreatedAt,
      socketHost: state.socketHost,
      socketPath: state.socketPath,
      readyState: socket.readyState,
      messageCount: state.messageCount,
      firstMessageAt: state.firstMessageAt,
      lastMessageAt: state.lastMessageAt,
    };
  }

  function snapshotWebSocket(socket: WebSocket, state: WebSocketState, force = false): void {
    if (activeEpisode() === undefined || state.messageCount === 0) return;
    const now = Date.now();
    if (!force && state.lastSnapshotAt !== undefined && now - state.lastSnapshotAt < WEBSOCKET_SNAPSHOT_INTERVAL_MS) return;
    state.lastSnapshotAt = now;
    post("WEBSOCKET_ACTIVITY", webSocketDetails(socket, state));
  }

  function snapshotAllWebSockets(force = false): void {
    for (const [socket, state] of socketStates) snapshotWebSocket(socket, state, force);
  }

  function resetWebSocketEpisode(): void {
    for (const [socket, state] of socketStates) {
      state.messageCount = 0;
      state.frameKindReported = false;
      state.currentConversationSeen = false;
      delete state.firstMessageAt;
      delete state.lastMessageAt;
      delete state.lastSnapshotAt;
      delete state.markerDecision;
      if (socket.readyState === 0 || socket.readyState === 1) {
        post("WEBSOCKET_PRESENT", webSocketDetails(socket, state));
      }
    }
  }

  function armFromTrustedSend(): void {
    if (!enabled) return;
    episodeStartedAt = Date.now();
    episodeId = crypto.randomUUID();
    requestOrdinal = 0;
    post("EPISODE_ARMED", { episodeId, episodeStartedAt });
    resetWebSocketEpisode();
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

  function currentConversationId(): string | undefined {
    try {
      const pathname = new URL(location.href).pathname;
      return /(?:^|\/)c\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
    } catch {
      return undefined;
    }
  }

  function isConversationRequestPath(path: string): boolean {
    return path === "/backend-api/f/conversation" ||
      path === "/backend-api/f/conversation/prepare" ||
      path === "/backend-api/f/conversation/resume";
  }

  function lifecyclePathKind(path: string): "STREAM_STATUS" | "CONVERSATION_DETAIL" | undefined {
    const conversationId = currentConversationId();
    if (conversationId === undefined) return undefined;
    if (path === `/backend-api/conversation/${conversationId}/stream_status`) return "STREAM_STATUS";
    if (path === `/backend-api/conversation/${conversationId}` ||
      path === `/backend-api/conversations/${conversationId}`) return "CONVERSATION_DETAIL";
    return undefined;
  }

  function stateDetails(state: RequestState): Record<string, unknown> {
    return {
      episodeId: state.episodeId,
      episodeStartedAt: state.episodeStartedAt,
      requestId: state.requestId,
      requestOrdinal: state.requestOrdinal,
      requestStartedAt: state.requestStartedAt,
      responseAt: state.responseAt,
      method: state.method,
      path: state.path,
      status: state.status,
      contentType: state.contentType,
    };
  }

  async function observeStreamStatus(response: Response, state: RequestState): Promise<void> {
    try {
      const payload: unknown = await response.clone().json();
      if (!isRecord(payload)) return;
      const serverStatus = boundedString(payload.status, MAX_SERVER_STATUS_CHARS) ??
        boundedString(payload.async_status, MAX_SERVER_STATUS_CHARS);
      post("LIFECYCLE_STATUS", {
        ...stateDetails(state),
        ...(serverStatus === undefined ? {} : { serverStatus }),
      });
    } catch {
      // The diagnostic never treats an unreadable status body as completion evidence.
    }
  }

  function webSocketEndpoint(rawUrl: unknown): { socketHost: string; socketPath: string } | undefined {
    try {
      const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl), location.href);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
      const hostname = url.hostname.toLowerCase();
      const trustedHost = hostname === "chatgpt.com" ||
        hostname.endsWith(".chatgpt.com") ||
        hostname === "openai.com" ||
        hostname.endsWith(".openai.com");
      if (!trustedHost) return undefined;
      return {
        socketHost: url.host.slice(0, MAX_SOCKET_HOST_CHARS),
        socketPath: url.pathname.slice(0, MAX_PATH_CHARS),
      };
    } catch {
      return undefined;
    }
  }

  function webSocketFrameKind(data: unknown): string {
    if (typeof data === "string") return "text";
    if (typeof Blob !== "undefined" && data instanceof Blob) return "blob";
    if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) return "arraybuffer";
    return "other";
  }

  function markerDecisionFromFrame(value: string): string | undefined {
    const match = /AI_CHAT_MONITOR_STATUS=\{\\?"decision\\?"\s*:\s*\\?"([A-Z_]{2,40})\\?"\}/.exec(value);
    return boundedString(match?.[1], MAX_MARKER_DECISION_CHARS);
  }

  function observeWebSocketFrame(socket: WebSocket, state: WebSocketState, event: MessageEvent): void {
    const episode = activeEpisode();
    if (episode === undefined) return;

    let data: unknown;
    try { data = event.data; } catch { return; }
    const frameKind = webSocketFrameKind(data);

    if (!state.frameKindReported) {
      state.frameKindReported = true;
      post("LIFECYCLE_STATUS", {
        ...webSocketDetails(socket, state),
        method: "WEBSOCKET",
        path: state.socketPath,
        contentType: `websocket/${frameKind}`,
        serverStatus: "FRAME_OBSERVED",
      });
    }

    if (typeof data !== "string") return;
    const conversationId = currentConversationId();
    if (conversationId === undefined || !data.includes(conversationId)) return;

    if (!state.currentConversationSeen) {
      state.currentConversationSeen = true;
      post("LIFECYCLE_STATUS", {
        ...webSocketDetails(socket, state),
        method: "WEBSOCKET",
        path: state.socketPath,
        contentType: "websocket/text",
        serverStatus: "CURRENT_CONVERSATION_FRAME",
      });
    }

    const markerDecision = markerDecisionFromFrame(data);
    if (markerDecision === undefined || state.markerDecision === markerDecision) return;
    state.markerDecision = markerDecision;
    post("LIFECYCLE_STATUS", {
      ...webSocketDetails(socket, state),
      method: "WEBSOCKET",
      path: state.socketPath,
      contentType: "websocket/text",
      serverStatus: `MARKER:${markerDecision}`,
    });
  }

  function registerWebSocket(socket: WebSocket, rawUrl: unknown): void {
    if (socketStates.size >= MAX_WEBSOCKETS) return;
    const endpoint = webSocketEndpoint(rawUrl);
    if (endpoint === undefined) return;

    socketOrdinal += 1;
    const state: WebSocketState = {
      socketId: `ws:${socketOrdinal}`,
      socketCreatedAt: Date.now(),
      socketHost: endpoint.socketHost,
      socketPath: endpoint.socketPath,
      messageCount: 0,
      frameKindReported: false,
      currentConversationSeen: false,
    };
    socketStates.set(socket, state);

    socket.addEventListener("open", () => {
      if (activeEpisode() !== undefined) post("WEBSOCKET_PRESENT", webSocketDetails(socket, state));
    });
    socket.addEventListener("message", (event) => {
      if (activeEpisode() === undefined) return;
      const now = Date.now();
      state.messageCount += 1;
      state.firstMessageAt ??= now;
      state.lastMessageAt = now;
      observeWebSocketFrame(socket, state, event);
      snapshotWebSocket(socket, state);
    });
    socket.addEventListener("close", () => {
      if (activeEpisode() !== undefined) {
        snapshotWebSocket(socket, state, true);
        post("WEBSOCKET_CLOSE", webSocketDetails(socket, state));
      }
      socketStates.delete(socket);
    });
    socket.addEventListener("error", () => {
      if (activeEpisode() !== undefined) post("WEBSOCKET_ERROR", webSocketDetails(socket, state));
    });
  }

  if (typeof window.WebSocket === "function") {
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        registerWebSocket(socket, args[0]);
        return socket;
      },
    });
  }

  const monitoredFetch: typeof window.fetch = async (...args) => {
    const startedAt = Date.now();
    const currentEpisodeId = episodeId;
    const currentEpisodeStartedAt = episodeStartedAt;
    const method = requestMethod(args[0], args[1]);
    const path = requestPath(args[0]);
    const lifecycleKind = path === undefined ? undefined : lifecyclePathKind(path);
    const eligible = enabled &&
      currentEpisodeId !== undefined &&
      currentEpisodeStartedAt !== undefined &&
      path !== undefined &&
      startedAt - currentEpisodeStartedAt <= MAX_EPISODE_MS &&
      ((method === "POST" && isConversationRequestPath(path)) ||
        (method === "GET" && lifecycleKind !== undefined));

    if (eligible && method === "POST" && path === "/backend-api/f/conversation/prepare") {
      snapshotAllWebSockets(true);
    }

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
    const state: RequestState = {
      episodeId: currentEpisodeId,
      episodeStartedAt: currentEpisodeStartedAt,
      requestId: `${currentEpisodeId}:${ordinal}`,
      requestOrdinal: ordinal,
      requestStartedAt: startedAt,
      responseAt: Date.now(),
      method,
      path,
      status: response.status,
      contentType,
    };
    post("FETCH_RESPONSE", stateDetails(state));

    if (lifecycleKind === "STREAM_STATUS" && contentType.toLowerCase().includes("application/json")) {
      void observeStreamStatus(response, state);
    }
    return response;
  };

  window.fetch = monitoredFetch;
})();
