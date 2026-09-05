(() => {
  const CHANNEL = "AI_CHAT_MONITOR_NETWORK_DIAGNOSTIC_V1";
  const MAX_EPISODE_MS = 180_000;
  const MAX_PATH_CHARS = 240;
  const MAX_CONTENT_TYPE_CHARS = 160;
  const MAX_SERVER_STATUS_CHARS = 80;

  type DiagnosticKind =
    | "EPISODE_ARMED"
    | "FETCH_RESPONSE"
    | "FETCH_ERROR"
    | "LIFECYCLE_STATUS";

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
