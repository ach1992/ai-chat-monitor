namespace GuardianContent {
  const AMBIGUOUS_SEND_VERIFICATION_REASON = "The intended user turn and generation start could not both be verified.";
  const originalGuardedSend = BrowserChatGPTAdapter.prototype.guardedSend;

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

  // ChatGPT can finish a very fast response between DOM samples. The base guarded
  // send still requires the intended user turn plus a generation signal. If that
  // signal is missed, reconcile only from a fully completed, identity-bound turn:
  // the exact intended user message must precede a fresh assistant response.
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

    return {
      decisionId: expectation.decisionId,
      status: "VERIFIED",
      reason: "Intended user turn and a fresh assistant response were verified after a brief generation window.",
      observedConversationId: expectation.conversationId,
      observedAssistantFingerprint: expectation.assistantFingerprint,
    };
  };
}
