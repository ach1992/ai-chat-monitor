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
import { createDurableStorage, createEphemeralStorage } from "../storage/index.js";

const POLICY_KEY = "config";
const JOURNAL_KEY = "runtime";

export interface AutomationServiceStatus {
  policy?: ResolvedAutomationPolicy;
  runtime?: AutomationRuntimeStatus;
}

export class AutomationService {
  readonly #policies: AutomationPolicyRepository;
  readonly #journal: AutomationWriteJournal;
  readonly #coordinator: AutomationCoordinator;
  readonly #getSession: (tabId: number) => SessionView | undefined;
  readonly #providerSettings = new ProviderSettingsStore();
  readonly #ready: Promise<void>;
  #policyWritesInFlight = 0;

  constructor(getSession: (tabId: number) => SessionView | undefined) {
    this.#getSession = getSession;
    const policyStorage = createDurableStorage<AutomationPolicyState>("automation-policy");
    const journalStorage = createEphemeralStorage<AutomationWriteJournalState>("automation-write-journal");
    this.#policies = new AutomationPolicyRepository({
      load: () => policyStorage.get(POLICY_KEY),
      save: (state) => policyStorage.set(POLICY_KEY, state),
    });
    this.#journal = new AutomationWriteJournal({
      load: () => journalStorage.get(JOURNAL_KEY),
      save: (state) => journalStorage.set(JOURNAL_KEY, state),
    });

    this.#coordinator = new AutomationCoordinator({
      policies: this.#policies,
      journal: this.#journal,
      sessions: { getTab: (tabId) => this.#getSession(tabId) },
      classifier: {
        classify: async (input) => {
          const settings = await this.#providerSettings.load();
          const providers = settings.order.length === 0 ? undefined : createProviderManager(settings);
          return new ConservativeStopClassifier(providers).classify(input);
        },
      },
      sender: {
        send: async (envelope): Promise<GuardedSendResult> => {
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
    this.#ready = Promise.all([this.#policies.restore(), this.#journal.restore()]).then(() => undefined);
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
    return this.#withPolicyWrite(async () => {
      this.#coordinator.invalidateConversation(
        expectedConversationId,
        "Policy update requested; pending automation was cancelled before persistence.",
      );
      const policy = await this.#policies.updateChat(expectedConversationId, patch);
      const fresh = this.#getSession(tabId);
      if (fresh?.conversationId === expectedConversationId) this.#coordinator.handleSession(fresh);
      return policy;
    });
  }

  async updateDefaults(patch: Partial<AutomationPolicyDefaults>): Promise<AutomationPolicyState> {
    await this.#ready;
    return this.#withPolicyWrite(async () => {
      this.#invalidateAll("Global automation defaults update requested; pending decisions were cancelled before persistence.");
      return this.#policies.updateDefaults(patch);
    });
  }

  async setEmergencyPaused(paused: boolean): Promise<AutomationPolicyState> {
    await this.#ready;
    return this.#withPolicyWrite(async () => {
      this.#invalidateAll("Emergency-pause change requested; pending decisions were cancelled before persistence.");
      const state = await this.#policies.setEmergencyPaused(paused);
      this.#coordinator.emergencyPauseChanged();
      return state;
    });
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

  policySnapshot(): AutomationPolicyState {
    return this.#policies.snapshot();
  }

  #invalidateAll(reason: string): void {
    const conversations = new Set(
      this.#coordinator.statuses()
        .map((status) => status.conversationId)
        .filter((value): value is string => value !== undefined),
    );
    for (const conversationId of conversations) this.#coordinator.invalidateConversation(conversationId, reason);
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