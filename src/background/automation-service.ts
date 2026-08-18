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

  async updateChat(tabId: number, patch: ChatAutomationPolicyPatch): Promise<ResolvedAutomationPolicy> {
    await this.#ready;
    const session = this.#getSession(tabId);
    if (session?.conversationId === undefined) throw new Error("Tab has no current conversation identity.");
    const policy = await this.#policies.updateChat(session.conversationId, patch);
    this.#coordinator.invalidateConversation(session.conversationId);
    const fresh = this.#getSession(tabId);
    if (fresh !== undefined) this.#coordinator.handleSession(fresh);
    return policy;
  }

  async updateDefaults(patch: Partial<AutomationPolicyDefaults>): Promise<AutomationPolicyState> {
    await this.#ready;
    const state = await this.#policies.updateDefaults(patch);
    this.#invalidateAll("Global automation defaults changed; pending decisions were cancelled.");
    return state;
  }

  async setEmergencyPaused(paused: boolean): Promise<AutomationPolicyState> {
    await this.#ready;
    const state = await this.#policies.setEmergencyPaused(paused);
    this.#coordinator.emergencyPauseChanged();
    return state;
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
}
