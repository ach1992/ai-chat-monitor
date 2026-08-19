import type { ClassificationResult } from "../classification/types.js";
import type { SessionView } from "../core/session-registry.js";
import type { AutomationPolicyRepository } from "./policy.js";
import type { AutomationWriteJournal } from "./journal.js";
import type {
  AutomationDecisionEnvelope,
  AutomationRuntimeStatus,
  GuardedSendResult,
  ResolvedAutomationPolicy,
} from "./types.js";

export interface AutomationClassifier {
  classify(input: { turns: Array<{ role: "user" | "assistant"; content: string }> }): Promise<ClassificationResult>;
}

export interface AutomationSessionSource {
  getTab(tabId: number): SessionView | undefined;
}

export interface AutomationGuardedSender {
  send(envelope: AutomationDecisionEnvelope): Promise<GuardedSendResult>;
}

export interface AutomationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutomationCoordinatorOptions {
  policies: AutomationPolicyRepository;
  journal: AutomationWriteJournal;
  classifier: AutomationClassifier;
  sessions: AutomationSessionSource;
  sender: AutomationGuardedSender;
  onStatusChange?: (status: AutomationRuntimeStatus) => void;
  clock?: AutomationClock;
  createDecisionId?: () => string;
}

interface RuntimeEntry {
  token: number;
  timer?: unknown;
  evidenceKey?: string;
  suppressedFingerprint?: string;
  status: AutomationRuntimeStatus;
}

interface CandidateEvidence {
  session: SessionView;
  policy: ResolvedAutomationPolicy;
  conversationId: string;
  fingerprint: string;
  domMessageId?: string;
  evidenceKey: string;
}

const DEFAULT_DECISION_TTL_MS = 90_000;

const systemClock: AutomationClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function optionalEqual<T>(left: T | undefined, right: T | undefined): boolean {
  return left === right;
}

function cloneStatus(status: AutomationRuntimeStatus): AutomationRuntimeStatus {
  return structuredClone(status);
}

export class AutomationCoordinator {
  readonly #policies: AutomationPolicyRepository;
  readonly #journal: AutomationWriteJournal;
  readonly #classifier: AutomationClassifier;
  readonly #sessions: AutomationSessionSource;
  readonly #sender: AutomationGuardedSender;
  readonly #onStatusChange: ((status: AutomationRuntimeStatus) => void) | undefined;
  readonly #clock: AutomationClock;
  readonly #createDecisionId: () => string;
  readonly #runtime = new Map<number, RuntimeEntry>();

  constructor(options: AutomationCoordinatorOptions) {
    this.#policies = options.policies;
    this.#journal = options.journal;
    this.#classifier = options.classifier;
    this.#sessions = options.sessions;
    this.#sender = options.sender;
    this.#onStatusChange = options.onStatusChange;
    this.#clock = options.clock ?? systemClock;
    this.#createDecisionId = options.createDecisionId ?? (() => crypto.randomUUID());
  }

  status(tabId: number): AutomationRuntimeStatus | undefined {
    const runtime = this.#runtime.get(tabId);
    return runtime === undefined ? undefined : cloneStatus(runtime.status);
  }

  statuses(): AutomationRuntimeStatus[] {
    return [...this.#runtime.values()].map((runtime) => cloneStatus(runtime.status));
  }

  handleSession(session: SessionView): void {
    const policy = session.conversationId === undefined ? undefined : this.#policies.resolve(session.conversationId);
    const observation = session.observation;
    const fingerprint = observation?.latestAssistant?.fingerprint;
    const existing = this.#runtime.get(session.tabId);

    if (session.conversationId === undefined || observation === undefined || fingerprint === undefined) {
      this.#replaceRuntime(session.tabId, {
        mode: policy?.mode ?? "OFF",
        phase: policy?.mode === "OFF" ? "DISABLED" : "IDLE",
        ...(session.conversationId === undefined ? {} : { conversationId: session.conversationId }),
        ...(policy === undefined ? {} : { policyRevision: policy.revision }),
        reason: "No stable assistant response is available for automation.",
      });
      return;
    }

