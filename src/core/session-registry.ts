import type { GenerationState, PageObservation } from "../shared/observation.js";

export type ControlEligibility = "OWNER" | "MIRROR" | "NONE";

export type SessionEventRejectReason =
  | "NO_SESSION"
  | "STALE_DOCUMENT"
  | "STALE_AGENT"
  | "STALE_EPOCH"
  | "FUTURE_EPOCH"
  | "STALE_SEQUENCE"
  | "IDENTITY_MISMATCH";

export type HiddenMarkerHealth = "DETECTED" | "MISSING" | "MALFORMED";

export interface HiddenMonitoringDiagnosticSnapshot {
  backgroundedAt: number;
  foregroundedAt?: number;
  tabActivatedAt?: number;
  visibleObservedAt?: number;
  baselineAssistantFingerprint?: string;
  baselineAssistantTextLength?: number;
  hiddenObservationCount: number;
  firstHiddenObservationAt?: number;
  lastHiddenObservationAt?: number;
  firstAssistantChangeAt?: number;
  firstMarkerDetectedAt?: number;
  hiddenAssistantTextLength?: number;
  assistantChanged: boolean;
  hiddenGeneration?: GenerationState;
  hiddenStopControlPresent?: boolean;
  hiddenMarkerHealth?: HiddenMarkerHealth;
  transportCompletedAt?: number;
}

export interface ResponseCompletionSnapshot {
  sequence: number;
  completedAt: number;
  visibility: "visible" | "hidden";
  transport: "CHATGPT_CONVERSATION_STREAM";
}

export interface AgentRegistration {
  tabId: number;
  documentId: string;
  agentInstanceId: string;
  pageEpoch: number;
  sequence: number;
  routeKey: string;
  conversationId?: string;
  sentAt: number;
}

export interface NavigationEvent {
  tabId: number;
  documentId: string;
  agentInstanceId: string;
  pageEpoch: number;
  sequence: number;
  routeKey: string;
  conversationId?: string;
  sentAt: number;
}

export interface ObservationEvent {
  tabId: number;
  documentId: string;
  agentInstanceId: string;
  pageEpoch: number;
  sequence: number;
  observation: PageObservation;
  markerHealth?: HiddenMarkerHealth;
  sentAt: number;
}

export interface InteractionEvent {
  tabId: number;
  documentId: string;
  agentInstanceId: string;
  pageEpoch: number;
  sequence: number;
  sentAt: number;
}

export interface ResponseCompletionEvent {
  tabId: number;
  documentId: string;
  agentInstanceId: string;
  pageEpoch: number;
  sequence: number;
  routeKey: string;
  conversationId?: string;
  transport: "CHATGPT_CONVERSATION_STREAM";
  visibility: "visible" | "hidden";
  completedAt: number;
  sentAt: number;
}

export interface SessionSnapshot {
  tabId: number;
  documentId: string;
  agentInstanceId: string;
  pageEpoch: number;
  lastSequence: number;
  routeKey: string;
  conversationId?: string;
  registeredAt: number;
  lastSeenAt: number;
  lastUserInteractionAt?: number;
  observation?: PageObservation;
  lastObservationVisibility?: PageObservation["visibility"];
  lastResponseCompletion?: ResponseCompletionSnapshot;
  hiddenDiagnostic?: HiddenMonitoringDiagnosticSnapshot;
}

export interface SessionView extends SessionSnapshot {
  controlEligibility: ControlEligibility;
}

export interface RetiredDocumentState {
  tabId: number;
  documentIds: string[];
}

export interface SessionRegistryState {
  version: 1;
  sessions: SessionSnapshot[];
  retiredDocuments?: RetiredDocumentState[];
}

export type SessionMutationResult =
  | { accepted: true; session: SessionView }
  | { accepted: false; reason: SessionEventRejectReason };

function optionalStringEquals(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function cloneObservation(observation: PageObservation): PageObservation {
  return structuredClone(observation);
}

function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return structuredClone(snapshot);
}

function validOptionalFinite(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0);
}

function validOptionalFingerprint(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}

