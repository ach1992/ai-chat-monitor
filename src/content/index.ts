namespace GuardianContentAgent {
  type RuntimeResponse =
    | { type: "background:agent-ack"; protocolVersion: 2; accepted: boolean; monitoringEnabled?: boolean }
    | { type: "background:error"; protocolVersion: 2; code: string; message: string };

  type InteractionKind =
    | "COMPOSER_INPUT"
    | "COMPOSER_FOCUS"
    | "MANUAL_SEND"
    | "STOP_GENERATION"
    | "EDIT_TURN"
    | "BLOCKING_INTERACTION";

  interface PanelAgentProbeMessage {
    type: "panel:agent-probe";
    protocolVersion: 2;
  }

  interface PanelAgentReconnectMessage {
    type: "panel:agent-reconnect";
    protocolVersion: 2;
  }

  interface MonitoringStateMessage {
    type: "background:monitoring-state";
    protocolVersion: 2;
    enabled: boolean;
  }

  type TerminalDecision =
    | "CONTINUE"
    | "HOLD_APPROVAL"
    | "HOLD_DECISION"
    | "HOLD_HUMAN_OPERATION"
    | "COMPLETE"
    | "PLATFORM_ERROR"
    | "RATE_LIMIT"
    | "UNSURE";

  interface PageStreamArmedMessage {
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1";
    type: "stream-armed";
    protocolVersion: 1;
    episodeStartedAt: number;
  }

  interface PageStreamTerminalMessage {
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1";
    type: "terminal-status";
    protocolVersion: 1;
    episodeStartedAt: number;
    completedAt: number;
    decision: TerminalDecision;
  }

  interface PageStreamResponseCompleteMessage {
    channel: "AI_CHAT_MONITOR_PAGE_STREAM_V1";
    type: "response-complete";
    protocolVersion: 1;
    episodeStartedAt: number;
    completedAt: number;
  }

  interface ResponseCompletionEvidence {
    serial: number;
    transport: "CHATGPT_CONVERSATION_STREAM";
    visibility: "visible" | "hidden";
    completedAt: number;
  }

  interface ResponseTerminalStatusEvidence {
    serial: number;
    source: "CHATGPT_RESPONSE_STREAM";
    visibility: "visible" | "hidden";
    completedAt: number;
    decision: TerminalDecision;
  }

  const FOCUS_INTENT_WINDOW_MS = 1_500;
  const PERIODIC_OBSERVATION_MS = 15_000;
  const PAGE_STREAM_CHANNEL = "AI_CHAT_MONITOR_PAGE_STREAM_V1";
  const STATUS_PREFIX = "AI_CHAT_MONITOR_STATUS=";
  const TERMINAL_STATUS_LINE = /^AI_CHAT_MONITOR_STATUS=\{"decision":"(?:CONTINUE|HOLD_APPROVAL|HOLD_DECISION|HOLD_HUMAN_OPERATION|COMPLETE|PLATFORM_ERROR|RATE_LIMIT|UNSURE)"\}$/;
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, location);
  const agentInstanceId = crypto.randomUUID();
  let pageEpoch = 1;
  let sequence = 0;
  let lastRouteKey = adapter.currentRouteKey();
  let observationTimer: number | undefined;
  let observationMicrotaskQueued = false;
  let observationGeneration = 0;
  let outboundQueue: Promise<void> = Promise.resolve();
  let reconnectInFlight: Promise<boolean> | undefined;
  let lastKeyboardFocusIntentAt: number | undefined;
  let responseCompletionSerial = 0;
  let responseTerminalSerial = 0;
  let pendingResponseCompletion: ResponseCompletionEvidence | undefined;
  let pendingResponseTerminalStatus: ResponseTerminalStatusEvidence | undefined;
  let monitoringEnabled = false;
  let responsePending = false;
  let activePageStreamEpisodeStartedAt: number | undefined;

  function nextSequence(): number { sequence += 1; return sequence; }

  function setMonitoringEnabled(enabled: boolean): void {
    monitoringEnabled = enabled;
    window.postMessage({
      channel: PAGE_STREAM_CHANNEL,
      type: "monitoring-state",
      protocolVersion: 1,
      enabled,
    }, location.origin);
    if (enabled) return;

    responsePending = false;
    activePageStreamEpisodeStartedAt = undefined;
    pendingResponseCompletion = undefined;
    pendingResponseTerminalStatus = undefined;
    window.postMessage({ channel: PAGE_STREAM_CHANNEL, type: "disarm", protocolVersion: 1 }, location.origin);
  }

  async function send(message: Record<string, unknown>): Promise<RuntimeResponse | undefined> {
    let response: RuntimeResponse | undefined;
    const operation = outboundQueue.then(async () => {
      try {
        response = await chrome.runtime.sendMessage<RuntimeResponse>(message);
        if (response?.type === "background:agent-ack" && response.accepted && typeof response.monitoringEnabled === "boolean") {
          setMonitoringEnabled(response.monitoringEnabled);
        }
      } catch { response = undefined; }
    });
    outboundQueue = operation.catch(() => undefined);
    await operation;
    return response;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isPanelAgentProbeMessage(value: unknown): value is PanelAgentProbeMessage {
    return isRecord(value) && value.type === "panel:agent-probe" && value.protocolVersion === GuardianContent.PROTOCOL_VERSION;
  }

  function isPanelAgentReconnectMessage(value: unknown): value is PanelAgentReconnectMessage {
    return isRecord(value) && value.type === "panel:agent-reconnect" && value.protocolVersion === GuardianContent.PROTOCOL_VERSION;
  }

  function isMonitoringStateMessage(value: unknown): value is MonitoringStateMessage {
    return isRecord(value) &&
      value.type === "background:monitoring-state" &&
      value.protocolVersion === GuardianContent.PROTOCOL_VERSION &&
      typeof value.enabled === "boolean";
  }

  function isTerminalDecision(value: unknown): value is TerminalDecision {
    return (
      value === "CONTINUE" ||
      value === "HOLD_APPROVAL" ||
      value === "HOLD_DECISION" ||
      value === "HOLD_HUMAN_OPERATION" ||
      value === "COMPLETE" ||
      value === "PLATFORM_ERROR" ||
      value === "RATE_LIMIT" ||
      value === "UNSURE"
    );
  }

  function isPageStreamArmedMessage(value: unknown): value is PageStreamArmedMessage {
    return isRecord(value) &&
      value.channel === PAGE_STREAM_CHANNEL &&
      value.type === "stream-armed" &&
      value.protocolVersion === 1 &&
      typeof value.episodeStartedAt === "number" && Number.isFinite(value.episodeStartedAt) && value.episodeStartedAt > 0;
  }

  function isPageStreamTerminalMessage(value: unknown): value is PageStreamTerminalMessage {
    return isRecord(value) &&
      value.channel === PAGE_STREAM_CHANNEL &&
      value.type === "terminal-status" &&
      value.protocolVersion === 1 &&
      isTerminalDecision(value.decision) &&
      typeof value.episodeStartedAt === "number" && Number.isFinite(value.episodeStartedAt) && value.episodeStartedAt > 0 &&
      typeof value.completedAt === "number" && Number.isFinite(value.completedAt) && value.completedAt >= value.episodeStartedAt;
  }

  function isPageStreamResponseCompleteMessage(value: unknown): value is PageStreamResponseCompleteMessage {
    return isRecord(value) &&
      value.channel === PAGE_STREAM_CHANNEL &&
      value.type === "response-complete" &&
      value.protocolVersion === 1 &&
      typeof value.episodeStartedAt === "number" && Number.isFinite(value.episodeStartedAt) && value.episodeStartedAt > 0 &&
      typeof value.completedAt === "number" && Number.isFinite(value.completedAt) && value.completedAt >= value.episodeStartedAt;
  }

  function hasCanonicalTerminalStatus(value: string): boolean {
    const normalized = value.replace(/\r\n?/g, "\n").trimEnd();
    let occurrences = 0;
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(STATUS_PREFIX, offset);
      if (index < 0) break;
      occurrences += 1;
      if (occurrences > 1) return false;
      offset = index + STATUS_PREFIX.length;
    }
    if (occurrences !== 1) return false;
    return TERMINAL_STATUS_LINE.test(normalized.split("\n").at(-1)?.trim() ?? "");
  }

  function shouldHoldHiddenGeneration(observation: GuardianContent.PageObservation): boolean {
    if (!responsePending || observation.visibility !== "hidden") return false;
    if (observation.blocking.blocked || observation.actions.retryAvailable) return false;
    const assistantText = observation.latestAssistant?.normalizedText ?? "";
    return !hasCanonicalTerminalStatus(assistantText);
  }

  function agentProbeResponse(): Record<string, unknown> {
    const conversationId = adapter.currentConversationId();
    return {
      type: "content:agent-probe",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      routeKey: adapter.currentRouteKey(),
      ...(conversationId === undefined ? {} : { conversationId }),
    };
  }

  async function announceAgent(): Promise<boolean> {
    const conversationId = adapter.currentConversationId();
    const response = await send({
      type: "content:hello",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      routeKey: adapter.currentRouteKey(),
      ...(conversationId === undefined ? {} : { conversationId }),
      sentAt: Date.now(),
    });
    return response?.type === "background:agent-ack" && response.accepted;
  }

  async function emitNavigation(nextRouteKey: string): Promise<boolean> {
    pageEpoch += 1;
    lastRouteKey = nextRouteKey;
    observationGeneration += 1;
    pendingResponseCompletion = undefined;
    pendingResponseTerminalStatus = undefined;
    responsePending = false;
    activePageStreamEpisodeStartedAt = undefined;
    window.postMessage({ channel: PAGE_STREAM_CHANNEL, type: "disarm", protocolVersion: 1 }, location.origin);
    if (observationTimer !== undefined) {
      clearTimeout(observationTimer);
      observationTimer = undefined;
    }
    const conversationId = adapter.currentConversationId();
    const response = await send({
      type: "content:navigation",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      routeKey: nextRouteKey,
      ...(conversationId === undefined ? {} : { conversationId }),
      sentAt: Date.now(),
    });
    scheduleObservation(0);
    return response?.type === "background:agent-ack" && response.accepted;
  }

  async function reconnectAgent(): Promise<boolean> {
    const nextRouteKey = adapter.currentRouteKey();
    if (nextRouteKey !== lastRouteKey) {
      const navigated = await emitNavigation(nextRouteKey);
      if (navigated) return true;
      return announceAgent();
    }
    return announceAgent();
  }

  async function observe(expectedGeneration: number): Promise<void> {
    const observedEpoch = pageEpoch;
    const sampled = await adapter.observe();
    if (expectedGeneration !== observationGeneration || observedEpoch !== pageEpoch || sampled.routeKey !== lastRouteKey) return;
    const held = shouldHoldHiddenGeneration(sampled)
      ? { ...sampled, generation: "GENERATING" as const }
      : sampled;
    const completion = pendingResponseCompletion;
    const terminalStatus = pendingResponseTerminalStatus;
    const observation = terminalStatus !== undefined
      ? { ...held, responseTerminalStatus: structuredClone(terminalStatus) }
      : completion !== undefined
        ? { ...held, responseCompletion: structuredClone(completion) }
        : held;
    const response = await send({
      type: "content:observation",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      observation,
      sentAt: Date.now(),
    });
    if (response?.type === "background:agent-ack" && response.accepted) {
      if (terminalStatus !== undefined && pendingResponseTerminalStatus?.serial === terminalStatus.serial) {
        pendingResponseTerminalStatus = undefined;
      }
      if (completion !== undefined && pendingResponseCompletion?.serial === completion.serial) {
        pendingResponseCompletion = undefined;
      }
      return;
    }

    const recoverable = response === undefined || (response.type === "background:error" && response.code === "STALE_EVENT");
    if (!recoverable) return;
    const recovered = await ensureAgentReconnected();
    if (recovered) scheduleObservation(0);
  }

  async function ensureAgentReconnected(): Promise<boolean> {
    if (reconnectInFlight !== undefined) return reconnectInFlight;
    const operation = reconnectAgent();
    reconnectInFlight = operation;
    try {
      return await operation;
    } finally {
      if (reconnectInFlight === operation) reconnectInFlight = undefined;
    }
  }

  function scheduleObservation(delayMs = 300): void {
    observationGeneration += 1;
    if (observationTimer !== undefined) {
      clearTimeout(observationTimer);
      observationTimer = undefined;
    }

    if (document.visibilityState === "hidden") {
      if (observationMicrotaskQueued) return;
      observationMicrotaskQueued = true;
      queueMicrotask(() => {
        observationMicrotaskQueued = false;
        const expectedGeneration = observationGeneration;
        void observe(expectedGeneration);
      });
      return;
    }

    const expectedGeneration = observationGeneration;
    observationTimer = window.setTimeout(() => {
      observationTimer = undefined;
      void observe(expectedGeneration);
    }, delayMs);
  }

  function checkRoute(): void {
    const nextRouteKey = adapter.currentRouteKey();
    if (nextRouteKey !== lastRouteKey) void emitNavigation(nextRouteKey);
  }

  function emitUserInteraction(interaction: InteractionKind): void {
    const sentAt = Date.now();
    if (interaction === "MANUAL_SEND" && monitoringEnabled) {
      responsePending = true;
      activePageStreamEpisodeStartedAt = undefined;
      pendingResponseCompletion = undefined;
      pendingResponseTerminalStatus = undefined;
    } else if (interaction === "STOP_GENERATION") {
      responsePending = false;
      activePageStreamEpisodeStartedAt = undefined;
      pendingResponseCompletion = undefined;
      pendingResponseTerminalStatus = undefined;
      window.postMessage({ channel: PAGE_STREAM_CHANNEL, type: "disarm", protocolVersion: 1 }, location.origin);
    }
    void send({
      type: "content:user-interaction",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      interaction,
      sentAt,
    });
    scheduleObservation(0);
  }

  function consumeRecentKeyboardFocusIntent(now: number): boolean {
    const intentAt = lastKeyboardFocusIntentAt;
    lastKeyboardFocusIntentAt = undefined;
    return intentAt !== undefined && now >= intentAt && now - intentAt <= FOCUS_INTENT_WINDOW_MS;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (isPageStreamArmedMessage(event.data)) {
      if (monitoringEnabled && responsePending) activePageStreamEpisodeStartedAt = event.data.episodeStartedAt;
      return;
    }
    if (!monitoringEnabled || !responsePending) return;
    const episodeStartedAt = activePageStreamEpisodeStartedAt;
    if (episodeStartedAt === undefined) return;

    if (isPageStreamTerminalMessage(event.data)) {
      if (event.data.episodeStartedAt !== episodeStartedAt) return;
      responseTerminalSerial += 1;
      pendingResponseTerminalStatus = {
        serial: responseTerminalSerial,
        source: "CHATGPT_RESPONSE_STREAM",
        visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
        completedAt: event.data.completedAt,
        decision: event.data.decision,
      };
      pendingResponseCompletion = undefined;
      responsePending = false;
      activePageStreamEpisodeStartedAt = undefined;
      scheduleObservation(0);
      return;
    }

    if (isPageStreamResponseCompleteMessage(event.data)) {
      if (event.data.episodeStartedAt !== episodeStartedAt) return;
      responseCompletionSerial += 1;
      pendingResponseCompletion = {
        serial: responseCompletionSerial,
        transport: "CHATGPT_CONVERSATION_STREAM",
        visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
        completedAt: event.data.completedAt,
      };
      pendingResponseTerminalStatus = undefined;
      responsePending = false;
      activePageStreamEpisodeStartedAt = undefined;
      scheduleObservation(0);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isMonitoringStateMessage(message)) {
      setMonitoringEnabled(message.enabled);
      sendResponse({ type: "content:monitoring-state-ack", protocolVersion: GuardianContent.PROTOCOL_VERSION });
      return false;
    }
    if (isPanelAgentProbeMessage(message)) {
      sendResponse(agentProbeResponse());
      return false;
    }
    if (isPanelAgentReconnectMessage(message)) {
      void reconnectAgent().then((accepted) => {
        if (accepted) scheduleObservation(0);
        sendResponse({
          type: "content:agent-reconnected",
          protocolVersion: GuardianContent.PROTOCOL_VERSION,
          accepted,
        });
      }, () => {
        sendResponse({
          type: "content:agent-reconnected",
          protocolVersion: GuardianContent.PROTOCOL_VERSION,
          accepted: false,
        });
      });
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => { checkRoute(); scheduleObservation(); });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "data-testid", "data-message-author-role", "disabled"],
  });

  for (const eventName of ["beforeinput", "input", "paste", "compositionstart"] as const) {
    document.addEventListener(eventName, (event) => {
      if (!event.isTrusted) return;
      if (adapter.isComposerTarget(event.target)) emitUserInteraction("COMPOSER_INPUT");
    }, true);
  }

  document.addEventListener("focusin", (event) => {
    if (!event.isTrusted || !adapter.isComposerTarget(event.target)) return;
    if (consumeRecentKeyboardFocusIntent(performance.now())) emitUserInteraction("COMPOSER_FOCUS");
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    if (event.key === "Tab") lastKeyboardFocusIntentAt = performance.now();
    if (!adapter.isComposerTarget(event.target)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) emitUserInteraction("MANUAL_SEND");
    else emitUserInteraction("COMPOSER_INPUT");
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    if (adapter.isComposerTarget(event.target)) emitUserInteraction("COMPOSER_FOCUS");
    else if (adapter.isManualSendTarget(event.target)) emitUserInteraction("MANUAL_SEND");
    else if (adapter.isStopGenerationTarget(event.target)) emitUserInteraction("STOP_GENERATION");
    else if (adapter.isEditTurnTarget(event.target)) emitUserInteraction("EDIT_TURN");
    else if (adapter.isBlockingInteractionTarget(event.target)) emitUserInteraction("BLOCKING_INTERACTION");
  }, true);

  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  document.addEventListener("visibilitychange", () => {
    checkRoute();
    scheduleObservation(0);
  });
  window.setInterval(checkRoute, 500);
  window.setInterval(() => scheduleObservation(0), PERIODIC_OBSERVATION_MS);
  void announceAgent().then(() => scheduleObservation(0));
}
