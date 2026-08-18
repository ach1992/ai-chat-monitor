import type { PageObservation } from "../shared/observation.js";

export type ControlEligibility = "OWNER" | "MIRROR" | "NONE";

export type SessionEventRejectReason =
  | "NO_SESSION"
  | "STALE_DOCUMENT"
  | "STALE_AGENT"
  | "STALE_EPOCH"
  | "FUTURE_EPOCH"
  | "STALE_SEQUENCE"
  | "IDENTITY_MISMATCH";

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
    Number.isFinite(session.lastSeenAt)
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

    const next: SessionSnapshot = {
      ...session,
      lastSequence: event.sequence,
      lastSeenAt: event.sentAt,
      observation: cloneObservation(event.observation),
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

  invalidateTab(tabId: number): void {
    const session = this.#sessions.get(tabId);
    if (session !== undefined) this.#retireDocument(tabId, session.documentId);
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
    event: Pick<ObservationEvent | InteractionEvent, "documentId" | "agentInstanceId" | "pageEpoch" | "sequence">,
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
