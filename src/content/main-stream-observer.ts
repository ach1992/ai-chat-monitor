(() => {
  const CHANNEL = "AI_CHAT_MONITOR_PAGE_STREAM_V1";
  const MAX_TAIL_CHARS = 16_384;
  const TERMINAL_TAIL_CHARS = 4_096;
  const ARM_WINDOW_MS = 20_000;
  const TERMINAL_DECISIONS = [
    "CONTINUE",
    "HOLD_APPROVAL",
    "HOLD_DECISION",
    "HOLD_HUMAN_OPERATION",
    "COMPLETE",
    "PLATFORM_ERROR",
    "RATE_LIMIT",
    "UNSURE",
  ] as const;
  type TerminalDecision = (typeof TERMINAL_DECISIONS)[number];

  interface MonitoringStateMessage {
    channel: typeof CHANNEL;
    type: "monitoring-state";
    protocolVersion: 1;
    enabled: boolean;
  }

  interface DisarmMessage {
    channel: typeof CHANNEL;
    type: "disarm";
    protocolVersion: 1;
  }

  const terminalDecisionSet = new Set<string>(TERMINAL_DECISIONS);
  if (typeof window.fetch !== "function") return;
  const originalFetch = window.fetch.bind(window);

  let monitoringEnabled = false;
  let armedEpisodeStartedAt: number | undefined;
  let resolvedEpisodeStartedAt: number | undefined;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isMonitoringStateMessage(value: unknown): value is MonitoringStateMessage {
    return isRecord(value) &&
      value.channel === CHANNEL &&
      value.type === "monitoring-state" &&
      value.protocolVersion === 1 &&
      typeof value.enabled === "boolean";
  }

  function isDisarmMessage(value: unknown): value is DisarmMessage {
    return isRecord(value) &&
      value.channel === CHANNEL &&
      value.type === "disarm" &&
      value.protocolVersion === 1;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (isMonitoringStateMessage(event.data)) {
      monitoringEnabled = event.data.enabled;
      if (!monitoringEnabled) {
        armedEpisodeStartedAt = undefined;
        resolvedEpisodeStartedAt = undefined;
      }
      return;
    }
    if (isDisarmMessage(event.data)) {
      armedEpisodeStartedAt = undefined;
      resolvedEpisodeStartedAt = undefined;
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
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop streaming"]',
  ] as const;

  function matchesTarget(target: EventTarget | null, selectors: readonly string[]): boolean {
    if (!(target instanceof Element)) return false;
    return selectors.some((selector) => target.matches(selector) || target.closest(selector) !== null);
  }

  function armFromTrustedUserSend(): void {
    if (!monitoringEnabled) return;
    const episodeStartedAt = Date.now();
    armedEpisodeStartedAt = episodeStartedAt;
    resolvedEpisodeStartedAt = undefined;
    window.postMessage({
      channel: CHANNEL,
      type: "stream-armed",
      protocolVersion: 1,
      episodeStartedAt,
    }, location.origin);
  }

  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    if (matchesTarget(event.target, COMPOSER_SELECTORS)) armFromTrustedUserSend();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    if (matchesTarget(event.target, SEND_SELECTORS)) {
      armFromTrustedUserSend();
      return;
    }
    if (matchesTarget(event.target, STOP_SELECTORS)) {
      armedEpisodeStartedAt = undefined;
      resolvedEpisodeStartedAt = undefined;
    }
  }, true);

  function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
    if (typeof init?.method === "string" && init.method.length > 0) return init.method.toUpperCase();
    if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
    return "GET";
  }

  function requestUrl(input: RequestInfo | URL): string | undefined {
    try {
      if (typeof input === "string") return new URL(input, location.href).href;
      if (input instanceof URL) return input.href;
      if (typeof Request !== "undefined" && input instanceof Request) return input.url;
      return undefined;
    } catch {
      return undefined;
    }
  }

  function supportedConversationRequest(rawUrl: string | undefined): boolean {
    if (rawUrl === undefined) return false;
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== location.origin) return false;
      if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return false;
      return (
        url.pathname === "/backend-api/f/conversation" ||
        url.pathname === "/backend-api/f/conversation/resume" ||
        url.pathname === "/backend-api/conversation" ||
        url.pathname === "/backend-anon/f/conversation"
      );
    } catch {
      return false;
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

  function terminalDecisionFromTail(value: string, prefixCount: number): TerminalDecision | undefined {
    if (prefixCount !== 1) return undefined;
    const normalized = normalizeJsonEscapes(value.slice(-TERMINAL_TAIL_CHARS));
    const match = /AI_CHAT_MONITOR_STATUS=\{"decision":"([A-Z_]+)"\}/.exec(normalized);
    const candidate = match?.[1];
    return candidate !== undefined && terminalDecisionSet.has(candidate)
      ? candidate as TerminalDecision
      : undefined;
  }

  function streamDone(value: string): boolean {
    return /(?:^|\n)data:\s*\[DONE\](?:\r?\n|$)/.test(value);
  }

  function resolveEpisode(
    episodeStartedAt: number,
    outcome: { type: "terminal-status"; decision: TerminalDecision } | { type: "response-complete" },
  ): void {
    if (resolvedEpisodeStartedAt === episodeStartedAt) return;
    if (armedEpisodeStartedAt !== episodeStartedAt) return;
    resolvedEpisodeStartedAt = episodeStartedAt;
    armedEpisodeStartedAt = undefined;
    window.postMessage({
      channel: CHANNEL,
      protocolVersion: 1,
      episodeStartedAt,
      completedAt: Date.now(),
      ...outcome,
    }, location.origin);
  }

  async function observeResponse(response: Response, episodeStartedAt: number): Promise<void> {
    try {
      if (armedEpisodeStartedAt !== episodeStartedAt) return;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream") || response.body === null) return;

      const clone = response.clone();
      const reader = clone.body?.getReader();
      if (reader === undefined) return;

      const decoder = new TextDecoder();
      const statusPrefix = "AI_CHAT_MONITOR_STATUS=";
      let statusPrefixCount = 0;
      let statusPrefixCarry = "";
      let tail = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value === undefined) continue;
          const decoded = decoder.decode(chunk.value, { stream: true });
          const scan = statusPrefixCarry + decoded;
          let offset = 0;
          while (offset < scan.length) {
            const index = scan.indexOf(statusPrefix, offset);
            if (index < 0) break;
            statusPrefixCount += 1;
            offset = index + statusPrefix.length;
          }
          statusPrefixCarry = scan.slice(-(statusPrefix.length - 1));
          tail = (tail + decoded).slice(-MAX_TAIL_CHARS);
          if (!streamDone(tail)) continue;

          const decision = terminalDecisionFromTail(tail, statusPrefixCount);
          resolveEpisode(
            episodeStartedAt,
            decision === undefined
              ? { type: "response-complete" }
              : { type: "terminal-status", decision },
          );
          return;
        }
      } finally {
        try { reader.releaseLock(); } catch { /* stream already released */ }
      }
    } catch {
      // Observation must never affect ChatGPT's request/response path.
    }
  }

  const monitoredFetch: typeof window.fetch = async (...args) => {
    const episodeStartedAt = armedEpisodeStartedAt;
    const method = requestMethod(args[0], args[1]);
    const url = requestUrl(args[0]);
    const eligibleAtStart = episodeStartedAt !== undefined &&
      resolvedEpisodeStartedAt !== episodeStartedAt &&
      method === "POST" &&
      supportedConversationRequest(url) &&
      Date.now() - episodeStartedAt <= ARM_WINDOW_MS;

    const response = await originalFetch(...args);
    if (eligibleAtStart && episodeStartedAt !== undefined) {
      void observeResponse(response, episodeStartedAt);
    }
    return response;
  };

  window.fetch = monitoredFetch;
})();
