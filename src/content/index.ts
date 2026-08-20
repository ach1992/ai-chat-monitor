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

  interface GuardedSendMessage {
    type: "background:guarded-send";
    protocolVersion: 2;
    decisionId: string;
    agentInstanceId: string;
    pageEpoch: number;
    conversationId: string;
    routeKey: string;
    assistantFingerprint: string;
    assistantDomMessageId?: string;
    lastUserInteractionAt?: number;
    continuationText: string;
    expiresAt: number;
  }

  interface PanelAgentProbeMessage {
    type: "panel:agent-probe";
    protocolVersion: 2;
  }

  interface PanelAgentReconnectMessage {
    type: "panel:agent-reconnect";
    protocolVersion: 2;
  }

  const FOCUS_INTENT_WINDOW_MS = 1_500;
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, location);
  const agentInstanceId = crypto.randomUUID();
  let pageEpoch = 1;
  let sequence = 0;
  let lastRouteKey = adapter.currentRouteKey();
  let observationTimer: number | undefined;
  let observationGeneration = 0;
  let outboundQueue: Promise<void> = Promise.resolve();
  let lastLocalUserInteractionAt: number | undefined;
  let lastKeyboardFocusIntentAt: number | undefined;
  let guardedSendInFlight = false;

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

  function isGuardedSendMessage(value: unknown): value is GuardedSendMessage {
    if (!isRecord(value)) return false;
    return (
      value.type === "background:guarded-send" &&
      value.protocolVersion === GuardianContent.PROTOCOL_VERSION &&
      typeof value.decisionId === "string" && value.decisionId.length > 0 && value.decisionId.length <= 128 &&
      typeof value.agentInstanceId === "string" && value.agentInstanceId.length > 0 && value.agentInstanceId.length <= 128 &&
      typeof value.pageEpoch === "number" && Number.isInteger(value.pageEpoch) && value.pageEpoch >= 1 &&
      typeof value.conversationId === "string" && value.conversationId.length >= 4 && value.conversationId.length <= 200 &&
      typeof value.routeKey === "string" && value.routeKey.length > 0 && value.routeKey.length <= 500 &&
      typeof value.assistantFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.assistantFingerprint) &&
      (value.assistantDomMessageId === undefined || typeof value.assistantDomMessageId === "string") &&
      (value.lastUserInteractionAt === undefined || (typeof value.lastUserInteractionAt === "number" && Number.isFinite(value.lastUserInteractionAt))) &&
      typeof value.continuationText === "string" && value.continuationText.trim().length > 0 && value.continuationText.length <= 200 &&
      typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
    );
  }

  function isPanelAgentProbeMessage(value: unknown): value is PanelAgentProbeMessage {
    return isRecord(value) && value.type === "panel:agent-probe" && value.protocolVersion === GuardianContent.PROTOCOL_VERSION;
  }

  function isPanelAgentReconnectMessage(value: unknown): value is PanelAgentReconnectMessage {
    return isRecord(value) && value.type === "panel:agent-reconnect" && value.protocolVersion === GuardianContent.PROTOCOL_VERSION;
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

  async function handleGuardedSend(message: GuardedSendMessage): Promise<GuardianContent.PageGuardedSendResult> {
    if (message.agentInstanceId !== agentInstanceId || message.pageEpoch !== pageEpoch || Date.now() > message.expiresAt) {
      return { decisionId: message.decisionId, status: "NOT_STARTED", reason: "Content-agent identity or decision lifetime no longer matches." };
    }
    const humanStateIsCurrent = (): boolean => message.lastUserInteractionAt === lastLocalUserInteractionAt;
    if (!humanStateIsCurrent()) {
      return { decisionId: message.decisionId, status: "NOT_STARTED", reason: "Trusted human interaction changed after the decision evidence." };
    }
    if (guardedSendInFlight) {
      return { decisionId: message.decisionId, status: "NOT_STARTED", reason: "Another guarded send is already active for this content agent." };
    }

    guardedSendInFlight = true;
    observationGeneration += 1;
    if (observationTimer !== undefined) {
      clearTimeout(observationTimer);
      observationTimer = undefined;
    }
    try {
      return await adapter.guardedSend({
        decisionId: message.decisionId,
        conversationId: message.conversationId,
        routeKey: message.routeKey,
        assistantFingerprint: message.assistantFingerprint,
        ...(message.assistantDomMessageId === undefined ? {} : { assistantDomMessageId: message.assistantDomMessageId }),
        continuationText: message.continuationText,
      }, humanStateIsCurrent);
    } finally {
      guardedSendInFlight = false;
      scheduleObservation(0);
    }
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
    if (observationTimer !== undefined) { clearTimeout(observationTimer); observationTimer = undefined; }
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
    if (guardedSendInFlight) return;
    observationGeneration += 1;
    const expectedGeneration = observationGeneration;
    if (observationTimer !== undefined) clearTimeout(observationTimer);
    observationTimer = window.setTimeout(() => { observationTimer = undefined; void observe(expectedGeneration); }, delayMs);
  }

  function checkRoute(): void {
    const nextRouteKey = adapter.currentRouteKey();
    if (nextRouteKey !== lastRouteKey) void emitNavigation(nextRouteKey);
  }

  function emitUserInteraction(interaction: InteractionKind): void {
    const sentAt = Math.max(Date.now(), (lastLocalUserInteractionAt ?? 0) + 1);
    lastLocalUserInteractionAt = sentAt;
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
    if (!isGuardedSendMessage(message)) return false;
    void handleGuardedSend(message).then(sendResponse, () => {
      sendResponse({ decisionId: message.decisionId, status: "AMBIGUOUS", reason: "Content-agent guarded send failed unexpectedly." });
    });
    return true;
  });

  const observer = new MutationObserver(() => { checkRoute(); scheduleObservation(); });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "data-testid", "data-message-author-role"],
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
  void announceAgent().then(() => scheduleObservation(0));
}
