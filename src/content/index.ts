namespace GuardianContentAgent {
  type RuntimeResponse =
    | { type: "background:agent-ack"; protocolVersion: 2; accepted: boolean }
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

  interface ResponseStreamStartedMessage {
    type: "background:response-stream-started";
    protocolVersion: 2;
    requestId: string;
    startedAt: number;
  }

  interface ResponseStreamCompletedMessage {
    type: "background:response-stream-completed";
    protocolVersion: 2;
    requestId: string;
    startedAt: number;
    completedAt: number;
  }

  interface ResponseStreamAbortedMessage {
    type: "background:response-stream-aborted";
    protocolVersion: 2;
    requestId: string;
    startedAt: number;
  }

  interface ResponseCompletionEvidence {
    serial: number;
    transport: "CHATGPT_CONVERSATION_STREAM";
    visibility: "visible" | "hidden";
    completedAt: number;
  }

  interface ActiveResponseStream {
    requestId: string;
    startedAt: number;
  }

  const FOCUS_INTENT_WINDOW_MS = 1_500;
  const PERIODIC_OBSERVATION_MS = 15_000;
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
  let pendingResponseCompletion: ResponseCompletionEvidence | undefined;
  let activeResponseStream: ActiveResponseStream | undefined;
  let responsePending = false;

  function nextSequence(): number { sequence += 1; return sequence; }

  async function send(message: Record<string, unknown>): Promise<RuntimeResponse | undefined> {
    let response: RuntimeResponse | undefined;
    const operation = outboundQueue.then(async () => {
      try { response = await chrome.runtime.sendMessage<RuntimeResponse>(message); } catch { response = undefined; }
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

  function validStreamIdentity(value: Record<string, unknown>): boolean {
    return (
      typeof value.requestId === "string" && value.requestId.length > 0 &&
      typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt > 0
    );
  }

  function isResponseStreamStartedMessage(value: unknown): value is ResponseStreamStartedMessage {
    return isRecord(value) &&
      value.type === "background:response-stream-started" &&
      value.protocolVersion === GuardianContent.PROTOCOL_VERSION &&
      validStreamIdentity(value);
  }

  function isResponseStreamCompletedMessage(value: unknown): value is ResponseStreamCompletedMessage {
    return isRecord(value) &&
      value.type === "background:response-stream-completed" &&
      value.protocolVersion === GuardianContent.PROTOCOL_VERSION &&
      validStreamIdentity(value) &&
      typeof value.completedAt === "number" && Number.isFinite(value.completedAt) &&
      value.completedAt >= value.startedAt;
  }

  function isResponseStreamAbortedMessage(value: unknown): value is ResponseStreamAbortedMessage {
    return isRecord(value) &&
      value.type === "background:response-stream-aborted" &&
      value.protocolVersion === GuardianContent.PROTOCOL_VERSION &&
      validStreamIdentity(value);
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
    activeResponseStream = undefined;
    responsePending = false;
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
    const observation = completion === undefined
      ? held
      : { ...held, responseCompletion: structuredClone(completion) };
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
    if (interaction === "MANUAL_SEND") {
      responsePending = true;
      activeResponseStream = undefined;
      pendingResponseCompletion = undefined;
    } else if (interaction === "STOP_GENERATION") {
      responsePending = false;
      activeResponseStream = undefined;
      pendingResponseCompletion = undefined;
    }
    void send({
      type: "content:user-interaction",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      interaction,
      sentAt: Date.now(),
    });
    scheduleObservation(0);
  }

  function consumeRecentKeyboardFocusIntent(now: number): boolean {
    const intentAt = lastKeyboardFocusIntentAt;
    lastKeyboardFocusIntentAt = undefined;
    return intentAt !== undefined && now >= intentAt && now - intentAt <= FOCUS_INTENT_WINDOW_MS;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    if (isResponseStreamStartedMessage(message)) {
      if (activeResponseStream === undefined || message.startedAt >= activeResponseStream.startedAt) {
        activeResponseStream = { requestId: message.requestId, startedAt: message.startedAt };
        responsePending = true;
        pendingResponseCompletion = undefined;
        scheduleObservation(0);
      }
      sendResponse({ type: "content:response-stream-ack", protocolVersion: GuardianContent.PROTOCOL_VERSION });
      return false;
    }
    if (isResponseStreamCompletedMessage(message)) {
      if (activeResponseStream !== undefined && activeResponseStream.requestId !== message.requestId) return false;
      responseCompletionSerial += 1;
      pendingResponseCompletion = {
        serial: responseCompletionSerial,
        transport: "CHATGPT_CONVERSATION_STREAM",
        visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
        completedAt: message.completedAt,
      };
      activeResponseStream = undefined;
      responsePending = false;
      scheduleObservation(0);
      sendResponse({ type: "content:response-stream-ack", protocolVersion: GuardianContent.PROTOCOL_VERSION });
      return false;
    }
    if (isResponseStreamAbortedMessage(message)) {
      if (activeResponseStream?.requestId === message.requestId) {
        activeResponseStream = undefined;
        responsePending = false;
        pendingResponseCompletion = undefined;
        scheduleObservation(0);
      }
      sendResponse({ type: "content:response-stream-ack", protocolVersion: GuardianContent.PROTOCOL_VERSION });
      return false;
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