function validOptionalGeneration(value: unknown): boolean {
  return value === undefined || value === "IDLE" || value === "GENERATING" || value === "UNKNOWN";
}

function validOptionalVisibility(value: unknown): boolean {
  return value === undefined || value === "visible" || value === "hidden";
}

function validOptionalMarkerHealth(value: unknown): boolean {
  return value === undefined || value === "DETECTED" || value === "MISSING" || value === "MALFORMED";
}

function validHiddenDiagnostic(value: unknown): value is HiddenMonitoringDiagnosticSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HiddenMonitoringDiagnosticSnapshot>;
  return (
    typeof candidate.backgroundedAt === "number" &&
    Number.isFinite(candidate.backgroundedAt) &&
    validOptionalFinite(candidate.foregroundedAt) &&
    validOptionalFinite(candidate.tabActivatedAt) &&
    validOptionalFinite(candidate.visibleObservedAt) &&
    validOptionalFingerprint(candidate.baselineAssistantFingerprint) &&
    validOptionalNonNegativeInteger(candidate.baselineAssistantTextLength) &&
    Number.isInteger(candidate.hiddenObservationCount) &&
    (candidate.hiddenObservationCount as number) >= 0 &&
    validOptionalFinite(candidate.firstHiddenObservationAt) &&
    validOptionalFinite(candidate.lastHiddenObservationAt) &&
    validOptionalFinite(candidate.firstAssistantChangeAt) &&
    validOptionalFinite(candidate.firstMarkerDetectedAt) &&
    validOptionalNonNegativeInteger(candidate.hiddenAssistantTextLength) &&
    typeof candidate.assistantChanged === "boolean" &&
    validOptionalGeneration(candidate.hiddenGeneration) &&
    (candidate.hiddenStopControlPresent === undefined || typeof candidate.hiddenStopControlPresent === "boolean") &&
    validOptionalMarkerHealth(candidate.hiddenMarkerHealth) &&
    validOptionalFinite(candidate.transportCompletedAt)
  );
}

function validResponseCompletion(value: unknown): value is ResponseCompletionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ResponseCompletionSnapshot>;
  return (
    Number.isInteger(candidate.sequence) && (candidate.sequence as number) >= 1 &&
    typeof candidate.completedAt === "number" && Number.isFinite(candidate.completedAt) && candidate.completedAt > 0 &&
    (candidate.visibility === "visible" || candidate.visibility === "hidden") &&
    candidate.transport === "CHATGPT_CONVERSATION_STREAM"
  );
}

function validSnapshot(session: SessionSnapshot): boolean {
  return (
    Number.isInteger(session.tabId) &&
    session.tabId >= 0 &&
    typeof session.documentId === "string" &&
    session.documentId.length > 0 &&
    typeof session.agentInstanceId === "string" &&
    session.agentInstanceId.length > 0 &&
    Number.isInteger(session.pageEpoch) &&
    session.pageEpoch >= 1 &&
    Number.isInteger(session.lastSequence) &&
    session.lastSequence >= 1 &&
    typeof session.routeKey === "string" &&
    session.routeKey.length > 0 &&
    Number.isFinite(session.registeredAt) &&
    Number.isFinite(session.lastSeenAt) &&
    validOptionalVisibility(session.lastObservationVisibility) &&
    (session.lastResponseCompletion === undefined || validResponseCompletion(session.lastResponseCompletion))
  );
}

export class SessionRegistry {
  readonly #sessions = new Map<number, SessionSnapshot>();
  readonly #retiredDocuments = new Map<number, string[]>();

