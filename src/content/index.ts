namespace GuardianContentAgent {
  type RuntimeResponse =
    | {
        type: "background:agent-ack";
        protocolVersion: 2;
        accepted: boolean;
      }
    | {
        type: "background:error";
        protocolVersion: 2;
        code: string;
        message: string;
      };

  const adapter = new GuardianContent.BrowserChatGPTAdapter(document, location);
  const agentInstanceId = crypto.randomUUID();
  let pageEpoch = 1;
  let sequence = 0;
  let lastRouteKey = adapter.currentRouteKey();
  let observationTimer: number | undefined;
  let observationGeneration = 0;
  let outboundQueue: Promise<void> = Promise.resolve();

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  async function send(message: Record<string, unknown>): Promise<RuntimeResponse | undefined> {
    let response: RuntimeResponse | undefined;
    const operation = outboundQueue.then(async () => {
      try {
        response = await chrome.runtime.sendMessage<RuntimeResponse>(message);
      } catch {
        response = undefined;
      }
    });
    outboundQueue = operation.catch(() => undefined);
    await operation;
    return response;
  }

  async function announceAgent(): Promise<void> {
    await send({
      type: "content:hello",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      routeKey: adapter.currentRouteKey(),
      ...(adapter.currentConversationId() === undefined
        ? {}
        : { conversationId: adapter.currentConversationId() }),
      sentAt: Date.now(),
    });
  }

  async function emitNavigation(nextRouteKey: string): Promise<void> {
    pageEpoch += 1;
    lastRouteKey = nextRouteKey;
    observationGeneration += 1;
    if (observationTimer !== undefined) {
      clearTimeout(observationTimer);
      observationTimer = undefined;
    }

    await send({
      type: "content:navigation",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      routeKey: nextRouteKey,
      ...(adapter.currentConversationId() === undefined
        ? {}
        : { conversationId: adapter.currentConversationId() }),
      sentAt: Date.now(),
    });
    scheduleObservation(0);
  }

  async function observe(expectedGeneration: number): Promise<void> {
    const observedEpoch = pageEpoch;
    const observation = await adapter.observe();
    if (
      expectedGeneration !== observationGeneration ||
      observedEpoch !== pageEpoch ||
      observation.routeKey !== lastRouteKey
    ) {
      return;
    }

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
    if (observationTimer !== undefined) {
      clearTimeout(observationTimer);
    }
    observationTimer = window.setTimeout(() => {
      observationTimer = undefined;
      void observe(expectedGeneration);
    }, delayMs);
  }

  function checkRoute(): void {
    const nextRouteKey = adapter.currentRouteKey();
    if (nextRouteKey !== lastRouteKey) {
      void emitNavigation(nextRouteKey);
    }
  }

  function emitUserInteraction(): void {
    void send({
      type: "content:user-interaction",
      protocolVersion: GuardianContent.PROTOCOL_VERSION,
      agentInstanceId,
      pageEpoch,
      sequence: nextSequence(),
      sentAt: Date.now(),
    });
    scheduleObservation(0);
  }

  const observer = new MutationObserver(() => {
    checkRoute();
    scheduleObservation();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "data-testid", "data-message-author-role"],
  });

  for (const eventName of ["beforeinput", "input", "paste", "compositionstart"] as const) {
    document.addEventListener(eventName, emitUserInteraction, true);
  }
  document.addEventListener("keydown", emitUserInteraction, true);
  document.addEventListener("pointerdown", emitUserInteraction, true);
  document.addEventListener("focusin", emitUserInteraction, true);
  window.addEventListener("popstate", checkRoute);
  window.addEventListener("hashchange", checkRoute);
  window.setInterval(checkRoute, 750);

  void announceAgent().then(() => scheduleObservation(0));
}