    if (policy === undefined || policy.mode === "OFF") {
      this.#replaceRuntime(session.tabId, {
        mode: "OFF",
        phase: "DISABLED",
        conversationId: session.conversationId,
        ...(policy === undefined ? {} : { policyRevision: policy.revision }),
        assistantFingerprint: fingerprint,
        reason: "This conversation is not enabled for supervision.",
      });
      return;
    }

    if (policy.mode === "NOTIFY_ONLY") {
      this.#replaceRuntime(session.tabId, {
        mode: policy.mode,
        phase: "OBSERVING",
        conversationId: session.conversationId,
        policyRevision: policy.revision,
        assistantFingerprint: fingerprint,
        reason: "Notification-only mode cannot enter an automatic send state.",
      });
      return;
    }

    if (policy.mode === "AUTO" && policy.emergencyPaused) {
      this.#replaceRuntime(session.tabId, {
        mode: policy.mode,
        phase: "PAUSED",
        conversationId: session.conversationId,
        policyRevision: policy.revision,
        assistantFingerprint: fingerprint,
        reason: "Global emergency pause is active.",
      });
      return;
    }

    if (
      policy.mode === "AUTO" &&
      existing?.status.cooldownUntil !== undefined &&
      this.#clock.now() < existing.status.cooldownUntil
    ) {
      this.#setStatus(existing, {
        mode: "AUTO",
        phase: "COOLDOWN",
        conversationId: session.conversationId,
        policyRevision: policy.revision,
        assistantFingerprint: fingerprint,
        ...(existing.status.lastDecision === undefined ? {} : { lastDecision: existing.status.lastDecision }),
        ...(existing.status.decisionId === undefined ? {} : { decisionId: existing.status.decisionId }),
        cooldownUntil: existing.status.cooldownUntil,
        reason: "Post-send cooldown is active.",
      });
      return;
    }

    if (
      existing?.status.conversationId === session.conversationId &&
      existing.suppressedFingerprint === fingerprint &&
      existing.status.policyRevision === policy.revision
    ) {
      this.#setStatus(existing, {
        mode: policy.mode,
        phase: "HOLD",
        conversationId: session.conversationId,
        policyRevision: policy.revision,
        assistantFingerprint: fingerprint,
        reason: "Human or stale-state interaction suppressed automation for this response.",
      });
      return;
    }

    if (!this.#candidateUiIsSafe(session)) {
      this.#replaceRuntime(session.tabId, {
        mode: policy.mode,
        phase: "HOLD",
        conversationId: session.conversationId,
        policyRevision: policy.revision,
        assistantFingerprint: fingerprint,
        reason: "Current page/composer state is not safe for continuation evaluation.",
      });
      return;
    }

    if (policy.mode === "AUTO") {
      if (session.controlEligibility !== "OWNER") {
        this.#replaceRuntime(session.tabId, {
          mode: policy.mode,
          phase: "HOLD",
          conversationId: session.conversationId,
          policyRevision: policy.revision,
          assistantFingerprint: fingerprint,
          reason: "This tab does not own automatic control for the conversation.",
        });
        return;
      }
      if (this.#journal.hasGuard(session.conversationId, fingerprint)) {
        this.#replaceRuntime(session.tabId, {
          mode: policy.mode,
          phase: "AMBIGUOUS_WRITE",
          conversationId: session.conversationId,
          policyRevision: policy.revision,
          assistantFingerprint: fingerprint,
          reason: "A prior write attempt exists for this assistant response; blind retry is blocked.",
        });
        return;
      }
    }

    const evidence = this.#candidateEvidence(session, policy);
    if (evidence === undefined) return;

    if (existing?.evidenceKey === evidence.evidenceKey) {
      if (
        existing.status.phase === "SETTLING" ||
        existing.status.phase === "EVALUATING" ||
        existing.status.phase === "WAITING_TO_CONTINUE" ||
        existing.status.phase === "SENDING" ||
        existing.status.phase === "HOLD" ||
        existing.status.phase === "UNSURE" ||
        existing.status.phase === "OBSERVING"
      ) {
        return;
      }
      if (existing.status.phase === "COOLDOWN" && existing.status.cooldownUntil !== undefined) {
        if (this.#clock.now() < existing.status.cooldownUntil) return;
      }
    }

    const runtime = this.#replaceRuntime(session.tabId, {
      mode: policy.mode,
      phase: "SETTLING",
      conversationId: session.conversationId,
      policyRevision: policy.revision,
      assistantFingerprint: fingerprint,
      reason: "Waiting for the assistant response to remain stable.",
    }, evidence.evidenceKey);
    const token = runtime.token;
    runtime.timer = this.#clock.setTimeout(() => {
      runtime.timer = undefined;
      void this.#evaluateAfterSettle(session.tabId, evidence, token);
    }, policy.timing.settleDelayMs);
  }

  handleHumanInteraction(session: SessionView): void {
    const fingerprint = session.observation?.latestAssistant?.fingerprint;
    const policy = session.conversationId === undefined ? undefined : this.#policies.resolve(session.conversationId);
    const runtime = this.#replaceRuntime(session.tabId, {
      mode: policy?.mode ?? "OFF",
      phase: policy?.mode === "OFF" ? "DISABLED" : "HOLD",
      ...(session.conversationId === undefined ? {} : { conversationId: session.conversationId }),
      ...(policy === undefined ? {} : { policyRevision: policy.revision }),
      ...(fingerprint === undefined ? {} : { assistantFingerprint: fingerprint }),
      reason: "Human interaction cancelled pending automation for this response.",
    });
    if (fingerprint !== undefined) runtime.suppressedFingerprint = fingerprint;
  }

  invalidateTab(tabId: number, reason = "Session identity changed; pending automation was cancelled."): void {
    const existing = this.#runtime.get(tabId);
    this.#replaceRuntime(tabId, {
      mode: existing?.status.mode ?? "OFF",
      phase: existing?.status.mode === "OFF" ? "DISABLED" : "IDLE",
      reason,
    });
  }

  invalidateConversation(conversationId: string, reason = "Conversation policy changed; pending automation was cancelled."): void {
    for (const [tabId, runtime] of this.#runtime.entries()) {
      if (runtime.status.conversationId !== conversationId) continue;
      const policy = this.#policies.resolve(conversationId);
      this.#replaceRuntime(tabId, {
        mode: policy.mode,
        phase: policy.emergencyPaused && policy.mode === "AUTO" ? "PAUSED" : policy.mode === "OFF" ? "DISABLED" : "IDLE",
        conversationId,
        policyRevision: policy.revision,
        reason,
      });
    }
  }

  emergencyPauseChanged(): void {
    for (const [tabId, runtime] of this.#runtime.entries()) {
      const conversationId = runtime.status.conversationId;
      if (conversationId === undefined) continue;
      const policy = this.#policies.resolve(conversationId);
      this.#replaceRuntime(tabId, {
        mode: policy.mode,
        phase: policy.emergencyPaused && policy.mode === "AUTO" ? "PAUSED" : policy.mode === "OFF" ? "DISABLED" : "IDLE",
        conversationId,
        policyRevision: policy.revision,
        reason: policy.emergencyPaused ? "Global emergency pause is active." : "Emergency pause changed; fresh observation is required.",
      });
    }
  }

  async #evaluateAfterSettle(tabId: number, evidence: CandidateEvidence, token: number): Promise<void> {
    const runtime = this.#runtime.get(tabId);
    if (runtime === undefined || runtime.token !== token) return;
    const fresh = this.#revalidateEvidence(evidence);
    if (fresh === undefined) {
      this.#staleRuntime(runtime, evidence, "Settle evidence became stale before classification.");
      return;
    }

    this.#setStatus(runtime, {
      mode: fresh.policy.mode,
      phase: "EVALUATING",
      conversationId: fresh.conversationId,
      policyRevision: fresh.policy.revision,
      assistantFingerprint: fresh.fingerprint,
      reason: "Classifying the stabilized assistant response.",
    });

    let classification: ClassificationResult;
    try {
      const observation = fresh.session.observation;
      const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
      const latestUser = observation?.latestUser?.normalizedText;
      if (latestUser !== undefined && latestUser.length > 0) turns.push({ role: "user", content: latestUser });
      turns.push({ role: "assistant", content: observation?.latestAssistant?.normalizedText ?? "" });
      classification = await this.#classifier.classify({ turns });
    } catch {
      classification = {
        decision: "UNSURE",
        reasonCode: "PROVIDER_FAILURE",
        reason: "Classifier execution failed.",
        source: "SYSTEM",
      };
    }

    const currentRuntime = this.#runtime.get(tabId);
    if (currentRuntime === undefined || currentRuntime.token !== token) return;
    const postClassification = this.#revalidateEvidence(evidence);
    if (postClassification === undefined) {
      this.#staleRuntime(currentRuntime, evidence, "Classification result arrived after the bound evidence changed.");
      return;
    }

    if (classification.decision === "HOLD") {
      this.#setStatus(currentRuntime, {
        mode: postClassification.policy.mode,
        phase: "HOLD",
        conversationId: postClassification.conversationId,
        policyRevision: postClassification.policy.revision,
        assistantFingerprint: postClassification.fingerprint,
        lastDecision: classification,
        reason: classification.reason,
      });
      return;
    }
    if (classification.decision !== "CONTINUE") {
      this.#setStatus(currentRuntime, {
        mode: postClassification.policy.mode,
        phase: "UNSURE",
        conversationId: postClassification.conversationId,
        policyRevision: postClassification.policy.revision,
        assistantFingerprint: postClassification.fingerprint,
        lastDecision: classification,
        reason: classification.reason,
      });
      return;
    }

    if (postClassification.policy.mode !== "AUTO") {
      this.#setStatus(currentRuntime, {
        mode: postClassification.policy.mode,
        phase: "OBSERVING",
        conversationId: postClassification.conversationId,
        policyRevision: postClassification.policy.revision,
        assistantFingerprint: postClassification.fingerprint,
        lastDecision: classification,
        reason: "CONTINUE was observed, but this mode cannot send automatically.",
      });
      return;
    }

    const createdAt = this.#clock.now();
    const envelope: AutomationDecisionEnvelope = {
      decisionId: this.#createDecisionId(),
      tabId: postClassification.session.tabId,
      documentId: postClassification.session.documentId,
      agentInstanceId: postClassification.session.agentInstanceId,
      pageEpoch: postClassification.session.pageEpoch,
      conversationId: postClassification.conversationId,
      routeKey: postClassification.session.routeKey,
      assistantFingerprint: postClassification.fingerprint,
      ...(postClassification.domMessageId === undefined ? {} : { assistantDomMessageId: postClassification.domMessageId }),
      ...(postClassification.session.lastUserInteractionAt === undefined ? {} : { lastUserInteractionAt: postClassification.session.lastUserInteractionAt }),
      policyRevision: postClassification.policy.revision,
      evidenceKey: postClassification.evidenceKey,
      classification,
      continuationText: postClassification.policy.continuationText,
      createdAt,
      expiresAt: createdAt + Math.max(DEFAULT_DECISION_TTL_MS, postClassification.policy.timing.continueDelayMs + 15_000),
    };

    this.#setStatus(currentRuntime, {
      mode: "AUTO",
      phase: "WAITING_TO_CONTINUE",
      conversationId: envelope.conversationId,
      policyRevision: envelope.policyRevision,
      assistantFingerprint: envelope.assistantFingerprint,
      lastDecision: classification,
      decisionId: envelope.decisionId,
      reason: "Waiting before guarded continuation.",
    });
    currentRuntime.timer = this.#clock.setTimeout(() => {
      currentRuntime.timer = undefined;
      void this.#attemptGuardedSend(envelope, token);
    }, postClassification.policy.timing.continueDelayMs);
  }

  async #attemptGuardedSend(envelope: AutomationDecisionEnvelope, token: number): Promise<void> {
    const runtime = this.#runtime.get(envelope.tabId);
    if (runtime === undefined || runtime.token !== token) return;
    const fresh = this.#revalidateEnvelope(envelope);
    if (fresh === undefined) {
      runtime.suppressedFingerprint = envelope.assistantFingerprint;
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "HOLD",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        lastDecision: envelope.classification,
        decisionId: envelope.decisionId,
        reason: "Final pre-send revalidation rejected stale or unsafe evidence.",
      });
      return;
    }

    let reserved: boolean;
    try {
      reserved = await this.#journal.reserve(envelope);
    } catch {
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "UNSURE",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        lastDecision: envelope.classification,
        decisionId: envelope.decisionId,
        reason: "Write-attempt journal could not be persisted; send was blocked.",
      });
      return;
    }
    if (!reserved) {
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "AMBIGUOUS_WRITE",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        lastDecision: envelope.classification,
        decisionId: envelope.decisionId,
        reason: "A write guard already exists for this response; blind retry is blocked.",
      });
      return;
    }

    if (runtime.token !== token || this.#revalidateEnvelope(envelope) === undefined) {
      try {
        await this.#journal.releaseNotStarted(envelope.decisionId);
      } catch {
        if (runtime.token === token) {
          this.#setStatus(runtime, {
            mode: "AUTO",
            phase: "AMBIGUOUS_WRITE",
            conversationId: envelope.conversationId,
            policyRevision: envelope.policyRevision,
            assistantFingerprint: envelope.assistantFingerprint,
            decisionId: envelope.decisionId,
            reason: "Pre-send state became stale after reservation and the write guard could not be reconciled.",
          });
        }
        return;
      }
      if (runtime.token === token) {
        runtime.suppressedFingerprint = envelope.assistantFingerprint;
        this.#setStatus(runtime, {
          mode: "AUTO",
          phase: "HOLD",
          conversationId: envelope.conversationId,
          policyRevision: envelope.policyRevision,
          assistantFingerprint: envelope.assistantFingerprint,
          decisionId: envelope.decisionId,
          reason: "Pre-send state became stale after reservation; no page mutation was attempted.",
        });
      }
      return;
    }

    this.#setStatus(runtime, {
      mode: "AUTO",
      phase: "SENDING",
      conversationId: envelope.conversationId,
      policyRevision: envelope.policyRevision,
      assistantFingerprint: envelope.assistantFingerprint,
      lastDecision: envelope.classification,
      decisionId: envelope.decisionId,
      reason: "The content agent is performing final DOM revalidation and guarded send.",
    });

    let result: GuardedSendResult;
    try {
      result = await this.#sender.send(envelope);
    } catch {
      try { await this.#journal.mark(envelope.decisionId, "AMBIGUOUS"); } catch { /* persisted ATTEMPTED remains a guard */ }
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "AMBIGUOUS_WRITE",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        lastDecision: envelope.classification,
        decisionId: envelope.decisionId,
        reason: "Guarded send outcome was unavailable; blind retry is blocked.",
      });
      return;
    }

    if (runtime.token !== token) return;
    if (result.decisionId !== envelope.decisionId) {
      try { await this.#journal.mark(envelope.decisionId, "AMBIGUOUS"); } catch { /* ATTEMPTED remains a guard */ }
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "AMBIGUOUS_WRITE",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        decisionId: envelope.decisionId,
        reason: "Guarded send response did not match the reserved decision id.",
      });
      return;
    }

    if (result.status === "NOT_STARTED") {
      try {
        await this.#journal.releaseNotStarted(envelope.decisionId);
      } catch {
        this.#setStatus(runtime, {
          mode: "AUTO",
          phase: "AMBIGUOUS_WRITE",
          conversationId: envelope.conversationId,
          policyRevision: envelope.policyRevision,
          assistantFingerprint: envelope.assistantFingerprint,
          decisionId: envelope.decisionId,
          reason: "Send was rejected before mutation, but the write guard could not be reconciled.",
        });
        return;
      }
      runtime.suppressedFingerprint = envelope.assistantFingerprint;
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "HOLD",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        decisionId: envelope.decisionId,
        reason: result.reason,
      });
      return;
    }

    if (
      result.status === "VERIFIED" &&
      (result.observedConversationId !== envelope.conversationId || result.observedAssistantFingerprint !== envelope.assistantFingerprint)
    ) {
      try { await this.#journal.mark(envelope.decisionId, "AMBIGUOUS"); } catch { /* ATTEMPTED remains a guard */ }
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "AMBIGUOUS_WRITE",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        decisionId: envelope.decisionId,
        reason: "Verified send response did not echo the exact conversation/message identity.",
      });
      return;
    }

    if (result.status === "AMBIGUOUS") {
      try { await this.#journal.mark(envelope.decisionId, "AMBIGUOUS"); } catch { /* ATTEMPTED remains a conservative no-retry guard */ }
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "AMBIGUOUS_WRITE",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        decisionId: envelope.decisionId,
        reason: result.reason,
      });
      return;
    }

    try {
      await this.#journal.mark(envelope.decisionId, "VERIFIED");
    } catch {
      this.#setStatus(runtime, {
        mode: "AUTO",
        phase: "AMBIGUOUS_WRITE",
        conversationId: envelope.conversationId,
        policyRevision: envelope.policyRevision,
        assistantFingerprint: envelope.assistantFingerprint,
        decisionId: envelope.decisionId,
        reason: "Send was verified by the page, but write-journal reconciliation failed.",
      });
      return;
    }

    const cooldownUntil = this.#clock.now() + fresh.policy.timing.cooldownMs;
    this.#setStatus(runtime, {
      mode: "AUTO",
      phase: "COOLDOWN",
      conversationId: envelope.conversationId,
      policyRevision: envelope.policyRevision,
      assistantFingerprint: envelope.assistantFingerprint,
      lastDecision: envelope.classification,
      decisionId: envelope.decisionId,
      cooldownUntil,
      reason: "Continuation send was verified; cooldown is active.",
    });
    runtime.timer = this.#clock.setTimeout(() => {
      runtime.timer = undefined;
      if (runtime.token !== token) return;
      const session = this.#sessions.getTab(envelope.tabId);
      if (session !== undefined) this.handleSession(session);
    }, fresh.policy.timing.cooldownMs);
  }

  #candidateUiIsSafe(session: SessionView): boolean {
    const observation = session.observation;
    return (
      observation !== undefined &&
      observation.confidence === "HIGH" &&
      observation.generation === "IDLE" &&
      observation.blocking.blocked === false &&
      observation.composer.present === true &&
      observation.composer.hasText === false &&
      observation.composer.focused === false &&
      observation.latestAssistant !== undefined &&
      observation.latestAssistant.normalizedText.length > 0
    );
  }

  #candidateEvidence(session: SessionView, policy: ResolvedAutomationPolicy): CandidateEvidence | undefined {
    const observation = session.observation;
    const assistant = observation?.latestAssistant;
    const conversationId = session.conversationId;
    if (assistant === undefined || conversationId === undefined) return undefined;
    const latestUser = observation?.latestUser;
    const evidenceKey = JSON.stringify([
      session.tabId,
      session.documentId,
      session.agentInstanceId,
      session.pageEpoch,
      conversationId,
      session.routeKey,
      latestUser?.domMessageId ?? null,
      latestUser?.normalizedText ?? null,
      assistant.fingerprint,
      assistant.domMessageId ?? null,
      session.lastUserInteractionAt ?? null,
      policy.revision,
      policy.mode,
    ]);
    return {
      session,
      policy,
      conversationId,
      fingerprint: assistant.fingerprint,
      ...(assistant.domMessageId === undefined ? {} : { domMessageId: assistant.domMessageId }),
      evidenceKey,
    };
  }

  #revalidateEvidence(evidence: CandidateEvidence): CandidateEvidence | undefined {
    const fresh = this.#sessions.getTab(evidence.session.tabId);
    if (fresh === undefined || fresh.conversationId === undefined || !this.#candidateUiIsSafe(fresh)) return undefined;
    const policy = this.#policies.resolve(fresh.conversationId);
    const candidate = this.#candidateEvidence(fresh, policy);
    if (candidate === undefined) return undefined;
    if (candidate.evidenceKey !== evidence.evidenceKey) return undefined;
    if (policy.mode === "AUTO" && (policy.emergencyPaused || fresh.controlEligibility !== "OWNER")) return undefined;
    return candidate;
  }

  #revalidateEnvelope(envelope: AutomationDecisionEnvelope): CandidateEvidence | undefined {
    if (this.#clock.now() > envelope.expiresAt) return undefined;
    if (envelope.classification.decision !== "CONTINUE") return undefined;
    const fresh = this.#sessions.getTab(envelope.tabId);
    if (fresh === undefined || fresh.conversationId !== envelope.conversationId || !this.#candidateUiIsSafe(fresh)) return undefined;
    if (
      fresh.documentId !== envelope.documentId ||
      fresh.agentInstanceId !== envelope.agentInstanceId ||
      fresh.pageEpoch !== envelope.pageEpoch ||
      fresh.routeKey !== envelope.routeKey ||
      fresh.controlEligibility !== "OWNER" ||
      !optionalEqual(fresh.lastUserInteractionAt, envelope.lastUserInteractionAt)
    ) return undefined;
    const assistant = fresh.observation?.latestAssistant;
    if (
      assistant === undefined ||
      assistant.fingerprint !== envelope.assistantFingerprint ||
      (envelope.assistantDomMessageId !== undefined && assistant.domMessageId !== envelope.assistantDomMessageId)
    ) return undefined;
    const policy = this.#policies.resolve(envelope.conversationId);
    if (
      policy.revision !== envelope.policyRevision ||
      policy.mode !== "AUTO" ||
      policy.emergencyPaused ||
      policy.continuationText !== envelope.continuationText
    ) return undefined;
    const candidate = this.#candidateEvidence(fresh, policy);
    return candidate?.evidenceKey === envelope.evidenceKey ? candidate : undefined;
  }

  #staleRuntime(runtime: RuntimeEntry, evidence: CandidateEvidence, reason: string): void {
    runtime.suppressedFingerprint = evidence.fingerprint;
    this.#setStatus(runtime, {
      mode: evidence.policy.mode,
      phase: "HOLD",
      conversationId: evidence.conversationId,
      policyRevision: evidence.policy.revision,
      assistantFingerprint: evidence.fingerprint,
      reason,
    });
  }

  #replaceRuntime(
    tabId: number,
    status: Omit<AutomationRuntimeStatus, "tabId" | "updatedAt">,
    evidenceKey?: string,
  ): RuntimeEntry {
    const existing = this.#runtime.get(tabId);
    if (existing?.timer !== undefined) this.#clock.clearTimeout(existing.timer);
    const runtime: RuntimeEntry = {
      token: (existing?.token ?? 0) + 1,
      ...(evidenceKey === undefined ? {} : { evidenceKey }),
      ...(existing?.suppressedFingerprint === undefined ? {} : { suppressedFingerprint: existing.suppressedFingerprint }),
      status: { tabId, updatedAt: this.#clock.now(), ...status },
    };
    this.#runtime.set(tabId, runtime);
    this.#emitStatus(runtime.status);
    return runtime;
  }

  #setStatus(runtime: RuntimeEntry, status: Omit<AutomationRuntimeStatus, "tabId" | "updatedAt">): void {
    runtime.status = { tabId: runtime.status.tabId, updatedAt: this.#clock.now(), ...status };
    this.#emitStatus(runtime.status);
  }

  #emitStatus(status: AutomationRuntimeStatus): void {
    if (this.#onStatusChange === undefined) return;
    try {
      this.#onStatusChange(cloneStatus(status));
    } catch {
      // Observability must never influence automation decisions or page mutation.
    }
  }
}