  static fromState(
    state: SessionRegistryState | undefined,
    options: { invalidateObservations?: boolean } = {},
  ): SessionRegistry {
    const registry = new SessionRegistry();
    if (state?.version !== 1 || !Array.isArray(state.sessions)) return registry;

    for (const stored of state.sessions) {
      if (!validSnapshot(stored)) continue;
      const session = cloneSnapshot(stored);
      if (session.hiddenDiagnostic !== undefined && !validHiddenDiagnostic(session.hiddenDiagnostic)) {
        delete session.hiddenDiagnostic;
      }
      if (options.invalidateObservations === true) {
        delete session.observation;
      }
      registry.#sessions.set(session.tabId, session);
    }

    if (Array.isArray(state.retiredDocuments)) {
      for (const retired of state.retiredDocuments) {
        if (!Number.isInteger(retired.tabId) || retired.tabId < 0 || !Array.isArray(retired.documentIds)) continue;
        const documentIds = retired.documentIds
          .filter((documentId): documentId is string => typeof documentId === "string" && documentId.length > 0)
          .slice(-8);
        if (documentIds.length > 0) registry.#retiredDocuments.set(retired.tabId, [...new Set(documentIds)]);
      }
    }

    return registry;
  }

  exportState(): SessionRegistryState {
    const retiredDocuments = [...this.#retiredDocuments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([tabId, documentIds]) => ({ tabId, documentIds: [...documentIds] }));
    return {
      version: 1,
      sessions: [...this.#sessions.values()].map(cloneSnapshot),
      ...(retiredDocuments.length === 0 ? {} : { retiredDocuments }),
    };
  }

  registerAgent(registration: AgentRegistration): SessionMutationResult {
    if (this.#isRetiredDocument(registration.tabId, registration.documentId)) {
      return { accepted: false, reason: "STALE_DOCUMENT" };
    }

    const existing = this.#sessions.get(registration.tabId);
    if (existing !== undefined) {
      const sameDocument = existing.documentId === registration.documentId;
      const sameIdentity = sameDocument && existing.agentInstanceId === registration.agentInstanceId;

      if (sameDocument && !sameIdentity) {
        return { accepted: false, reason: "STALE_AGENT" };
      }
      if (sameIdentity) {
        if (registration.pageEpoch < existing.pageEpoch) {
          return { accepted: false, reason: "STALE_EPOCH" };
        }
        if (registration.sequence <= existing.lastSequence) {
          return { accepted: false, reason: "STALE_SEQUENCE" };
        }
      } else {
        if (registration.sentAt <= existing.lastSeenAt) {
          return { accepted: false, reason: "STALE_DOCUMENT" };
        }
        this.#retireDocument(registration.tabId, existing.documentId);
      }
    }

    const sameDocumentAgent =
      existing?.documentId === registration.documentId &&
      existing.agentInstanceId === registration.agentInstanceId;
    const sameSessionIdentity =
      sameDocumentAgent &&
      existing.pageEpoch === registration.pageEpoch &&
      existing.routeKey === registration.routeKey &&
      optionalStringEquals(existing.conversationId, registration.conversationId);
    const snapshot: SessionSnapshot = {
      tabId: registration.tabId,
      documentId: registration.documentId,
      agentInstanceId: registration.agentInstanceId,
      pageEpoch: registration.pageEpoch,
      lastSequence: registration.sequence,
      routeKey: registration.routeKey,
      registeredAt: sameDocumentAgent ? existing.registeredAt : registration.sentAt,
      lastSeenAt: registration.sentAt,
      ...(registration.conversationId === undefined ? {} : { conversationId: registration.conversationId }),
      ...(sameSessionIdentity && existing.observation !== undefined
        ? { observation: cloneObservation(existing.observation) }
        : {}),
      ...(sameSessionIdentity && existing.lastObservationVisibility !== undefined
        ? { lastObservationVisibility: existing.lastObservationVisibility }
        : {}),
      ...(sameSessionIdentity && existing.lastResponseCompletion !== undefined
        ? { lastResponseCompletion: structuredClone(existing.lastResponseCompletion) }
        : {}),
      ...(sameSessionIdentity && existing.lastUserInteractionAt !== undefined
        ? { lastUserInteractionAt: existing.lastUserInteractionAt }
        : {}),
      ...(sameSessionIdentity && existing.hiddenDiagnostic !== undefined
        ? { hiddenDiagnostic: structuredClone(existing.hiddenDiagnostic) }
        : {}),
    };

    this.#sessions.set(registration.tabId, snapshot);
    return { accepted: true, session: this.#view(snapshot) };
  }

  applyNavigation(event: NavigationEvent): SessionMutationResult {
    const session = this.#sessions.get(event.tabId);
    const identityReject = this.#identityReject(session, event);
    if (identityReject !== undefined) return { accepted: false, reason: identityReject };
    if (session === undefined) return { accepted: false, reason: "NO_SESSION" };
    if (event.pageEpoch <= session.pageEpoch) return { accepted: false, reason: "STALE_EPOCH" };
    if (event.sequence <= session.lastSequence) return { accepted: false, reason: "STALE_SEQUENCE" };

    const next: SessionSnapshot = {
      tabId: session.tabId,
      documentId: session.documentId,
      agentInstanceId: session.agentInstanceId,
      pageEpoch: event.pageEpoch,
      lastSequence: event.sequence,
      routeKey: event.routeKey,
      registeredAt: session.registeredAt,
      lastSeenAt: event.sentAt,
      ...(event.conversationId === undefined ? {} : { conversationId: event.conversationId }),
    };
    this.#sessions.set(event.tabId, next);
    return { accepted: true, session: this.#view(next) };
  }

  applyObservation(event: ObservationEvent): SessionMutationResult {
    const session = this.#sessions.get(event.tabId);
    const reject = this.#sameEpochReject(session, event);
    if (reject !== undefined) return { accepted: false, reason: reject };
    if (session === undefined) return { accepted: false, reason: "NO_SESSION" };

    if (
      event.observation.routeKey !== session.routeKey ||
      !optionalStringEquals(event.observation.conversationId, session.conversationId)
    ) {
      return { accepted: false, reason: "IDENTITY_MISMATCH" };
    }

    let hiddenDiagnostic = session.hiddenDiagnostic;
    if (event.observation.visibility === "hidden") {
      const prior = hiddenDiagnostic ?? {
        backgroundedAt: event.observation.observedAt,
        ...(session.observation?.latestAssistant?.fingerprint === undefined
          ? {}
          : { baselineAssistantFingerprint: session.observation.latestAssistant.fingerprint }),
        ...(session.observation?.latestAssistant?.textLength === undefined
          ? {}
          : { baselineAssistantTextLength: session.observation.latestAssistant.textLength }),
        hiddenObservationCount: 0,
        assistantChanged: false,
      };
      const assistant = event.observation.latestAssistant;
      const currentFingerprint = assistant?.fingerprint;
      const existingBaselineFingerprint = prior.baselineAssistantFingerprint;
      const baselineFingerprint = existingBaselineFingerprint ?? currentFingerprint;
      const baselineTextLength = prior.baselineAssistantTextLength ?? assistant?.textLength;
      const changedNow = existingBaselineFingerprint !== undefined &&
        currentFingerprint !== undefined &&
        currentFingerprint !== existingBaselineFingerprint;
      const markerDetectedNow = event.markerHealth === "DETECTED";
      hiddenDiagnostic = {
        ...prior,
        ...(baselineFingerprint === undefined ? {} : { baselineAssistantFingerprint: baselineFingerprint }),
        ...(baselineTextLength === undefined ? {} : { baselineAssistantTextLength: baselineTextLength }),
        hiddenObservationCount: prior.hiddenObservationCount + 1,
        ...(prior.firstHiddenObservationAt === undefined ? { firstHiddenObservationAt: event.observation.observedAt } : {}),
        lastHiddenObservationAt: event.observation.observedAt,
        ...(changedNow && prior.firstAssistantChangeAt === undefined ? { firstAssistantChangeAt: event.observation.observedAt } : {}),
        ...(markerDetectedNow && prior.firstMarkerDetectedAt === undefined ? { firstMarkerDetectedAt: event.observation.observedAt } : {}),
        assistantChanged: prior.assistantChanged || changedNow,
        hiddenGeneration: event.observation.generation,
        ...(event.observation.stopControlPresent === undefined
          ? {}
          : { hiddenStopControlPresent: event.observation.stopControlPresent }),
        ...(event.markerHealth === undefined ? {} : { hiddenMarkerHealth: event.markerHealth }),
        ...(assistant?.textLength === undefined ? {} : { hiddenAssistantTextLength: assistant.textLength }),
      };
    } else if (hiddenDiagnostic !== undefined) {
      const visibleObservedAt = hiddenDiagnostic.visibleObservedAt ?? event.observation.observedAt;
      hiddenDiagnostic = {
        ...hiddenDiagnostic,
        visibleObservedAt,
        foregroundedAt: hiddenDiagnostic.foregroundedAt ?? visibleObservedAt,
      };
    }

    const next: SessionSnapshot = {
      ...session,
      lastSequence: event.sequence,
      lastSeenAt: event.sentAt,
      observation: cloneObservation(event.observation),
      ...(event.observation.visibility === undefined ? {} : { lastObservationVisibility: event.observation.visibility }),
      ...(hiddenDiagnostic === undefined ? {} : { hiddenDiagnostic }),
    };
    this.#sessions.set(event.tabId, next);
    return { accepted: true, session: this.#view(next) };
  }

  applyInteraction(event: InteractionEvent): SessionMutationResult {
    const session = this.#sessions.get(event.tabId);
    const reject = this.#sameEpochReject(session, event);
    if (reject !== undefined) return { accepted: false, reason: reject };
    if (session === undefined) return { accepted: false, reason: "NO_SESSION" };

    const next: SessionSnapshot = {
      ...session,
      lastSequence: event.sequence,
      lastSeenAt: event.sentAt,
      lastUserInteractionAt: event.sentAt,
    };
    this.#sessions.set(event.tabId, next);
    return { accepted: true, session: this.#view(next) };
  }

  applyResponseCompletion(event: ResponseCompletionEvent): SessionMutationResult {
    const session = this.#sessions.get(event.tabId);
    const reject = this.#sameEpochReject(session, event);
    if (reject !== undefined) return { accepted: false, reason: reject };
    if (session === undefined) return { accepted: false, reason: "NO_SESSION" };
    if (event.routeKey !== session.routeKey || !optionalStringEquals(event.conversationId, session.conversationId)) {
      return { accepted: false, reason: "IDENTITY_MISMATCH" };
    }

    let hiddenDiagnostic = session.hiddenDiagnostic;
    if (event.visibility === "hidden") {
      const assistant = session.observation?.latestAssistant;
      const prior = hiddenDiagnostic ?? {
        backgroundedAt: event.completedAt,
        ...(assistant?.fingerprint === undefined ? {} : { baselineAssistantFingerprint: assistant.fingerprint }),
        ...(assistant?.textLength === undefined ? {} : { baselineAssistantTextLength: assistant.textLength }),
        hiddenObservationCount: 0,
        assistantChanged: false,
      };
      hiddenDiagnostic = { ...prior, transportCompletedAt: event.completedAt };
    }

    const completion: ResponseCompletionSnapshot = {
      sequence: event.sequence,
      completedAt: event.completedAt,
      visibility: event.visibility,
      transport: event.transport,
    };
    const next: SessionSnapshot = {
      ...session,
      lastSequence: event.sequence,
      lastSeenAt: event.sentAt,
      lastResponseCompletion: completion,
      ...(hiddenDiagnostic === undefined ? {} : { hiddenDiagnostic }),
    };
    this.#sessions.set(event.tabId, next);
    return { accepted: true, session: this.#view(next) };
  }

  markBackgrounded(tabId: number, at: number): boolean {
    const session = this.#sessions.get(tabId);
    if (session === undefined || !Number.isFinite(at)) return false;
    if (
      session.observation?.visibility === "hidden" &&
      session.hiddenDiagnostic !== undefined &&
      session.hiddenDiagnostic.foregroundedAt === undefined
    ) {
      return false;
    }
    const assistant = session.observation?.latestAssistant;
    const next: SessionSnapshot = {
      ...session,
      hiddenDiagnostic: {
        backgroundedAt: at,
        ...(assistant?.fingerprint === undefined ? {} : { baselineAssistantFingerprint: assistant.fingerprint }),
        ...(assistant?.textLength === undefined ? {} : { baselineAssistantTextLength: assistant.textLength }),
        hiddenObservationCount: 0,
        assistantChanged: false,
      },
    };
    this.#sessions.set(tabId, next);
    return true;
  }

  markForegrounded(tabId: number, at: number): boolean {
    const session = this.#sessions.get(tabId);
    const hiddenDiagnostic = session?.hiddenDiagnostic;
    if (session === undefined || hiddenDiagnostic === undefined || !Number.isFinite(at)) return false;
    this.#sessions.set(tabId, {
      ...session,
      hiddenDiagnostic: {
        ...hiddenDiagnostic,
        tabActivatedAt: hiddenDiagnostic.tabActivatedAt ?? at,
        foregroundedAt: hiddenDiagnostic.foregroundedAt ?? at,
      },
    });
    return true;
  }

  invalidateTab(tabId: number): void {
    // A tabs.onUpdated("loading") event does not identify which exact document caused it.
    // Drop the live session so stale observations fail closed, but do not tombstone the
    // document here: the same exact content agent may already have registered before the
    // loading callback is delivered and must be allowed to reconnect. True document
    // replacement is still retired by registerAgent when a newer document takes over.
    this.#sessions.delete(tabId);
  }

  removeTab(tabId: number): void {
    this.#sessions.delete(tabId);
    this.#retiredDocuments.delete(tabId);
  }

  getTab(tabId: number): SessionView | undefined {
    const session = this.#sessions.get(tabId);
    return session === undefined ? undefined : this.#view(session);
  }

  list(): SessionView[] {
    return [...this.#sessions.values()]
      .sort((left, right) => left.tabId - right.tabId)
      .map((session) => this.#view(session));
  }

  #isRetiredDocument(tabId: number, documentId: string): boolean {
    return this.#retiredDocuments.get(tabId)?.includes(documentId) === true;
  }

  #retireDocument(tabId: number, documentId: string): void {
    const existing = this.#retiredDocuments.get(tabId) ?? [];
    if (existing.includes(documentId)) return;
    this.#retiredDocuments.set(tabId, [...existing, documentId].slice(-8));
  }

  #sameEpochReject(
    session: SessionSnapshot | undefined,
    event: Pick<ObservationEvent | InteractionEvent | ResponseCompletionEvent, "documentId" | "agentInstanceId" | "pageEpoch" | "sequence">,
  ): SessionEventRejectReason | undefined {
    const identityReject = this.#identityReject(session, event);
    if (identityReject !== undefined) return identityReject;
    if (session === undefined) return "NO_SESSION";
    if (event.pageEpoch < session.pageEpoch) return "STALE_EPOCH";
    if (event.pageEpoch > session.pageEpoch) return "FUTURE_EPOCH";
    if (event.sequence <= session.lastSequence) return "STALE_SEQUENCE";
    return undefined;
  }

  #identityReject(
    session: SessionSnapshot | undefined,
    event: Pick<NavigationEvent, "documentId" | "agentInstanceId">,
  ): SessionEventRejectReason | undefined {
    if (session === undefined) return "NO_SESSION";
    if (event.documentId !== session.documentId) return "STALE_DOCUMENT";
    if (event.agentInstanceId !== session.agentInstanceId) return "STALE_AGENT";
    return undefined;
  }

  #view(session: SessionSnapshot): SessionView {
    return { ...cloneSnapshot(session), controlEligibility: this.#controlEligibility(session) };
  }

  #controlEligibility(session: SessionSnapshot): ControlEligibility {
    const conversationId = session.conversationId;
    if (conversationId === undefined || session.observation === undefined) return "NONE";

    const candidates = [...this.#sessions.values()]
      .filter(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.observation !== undefined &&
          candidate.observation.conversationId === candidate.conversationId &&
          candidate.observation.routeKey === candidate.routeKey,
      )
      .sort((left, right) => {
        const timeDifference = left.registeredAt - right.registeredAt;
        return timeDifference === 0 ? left.tabId - right.tabId : timeDifference;
      });

    return candidates[0]?.tabId === session.tabId ? "OWNER" : "MIRROR";
  }
}
