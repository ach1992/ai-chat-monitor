import { AutomationCoordinator } from "../automation/coordinator.js";
import { AutomationWriteJournal, type AutomationWriteJournalState } from "../automation/journal.js";
import {
  AutomationPolicyRepository,
  type AutomationPolicyDefaults,
  type AutomationPolicyState,
  type ChatAutomationPolicyPatch,
} from "../automation/policy.js";
import { isGuardedSendResult, type AutomationRuntimeStatus, type GuardedSendResult, type ResolvedAutomationPolicy } from "../automation/types.js";
import { ConservativeStopClassifier } from "../classification/classifier.js";
import type { SessionView } from "../core/session-registry.js";
import { createProviderManager } from "../providers/manager.js";
import { ProviderSettingsStore } from "../providers/settings-store.js";
import type { ProviderProfile, ProviderSettingsState } from "../providers/types.js";
import { AuditHistoryRepository, type AuditEvent, type AuditHistoryState } from "../reliability/audit.js";
import { evaluateProgressSafety, outcomeSignature } from "../reliability/progress.js";
import { ReliabilityService, type ReliabilityRuntimeState } from "../reliability/service.js";
import { createDurableStorage, createEphemeralStorage } from "../storage/index.js";

const POLICY_KEY = "config";
const JOURNAL_KEY = "runtime";
const AUDIT_KEY = "events";
const RELIABILITY_KEY = "runtime";

export interface AutomationServiceStatus {
  policy?: ResolvedAutomationPolicy;
  runtime?: AutomationRuntimeStatus;
}

export class AutomationService {
  readonly #policies: AutomationPolicyRepository;
  readonly #journal: AutomationWriteJournal;
  readonly #reliability: ReliabilityService;
  readonly #coordinator: AutomationCoordinator;
  readonly #getSession: (tabId: number) => SessionView | undefined;
  readonly #providerSettings = new ProviderSettingsStore();
  readonly #ready: Promise<void>;
  #policyWritesInFlight = 0;

