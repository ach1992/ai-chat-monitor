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
    continuationText: string;
    expiresAt: number;
  }

  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, location);
  const agentInstanceId = crypto.randomUUID();
  let pageEpoch = 1;
  let sequence = 0;
  let lastRouteKey = adapter.currentRouteKey();
  let observationTimer: number | undefined;
  let observationGeneration = 0;
  let outboundQueue: Promise<void> = Promise.resolve();

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

  function isGuardedSendMessage(value: unknown): value is GuardedSendMessage {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      record.type === "background:guarded-send" &&
      record.protocolVersion === GuardianContent.PROTOCOL_VERSION &&
      typeof record.decisionId === "string" && record.decisionId.length > 0 && record.decisionId.length <= 128 &&
      typeof record.agentInstanceId === "string" && record.agentInstanceId.length > 0 && record.agentInstanceId.length <= 128 &&
      typeof record.pageEpoch === "number" && Number.isInteger(record.pageEpoch) && record.pageEpoch >= 1 &&
      typeof record.conversationId === "string" && record.conversationId.length >= 4 && record.conversationId.length <= 200 &&
      typeof record.routeKey === "string" && record.routeKey.length > 0 && record.routeKey.length <= 500 &&
      typeof record.assistantFingerprint === "string" && /^[a-f0-9]{64}$/.test(record.assistantFingerprint) &&
      (record.assistantDomMessageId === undefined || typeof record.assistantDomMessageId === "string") &&
      typeof record.continuationText === "string" && record.continuationText.trim().length > 0 && record.continuationText.length <= 200 &&
      typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    );
  }

  async function handleGuardedSend(message: GuardedSendMessage): Promise<GuardianContent.PageGuardedSendResult> {
    if (message.agentInstanceId !== agentInstanceId || message.pageEpoch !== pageEpoch || Date.now() > message.expiresAt) {
      return { decisionId: message.decisionId, status: "NOT_STARTED", reason: "Content-agent identity or decision lifetime no longer matches." };
    }
    const result = await adapter.guardedSend({
      decisionId: message.decisionId,
      conversationId: message.conversationId,
      routeKey: message.routeKey,
      assistantFingerprint: message.assistantFingerprint,
      ...(message.assistantDomMessageId === undefined ? {} : { assistantDomMessageId: message.assistantDomMessageId }),
      continuationText: message.continuationText,
    });
    scheduleObservation(0);
    return result;
  }

  async function announceAgent(): Promise<void> {
    const conversationId = adapter.currentConversationId();
    await send({
      type: "content:hello",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      routeKey: adapter.currentRouteKey(),
      ...(conversationId === undefined ? {} : { conversationId }),
      sentAt: Date.now(),
    });
  }

  async function emitNavigation(nextRouteKey: string): Promise<void> {
    pageEpoch += 1;
    lastRouteKey = nextRouteKey;
    observationGeneration += 1;
    if (observationTimer !== undefined) { clearTimeout(observationTimer); observationTimer = undefined; }
    const conversationId = adapter.currentConversationId();
    await send({
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
    observationTimer = window.setTimeout(() => { observationTimer = undefined; void observe(expectedGeneration); }, delayMs);
  }

  function checkRoute(): void {
    const nextRouteKey = adapter.currentRouteKey();
    if (nextRouteKey !== lastRouteKey) void emitNavigation(nextRouteKey);
  }

  function emitUserInteraction(interaction: InteractionKind): void {
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    if (!event.isTrusted) return;
    if (adapter.isComposerTarget(event.target)) emitUserInteraction("COMPOSER_FOCUS");
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || !adapter.isComposerTarget(event.target)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) emitUserInteraction("MANUAL_SEND");
    else emitUserInteraction("COMPOSER_INPUT");
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    if (adapter.isManualSendTarget(event.target)) emitUserInteraction("MANUAL_SEND");
    else if (adapter.isStopGenerationTarget(event.target)) emitUserInteraction("STOP_GENERATION");
    else if (adapter.isEditTurnTarget(event.target)) emitUserInteraction("EDIT_TURN");
    else if (adapter.isBlockingInteractionTarget(event.target)) emitUserInteraction("BLOCKING_INTERACTION");
  }, true);

  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  window.setInterval(checkRoute, 500);
  void announceAgent().then(() => scheduleObservation(0));
}
