namespace GuardianContent {
  const AMBIGUOUS_SEND_VERIFICATION_REASON = "The intended user turn and generation start could not both be verified.";
  const GUARDIAN_STATUS_PREFIX = "CHAT_TURN_GUARDIAN_STATUS_V1=";
  const MAX_NORMALIZED_RESPONSE_CHARS = 12_000;
  const ASSISTANT_SELECTORS = ['[data-message-author-role="assistant"]', 'article[data-turn="assistant"]'] as const;
  const USER_SELECTORS = ['[data-message-author-role="user"]', 'article[data-turn="user"]'] as const;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const originalObserve = BrowserChatGPTAdapter.prototype.observe;
  const originalGuardedSend = BrowserChatGPTAdapter.prototype.guardedSend;

  function currentDocument(): Document | undefined {
    return typeof document === "undefined" ? undefined : document;
  }

  function allMatches(selectors: readonly string[]): Element[] {
    const pageDocument = currentDocument();
    if (pageDocument === undefined) return [];
    const found = new Set<Element>();
    for (const selector of selectors) {
      try { for (const element of pageDocument.querySelectorAll(selector)) found.add(element); } catch { /* fail closed */ }
    }
    return [...found];
  }

  function readMessageId(element: Element): string | undefined {
    const direct = element.getAttribute("data-message-id");
    if (direct !== null && direct.length > 0) return direct;
    const turn = element.closest(TURN_SELECTOR);
    const testId = turn?.getAttribute("data-testid");
    if (testId?.startsWith("conversation-turn-") === true) {
      const suffix = testId.slice("conversation-turn-".length);
      return suffix.length === 0 ? undefined : suffix;
    }
    return undefined;
  }