  constructor(
    getSession: (tabId: number) => SessionView | undefined,
    durableStorageReady: Promise<unknown> = Promise.resolve(),
  ) {
    this.#getSession = getSession;
    const policyStorage = createDurableStorage<AutomationPolicyState>("automation-policy");
    const journalStorage = createEphemeralStorage<AutomationWriteJournalState>("automation-write-journal");
    const auditStorage = createDurableStorage<AuditHistoryState>("audit-history");
    const reliabilityStorage = createEphemeralStorage<ReliabilityRuntimeState>("reliability-runtime");

    this.#policies = new AutomationPolicyRepository({
      load: () => policyStorage.get(POLICY_KEY),
      save: (state) => policyStorage.set(POLICY_KEY, state),
    });
    this.#journal = new AutomationWriteJournal({
      load: () => journalStorage.get(JOURNAL_KEY),
      save: (state) => journalStorage.set(JOURNAL_KEY, state),
    });
    const audit = new AuditHistoryRepository({
      load: () => auditStorage.get(AUDIT_KEY),
      save: (state) => auditStorage.set(AUDIT_KEY, state),
    });
    this.#reliability = new ReliabilityService({
      audit,
      runtimePersistence: {
        load: () => reliabilityStorage.get(RELIABILITY_KEY),
        save: (state) => reliabilityStorage.set(RELIABILITY_KEY, state),
      },
      resolvePolicy: (conversationId) => this.#policies.resolve(conversationId),
      notify: (notification) => ReliabilityService.browserNotify(notification),
    });

    this.#coordinator = new AutomationCoordinator({
      policies: this.#policies,
      journal: this.#journal,
      sessions: { getTab: (tabId) => this.#getSession(tabId) },
      onStatusChange: (status) => this.#reliability.captureRuntime(status),
      classifier: {
        classify: async (input) => {
          const settings = await this.#providerSettings.load();
          const providers = settings.order.length === 0 ? undefined : createProviderManager(settings);
          return new ConservativeStopClassifier(providers).classify(input);
        },
      },
      sender: {
        send: async (envelope): Promise<GuardedSendResult> => {
          const reliabilityBlock = await this.#guardContinuation(envelope);
          if (reliabilityBlock !== undefined) return reliabilityBlock;
          const response = await chrome.tabs.sendMessage<unknown>(
            envelope.tabId,
            {
              type: "background:guarded-send",
              protocolVersion: 2,
              decisionId: envelope.decisionId,
              agentInstanceId: envelope.agentInstanceId,
              pageEpoch: envelope.pageEpoch,
              conversationId: envelope.conversationId,
              routeKey: envelope.routeKey,
              assistantFingerprint: envelope.assistantFingerprint,
              ...(envelope.assistantDomMessageId === undefined ? {} : { assistantDomMessageId: envelope.assistantDomMessageId }),
              continuationText: envelope.continuationText,
              expiresAt: envelope.expiresAt,
            },
            { documentId: envelope.documentId },
          );
          if (!isGuardedSendResult(response)) throw new Error("Content agent returned an invalid guarded-send result.");
          return response;
        },
      },
    });
    this.#ready = durableStorageReady.then(async () => {
      await Promise.all([
        this.#policies.restore(),
        this.#journal.restore(),
        this.#reliability.restore(),
      ]);
    });
  }

  ready(): Promise<void> { return this.#ready; }

  async handleSession(session: SessionView): Promise<void> {
    await this.#ready;
    if (this.#policyWritesInFlight > 0) {
      this.#coordinator.invalidateTab(
        session.tabId,
        "Automation policy persistence is in progress; fresh observation is required after it completes.",
      );
      return;
    }
    this.#coordinator.handleSession(session);
    this.#reliability.captureSession(session);
  }

  async handleHumanInteraction(session: SessionView): Promise<void> {
    await this.#ready;
    this.#coordinator.handleHumanInteraction(session);
  }

  async invalidateTab(tabId: number, reason?: string): Promise<void> {
    await this.#ready;
    this.#coordinator.invalidateTab(tabId, reason);
  }

  async updateChat(
    tabId: number,
    expectedConversationId: string,
    patch: ChatAutomationPolicyPatch,
  ): Promise<ResolvedAutomationPolicy> {
    await this.#ready;
    const session = this.#getSession(tabId);
    if (session?.conversationId !== expectedConversationId) {
      throw new Error("Tab conversation identity changed before the policy update.");
    }
    const policy = await this.#withPolicyWrite(async () => {
      this.#coordinator.invalidateConversation(
        expectedConversationId,
        "Policy update requested; pending automation was cancelled before persistence.",
      );
      return this.#policies.updateChat(expectedConversationId, patch);
    });
    this.#rehydrateKnownSessions();
    return policy;
  }

  async updateDefaults(patch: Partial<AutomationPolicyDefaults>): Promise<AutomationPolicyState> {
    await this.#ready;
    const state = await this.#withPolicyWrite(async () => {
      this.#invalidateAll("Global automation defaults update requested; pending decisions were cancelled before persistence.");
      return this.#policies.updateDefaults(patch);
    });
    this.#rehydrateKnownSessions();
    return state;
  }

  async setEmergencyPaused(paused: boolean): Promise<AutomationPolicyState> {
    await this.#ready;
    const state = await this.#withPolicyWrite(async () => {
      this.#invalidateAll("Emergency-pause change requested; pending decisions were cancelled before persistence.");
      return this.#policies.setEmergencyPaused(paused);
    });
    if (this.#policyWritesInFlight === 0) this.#coordinator.emergencyPauseChanged();
    this.#rehydrateKnownSessions();
    return state;
  }

  async providerSettings(): Promise<ProviderSettingsState> {
    await this.#ready;
    return this.#providerSettings.load();
  }

  async upsertProviderProfile(profile: ProviderProfile, makePrimary = false): Promise<ProviderSettingsState> {
    await this.#ready;
    const saved = await this.#withPolicyWrite(async () => {
      this.#invalidateAll("Provider settings changed; pending classifier decisions were cancelled before persistence.");
      const current = await this.#providerSettings.load();
      const profiles = current.profiles.filter((candidate) => candidate.id !== profile.id);
      profiles.push(profile);
      const wasActive = current.order.includes(profile.id);
      const withoutProfile = current.order.filter((id) => id !== profile.id);
      const order = makePrimary
        ? [profile.id, ...withoutProfile]
        : wasActive
          ? [...current.order]
          : [...withoutProfile, profile.id];
      const next: ProviderSettingsState = { version: 1, profiles, order };
      await this.#providerSettings.save(next);
      return this.#providerSettings.load();
    });
    this.#rehydrateKnownSessions();
    return saved;
  }

  async removeProviderProfile(providerId: string): Promise<ProviderSettingsState> {
    await this.#ready;
    const saved = await this.#withPolicyWrite(async () => {
      this.#invalidateAll("Provider settings changed; pending classifier decisions were cancelled before persistence.");
      const current = await this.#providerSettings.load();
      const next: ProviderSettingsState = {
        version: 1,
        profiles: current.profiles.filter((profile) => profile.id !== providerId),
        order: current.order.filter((id) => id !== providerId),
      };
      await this.#providerSettings.save(next);
      return this.#providerSettings.load();
    });
    this.#rehydrateKnownSessions();
    return saved;
  }

  async updateProviderOrder(order: string[]): Promise<ProviderSettingsState> {
    await this.#ready;
    const saved = await this.#withPolicyWrite(async () => {
      this.#invalidateAll("Provider priority changed; pending classifier decisions were cancelled before persistence.");
      const current = await this.#providerSettings.load();
      const next: ProviderSettingsState = { ...current, order: [...order] };
      await this.#providerSettings.save(next);
      return this.#providerSettings.load();
    });
    this.#rehydrateKnownSessions();
    return saved;
  }

  async status(tabId: number): Promise<AutomationServiceStatus> {
    await this.#ready;
    const session = this.#getSession(tabId);
    const runtime = this.#coordinator.status(tabId);
    return {
      ...(session?.conversationId === undefined ? {} : { policy: this.#policies.resolve(session.conversationId) }),
      ...(runtime === undefined ? {} : { runtime }),
    };
  }

  auditHistory(limit = 80): AuditEvent[] {
    return this.#reliability.history(limit);
  }

  async clearAuditHistory(): Promise<void> {
    await this.#ready;
    await this.#reliability.clearHistory();
  }

  policySnapshot(): AutomationPolicyState { return this.#policies.snapshot(); }

  async #guardContinuation(envelope: Parameters<AutomationCoordinator["status"]>[0] extends never ? never : import("../automation/types.js").AutomationDecisionEnvelope): Promise<GuardedSendResult | undefined> {
    const session = this.#getSession(envelope.tabId);
    const assistant = session?.observation?.latestAssistant;
    if (
      session === undefined ||
      session.conversationId !== envelope.conversationId ||
      session.documentId !== envelope.documentId ||
      session.agentInstanceId !== envelope.agentInstanceId ||
      session.pageEpoch !== envelope.pageEpoch ||
      session.routeKey !== envelope.routeKey ||
      session.controlEligibility !== "OWNER" ||
      assistant?.fingerprint !== envelope.assistantFingerprint
    ) {
      return {
        decisionId: envelope.decisionId,
        status: "NOT_STARTED",
        reason: "Reliability guard could not re-read the exact current chat/message identity.",
      };
    }

    const policy = this.#policies.resolve(envelope.conversationId);
    if (
      policy.revision !== envelope.policyRevision ||
      policy.mode !== "AUTO" ||
      policy.emergencyPaused ||
      policy.continuationText !== envelope.continuationText
    ) {
      return {
        decisionId: envelope.decisionId,
        status: "NOT_STARTED",
        reason: "Reliability guard observed changed automation policy before page mutation.",
      };
    }

    const signature = outcomeSignature(assistant.normalizedText);
    const verified = this.#journal.verifiedSince(envelope.conversationId, session.lastUserInteractionAt ?? 0);
    const progress = evaluateProgressSafety(
      signature,
      verified.flatMap((record) => record.outcomeSignature === undefined ? [] : [record.outcomeSignature]),
      verified.length,
      policy.hardFuseMaxAutoContinues,
    );
    if (progress.hold) {
      const reason = progress.reason === "REPEATED_OUTCOME"
        ? "STAGNATION: recent verified auto-continued assistant outcomes remain materially similar; human review is required."
        : `STAGNATION: hard safety fuse reached ${policy.hardFuseMaxAutoContinues} verified auto-continues since the last human interaction.`;
      return { decisionId: envelope.decisionId, status: "NOT_STARTED", reason };
    }

    try {
      await this.#journal.setOutcomeSignature(envelope.decisionId, signature);
    } catch {
      return {
        decisionId: envelope.decisionId,
        status: "NOT_STARTED",
        reason: "Reliability progress journal could not be persisted; send was blocked before page mutation.",
      };
    }

    const fresh = this.#getSession(envelope.tabId);
    const freshPolicy = this.#policies.resolve(envelope.conversationId);
    if (
      fresh === undefined ||
      fresh.conversationId !== envelope.conversationId ||
      fresh.documentId !== envelope.documentId ||
      fresh.agentInstanceId !== envelope.agentInstanceId ||
      fresh.pageEpoch !== envelope.pageEpoch ||
      fresh.routeKey !== envelope.routeKey ||
      fresh.controlEligibility !== "OWNER" ||
      fresh.observation?.latestAssistant?.fingerprint !== envelope.assistantFingerprint ||
      freshPolicy.revision !== envelope.policyRevision ||
      freshPolicy.mode !== "AUTO" ||
      freshPolicy.emergencyPaused ||
      freshPolicy.continuationText !== envelope.continuationText
    ) {
      return {
        decisionId: envelope.decisionId,
        status: "NOT_STARTED",
        reason: "Reliability guard became stale while persisting progress evidence; no page mutation was attempted.",
      };
    }
    return undefined;
  }

  #invalidateAll(reason: string): void {
    const conversations = new Set(
      this.#coordinator.statuses()
        .map((status) => status.conversationId)
        .filter((value): value is string => value !== undefined),
    );
    for (const conversationId of conversations) this.#coordinator.invalidateConversation(conversationId, reason);
  }

  #rehydrateKnownSessions(): void {
    if (this.#policyWritesInFlight > 0) return;
    const tabIds = new Set(this.#coordinator.statuses().map((status) => status.tabId));
    for (const tabId of tabIds) {
      const session = this.#getSession(tabId);
      if (session !== undefined) {
        this.#coordinator.handleSession(session);
        this.#reliability.captureSession(session);
      }
    }
  }

  async #withPolicyWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.#policyWritesInFlight += 1;
    try {
      return await operation();
    } finally {
      this.#policyWritesInFlight -= 1;
    }
  }
}
