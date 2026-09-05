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

  interface NetworkDiagnosticControlMessage {
    type: "diagnostic:network-control";
    protocolVersion: 1;
    enabled: boolean;
  }

  interface NetworkDiagnosticReadMessage {
    type: "diagnostic:network-read";
    protocolVersion: 1;
  }

  interface PageNetworkDiagnosticEvent {
    kind:
      | "EPISODE_ARMED"
      | "FETCH_RESPONSE"
      | "FETCH_ERROR"
      | "LIFECYCLE_STATUS"
      | "WEBSOCKET_PRESENT"
      | "WEBSOCKET_ACTIVITY"
      | "WEBSOCKET_CLOSE"
      | "WEBSOCKET_ERROR";
    at: number;
    visibility?: string;
    episodeId?: string;
    episodeStartedAt?: number;
    requestId?: string;
    requestOrdinal?: number;
    requestStartedAt?: number;
    responseAt?: number;
    method?: string;
    path?: string;
    status?: number;
    contentType?: string;
    serverStatus?: string;
    errorName?: string;
    socketId?: string;
    socketHost?: string;
    socketPath?: string;
    socketCreatedAt?: number;
    readyState?: number;
    messageCount?: number;
    firstMessageAt?: number;
    lastMessageAt?: number;
  }

  const FOCUS_INTENT_WINDOW_MS = 1_500;
  const PERIODIC_OBSERVATION_MS = 15_000;
  const NETWORK_DIAGNOSTIC_CHANNEL = "AI_CHAT_MONITOR_NETWORK_DIAGNOSTIC_V1";
  const MAX_NETWORK_DIAGNOSTIC_EVENTS = 96;
  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, location);
  const agentInstanceId = crypto.randomUUID();
  let pageEpoch = 1;
  let sequence = 0;
  let lastRouteKey = adapter.currentRouteKey();
  let observationTimer: number | undefined;
  let observationGeneration = 0;
  let outboundQueue: Promise<void> = Promise.resolve();
  let lastKeyboardFocusIntentAt: number | undefined;
  let networkDiagnosticEvents: PageNetworkDiagnosticEvent[] = [];

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

  function isNetworkDiagnosticControlMessage(value: unknown): value is NetworkDiagnosticControlMessage {
    return isRecord(value) &&
      value.type === "diagnostic:network-control" &&
      value.protocolVersion === 1 &&
      typeof value.enabled === "boolean";
  }

  function isNetworkDiagnosticReadMessage(value: unknown): value is NetworkDiagnosticReadMessage {
    return isRecord(value) && value.type === "diagnostic:network-read" && value.protocolVersion === 1;
  }

  function boundedString(value: unknown, max: number): string | undefined {
    return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
  }

  function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  function sanitizeNetworkDiagnosticEvent(value: unknown): PageNetworkDiagnosticEvent | undefined {
    if (!isRecord(value)) return undefined;
    const kind = value.kind;
    if (kind !== "EPISODE_ARMED" &&
      kind !== "FETCH_RESPONSE" &&
      kind !== "FETCH_ERROR" &&
      kind !== "LIFECYCLE_STATUS" &&
      kind !== "WEBSOCKET_PRESENT" &&
      kind !== "WEBSOCKET_ACTIVITY" &&
      kind !== "WEBSOCKET_CLOSE" &&
      kind !== "WEBSOCKET_ERROR") return undefined;
    const at = finiteNumber(value.at);
    if (at === undefined) return undefined;

    const result: PageNetworkDiagnosticEvent = { kind, at };
    const visibility = boundedString(value.visibility, 32);
    const episodeId = boundedString(value.episodeId, 100);
    const requestId = boundedString(value.requestId, 220);
    const method = boundedString(value.method, 16);
    const path = boundedString(value.path, 240);
    const contentType = boundedString(value.contentType, 160);
    const serverStatus = boundedString(value.serverStatus, 80);
    const errorName = boundedString(value.errorName, 80);
    const socketId = boundedString(value.socketId, 100);
    const socketHost = boundedString(value.socketHost, 160);
    const socketPath = boundedString(value.socketPath, 240);

    if (visibility !== undefined) result.visibility = visibility;
    if (episodeId !== undefined) result.episodeId = episodeId;
    if (requestId !== undefined) result.requestId = requestId;
    if (method !== undefined) result.method = method;
    if (path !== undefined) result.path = path;
    if (contentType !== undefined) result.contentType = contentType;
    if (serverStatus !== undefined) result.serverStatus = serverStatus;
    if (errorName !== undefined) result.errorName = errorName;
    if (socketId !== undefined) result.socketId = socketId;
    if (socketHost !== undefined) result.socketHost = socketHost;
    if (socketPath !== undefined) result.socketPath = socketPath;

    for (const key of [
      "episodeStartedAt",
      "requestOrdinal",
      "requestStartedAt",
      "responseAt",
      "status",
      "socketCreatedAt",
      "readyState",
      "messageCount",
      "firstMessageAt",
      "lastMessageAt",
    ] as const) {
      const numberValue = finiteNumber(value[key]);
      if (numberValue !== undefined) result[key] = numberValue;
    }
    return result;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || !isRecord(event.data)) return;
    if (event.data.channel !== NETWORK_DIAGNOSTIC_CHANNEL ||
      event.data.type !== "network-diagnostic" ||
      event.data.protocolVersion !== 1) return;
    const sanitized = sanitizeNetworkDiagnosticEvent(event.data.event);
    if (sanitized === undefined) return;
    networkDiagnosticEvents = [...networkDiagnosticEvents, sanitized].slice(-MAX_NETWORK_DIAGNOSTIC_EVENTS);
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
    if (isNetworkDiagnosticControlMessage(message)) {
      if (message.enabled) networkDiagnosticEvents = [];
      window.postMessage({
        channel: NETWORK_DIAGNOSTIC_CHANNEL,
        type: "control",
        protocolVersion: 1,
        enabled: message.enabled,
      }, location.origin);
      sendResponse({
        type: "content:network-diagnostic-control",
        protocolVersion: 1,
        enabled: message.enabled,
      });
      return false;
    }
    if (isNetworkDiagnosticReadMessage(message)) {
      const conversationId = adapter.currentConversationId();
      sendResponse({
        type: "content:network-diagnostic",
        protocolVersion: 1,
        routeKey: adapter.currentRouteKey(),
        ...(conversationId === undefined ? {} : { conversationId }),
        events: structuredClone(networkDiagnosticEvents),
      });
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
  window.setInterval(checkRoute, 500);
  window.setInterval(() => scheduleObservation(0), PERIODIC_OBSERVATION_MS);
  void announceAgent().then(() => scheduleObservation(0));
}