  function structurallyFollows(before: Element, after: Element): boolean {
    try {
      const position = before.compareDocumentPosition(after);
      return (
        (position & Node.DOCUMENT_POSITION_DISCONNECTED) === 0 &&
        (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      );
    } catch {
      return false;
    }
  }

  function latestAssistantElement(): Element | undefined {
    const assistant = allMatches(ASSISTANT_SELECTORS).at(-1);
    if (assistant === undefined) return undefined;
    const latestUser = allMatches(USER_SELECTORS).at(-1);
    if (latestUser !== undefined && structurallyFollows(assistant, latestUser)) return undefined;
    return assistant;
  }

  function latestUserBefore(assistant: Element): Element | undefined {
    const users = allMatches(USER_SELECTORS);
    for (let index = users.length - 1; index >= 0; index -= 1) {
      const user = users[index];
      if (user !== undefined && structurallyFollows(user, assistant)) return user;
    }
    return undefined;
  }

  function markerIsInsideCode(element: Element): boolean {
    try {
      return [...element.querySelectorAll("pre, code")].some((code) =>
        (code.textContent ?? "").includes(GUARDIAN_STATUS_PREFIX),
      );
    } catch {
      return true;
    }
  }

  function hiddenStructuralText(element: Element): string {
    return normalizeAssistantText(element.textContent ?? "");
  }

  function compactControlText(value: string): string {
    return normalizeAssistantText(value).replace(/\s+/g, "");
  }

  function intendedUserTurnMatches(element: Element, expected: string): boolean {
    const expectedNormalized = normalizeAssistantText(expected);
    const structural = hiddenStructuralText(element);
    if (structural === expectedNormalized) return true;

    let rendered = "";
    try {
      rendered = element instanceof HTMLElement && typeof element.innerText === "string"
        ? normalizeAssistantText(element.innerText)
        : "";
    } catch {
      rendered = "";
    }
    if (rendered === expectedNormalized) return true;

    // Chromium may keep layout-derived innerText stale while a tab is hidden. For
    // Guardian-owned control turns, whitespace is presentation-only, so compare the
    // non-whitespace payload as a hidden-tab fallback while retaining exact route,
    // conversation, DOM ordering, and trusted-human-state guards.
    return currentDocument()?.visibilityState === "hidden" &&
      compactControlText(structural) === compactControlText(expectedNormalized);
  }

  function assistantAdvanced(
    expectation: GuardedContinuationExpectation,
    observation: PageObservation,
  ): boolean {
    const latestAssistant = observation.latestAssistant;
    if (latestAssistant === undefined) return false;
    if (expectation.assistantDomMessageId !== undefined && latestAssistant.domMessageId !== undefined) {
      return latestAssistant.domMessageId !== expectation.assistantDomMessageId;
    }
    return latestAssistant.fingerprint !== expectation.assistantFingerprint;
  }

  async function repairHiddenTerminalStatus(observation: PageObservation): Promise<PageObservation> {
    if (currentDocument()?.visibilityState !== "hidden") return observation;
    const assistant = latestAssistantElement();
    if (assistant === undefined || markerIsInsideCode(assistant)) return observation;

    const structural = hiddenStructuralText(assistant);
    if (
      structural.length === 0 ||
      !structural.includes(GUARDIAN_STATUS_PREFIX) ||
      observation.latestAssistant?.normalizedText.includes(GUARDIAN_STATUS_PREFIX) === true
    ) return observation;

    const domMessageId = readMessageId(assistant);
    observation.latestAssistant = {
      normalizedText: structural.slice(-MAX_NORMALIZED_RESPONSE_CHARS),
      textLength: structural.length,
      fingerprint: await fingerprintText(structural),
      ...(domMessageId === undefined ? {} : { domMessageId }),
    };
    return observation;
  }

  BrowserChatGPTAdapter.prototype.observe = async function (observedAt = Date.now()): Promise<PageObservation> {
    const observation = await originalObserve.call(this, observedAt);
    return repairHiddenTerminalStatus(observation);
  };

  // Fast or background responses can complete without the transient Stop control
  // ever being sampled. Reconcile only from a fully completed, identity-bound turn.
  // Hidden tabs additionally use DOM-structural text because Chromium can lag the
  // layout-dependent innerText view even though textContent already contains the
  // committed conversation/status payload.
  BrowserChatGPTAdapter.prototype.guardedSend = async function (
    expectation: GuardedContinuationExpectation,
    humanStateIsCurrent: GuardedHumanStateCheck = () => true,
  ): Promise<PageGuardedSendResult> {
    const result = await originalGuardedSend.call(this, expectation, humanStateIsCurrent);
    if (
      result.status !== "AMBIGUOUS" ||
      result.reason !== AMBIGUOUS_SEND_VERIFICATION_REASON ||
      !humanStateIsCurrent()
    ) return result;

    const observation = await this.observe();
    const assistant = latestAssistantElement();
    const user = assistant === undefined ? undefined : latestUserBefore(assistant);

    // Unit-level reconciliation tests do not install a DOM. Preserve the original
    // observation-only verifier in that environment; production content scripts
    // always have a document and take the stricter DOM-bound path below.
    if (currentDocument() === undefined) {
      if (
        !humanStateIsCurrent() ||
        observation.conversationId !== expectation.conversationId ||
        observation.routeKey !== expectation.routeKey ||
        observation.confidence !== "HIGH" ||
        observation.generation !== "IDLE" ||
        observation.blocking.blocked ||
        observation.latestUser === undefined ||
        normalizeAssistantText(observation.latestUser.normalizedText) !== normalizeAssistantText(expectation.continuationText) ||
        !assistantAdvanced(expectation, observation)
      ) return result;
    } else if (
      !humanStateIsCurrent() ||
      observation.conversationId !== expectation.conversationId ||
      observation.routeKey !== expectation.routeKey ||
      observation.confidence !== "HIGH" ||
      observation.generation !== "IDLE" ||
      observation.blocking.blocked ||
      assistant === undefined ||
      user === undefined ||
      !structurallyFollows(user, assistant) ||
      !intendedUserTurnMatches(user, expectation.continuationText) ||
      !assistantAdvanced(expectation, observation)
    ) return result;

    return {
      decisionId: expectation.decisionId,
      status: "VERIFIED",
      reason: currentDocument()?.visibilityState === "hidden"
        ? "Intended user turn and a fresh assistant response were verified from background-safe DOM evidence."
        : "Intended user turn and a fresh assistant response were verified after a brief generation window.",
      observedConversationId: expectation.conversationId,
      observedAssistantFingerprint: expectation.assistantFingerprint,
    };
  };
}
