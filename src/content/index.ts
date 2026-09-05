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

  type MarkerHealth = "DETECTED" | "MISSING" | "MALFORMED";
  type SemanticDecision =
    | "CONTINUE"
    | "HOLD_APPROVAL"
    | "HOLD_DECISION"
    | "HOLD_HUMAN_OPERATION"
    | "COMPLETE"
    | "PLATFORM_ERROR"
    | "RATE_LIMIT"
    | "UNSURE";

  interface PanelAgentProbeMessage {
    type: "panel:agent-probe";
    protocolVersion: 2;
  }

  interface PanelAgentReconnectMessage {
    type: "panel:agent-reconnect";
    protocolVersion: 2;
  }

  interface ServerCompletionEvidence {
    conversationId: string;
    assistantMessageId: string;
    parentUserMessageId: string;
    messageStatus: "finished_successfully";
    endTurn: true;
    markerHealth: MarkerHealth;
    semanticDecision?: SemanticDecision;
    assistantTextLength: number;
  }

  const FOCUS_INTENT_WINDOW_MS = 1_500;
  const PERIODIC_OBSERVATION_MS = 15_000;
  const HIDDEN_RESPONSE_CHANNEL = "AI_CHAT_MONITOR_HIDDEN_RESPONSE_V1";
  const DECISIONS = new Set<SemanticDecision>([
    "CONTINUE",
    "HOLD_APPROVAL",
    "HOLD_DECISION",
    "HOLD_HUMAN_OPERATION",
    "COMPLETE",
    "PLATFORM_ERROR",
    "RATE_LIMIT",
    "UNSURE",
  ]);
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, location);
  const agentInstanceId = crypto.randomUUID();
  let pageEpoch = 1;
  let sequence = 0;
  let lastRouteKey = adapter.currentRouteKey();
  let observationTimer: number | undefined;
  let observationGeneration = 0;
  let outboundQueue: Promise<void> = Promise.resolve();
  let lastKeyboardFocusIntentAt: number | undefined;
  let monitoringEnabled = false;

  function nextSequence(): number { sequence += 1; return sequence; }

  async function send(message: Record<string, unknown>): Promise<RuntimeResponse | undefined> {
    let response: RuntimeResponse | undefined;
    const operation = outboundQueue.then(async () => {
      try { response = await chrome.runtime.sendMessage<RuntimeResponse>(message); } catch { response = undefined; }
      if (response?.type === "background:agent-ack" && typeof response.monitoringEnabled === "boolean") {
        monitoringEnabled = response.monitoringEnabled;
      }
    });
    outboundQueue = operation.catch(() => undefined);
    await operation;
    return response;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function isBoundedId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{4,200}$/.test(value);
  }

  function isPanelAgentProbeMessage(value: unknown): value is PanelAgentProbeMessage {
    return isRecord(value) && value.type === "panel:agent-probe" && value.protocolVersion === GuardianContent.PROTOCOL_VERSION;
  }

  function isPanelAgentReconnectMessage(value: unknown): value is PanelAgentReconnectMessage {
    return isRecord(value) && value.type === "panel:agent-reconnect" && value.protocolVersion === GuardianContent.PROTOCOL_VERSION;
  }

  function parseServerCompletionEvidence(value: unknown): ServerCompletionEvidence | undefined {
    if (!isRecord(value)) return undefined;
    if (!isBoundedId(value.conversationId) || !isBoundedId(value.assistantMessageId) || !isBoundedId(value.parentUserMessageId)) return undefined;
    if (value.messageStatus !== "finished_successfully" || value.endTurn !== true) return undefined;
    if (value.markerHealth !== "DETECTED" && value.markerHealth !== "MISSING" && value.markerHealth !== "MALFORMED") return undefined;
    if (value.semanticDecision !== undefined &&
        (typeof value.semanticDecision !== "string" || !DECISIONS.has(value.semanticDecision as SemanticDecision))) return undefined;
    if (value.markerHealth === "DETECTED" && value.semanticDecision === undefined) return undefined;
    if (value.markerHealth !== "DETECTED" && value.semanticDecision !== undefined) return undefined;
    if (typeof value.assistantTextLength !== "number" || !Number.isInteger(value.assistantTextLength) ||
        value.assistantTextLength < 0 || value.assistantTextLength > 262_144) return undefined;
    return {
      conversationId: value.conversationId,
      assistantMessageId: value.assistantMessageId,
      parentUserMessageId: value.parentUserMessageId,
      messageStatus: value.messageStatus,
      endTurn: true,
      markerHealth: value.markerHealth,
      ...(value.semanticDecision === undefined ? {} : { semanticDecision: value.semanticDecision as SemanticDecision }),
      assistantTextLength: value.assistantTextLength,
    };
  }

  function armHiddenResponseBridge(): void {
    const conversationId = adapter.currentConversationId();
    window.postMessage({
      channel: HIDDEN_RESPONSE_CHANNEL,
      type: "control",
      protocolVersion: 1,
      enabled: monitoringEnabled && conversationId !== undefined,
      ...(conversationId === undefined ? {} : { conversationId }),
    }, location.origin);
  }

  async function forwardServerCompletion(evidence: ServerCompletionEvidence): Promise<void> {
    if (!monitoringEnabled || adapter.currentConversationId() !== evidence.conversationId) return;
    const observation = await adapter.observe();
    if (observation.conversationId !== evidence.conversationId || observation.confidence !== "HIGH") return;
    if (observation.latestUser?.domMessageId !== evidence.parentUserMessageId) return;
    if (observation.latestAssistant?.domMessageId !== evidence.assistantMessageId) return;

    await send({
      type: "content:server-completion",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      sentAt: Date.now(),
      conversationId: evidence.conversationId,
      assistantMessageId: evidence.assistantMessageId,
      parentUserMessageId: evidence.parentUserMessageId,
      messageStatus: evidence.messageStatus,
      endTurn: evidence.endTurn,
      markerHealth: evidence.markerHealth,
      ...(evidence.semanticDecision === undefined ? {} : { semanticDecision: evidence.semanticDecision }),
      assistantTextLength: evidence.assistantTextLength,
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || !isRecord(event.data)) return;
    if (event.data.channel !== HIDDEN_RESPONSE_CHANNEL ||
        event.data.type !== "server-completion-evidence" ||
        event.data.protocolVersion !== 1) return;
    const evidence = parseServerCompletionEvidence(event.data.evidence);
    if (evidence !== undefined) void forwardServerCompletion(evidence);
  });

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
    const observation = await adapter.observe();
    if (expectedGeneration !== observationGeneration || observedEpoch !== pageEpoch || observation.routeKey !== lastRouteKey) return;
    await send({
      type: "content:observation",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      observation,
      sentAt: Date.now(),
    });
  }

  function scheduleObservation(delayMs = 300): void {
    observationGeneration += 1;
    const expectedGeneration = observationGeneration;
    if (observationTimer !== undefined) clearTimeout(observationTimer);
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
    if (interaction === "MANUAL_SEND") armHiddenResponseBridge();
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
  window.setInterval(checkRoute, 500);
  window.setInterval(() => scheduleObservation(0), PERIODIC_OBSERVATION_MS);
  void announceAgent().then(() => scheduleObservation(0));
}
