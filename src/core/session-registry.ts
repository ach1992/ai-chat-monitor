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

export interface SessionRegistryState {
  version: 1;
  sessions: SessionSnapshot[];
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

export class SessionRegistry {
  readonly #sessions = new Map<number, SessionSnapshot>();

  static fromState(state: SessionRegistryState | undefined): SessionRegistry {
    const registry = new SessionRegistry();
    if (state?.version !== 1 || !Array.isArray(state.sessions)) {
      return registry;
    }

    for (const session of state.sessions) {
      if (
        !Number.isInteger(session.tabId) ||
        session.tabId < 0 ||
        typeof session.documentId !== "string" ||
        session.documentId.length === 0 ||
        typeof session.agentInstanceId !== "string" ||
        session.agentInstanceId.length === 0
      ) {
        continue;
      }
      registry.#sessions.set(session.tabId, cloneSnapshot(session));
    }

    return registry;
  }

  exportState(): SessionRegistryState {
    return {
      version: 1,
      sessions: [...this.#sessions.values()].map(cloneSnapshot),
    };
  }

  registerAgent(registration: AgentRegistration): SessionMutationResult {
    const existing = this.#sessions.get(registration.tabId);
    if (existing !== undefined) {
      const sameIdentity =
        existing.documentId === registration.documentId &&
        existing.agentInstanceId === registration.agentInstanceId;

      if (sameIdentity) {
        if (registration.pageEpoch < existing.pageEpoch) {
          return { accepted: false, reason: "STALE_EPOCH" };
        }
        if (registration.sequence <= existing.lastSequence) {
          return { accepted: false, reason: "STALE_SEQUENCE" };
        }
      } else if (registration.sentAt <= existing.lastSeenAt) {
        return { accepted: false, reason: "STALE_DOCUMENT" };
      }
    }

    const registeredAt =
      existing?.documentId === registration.documentId &&
      existing.agentInstanceId === registration.agentInstanceId
        ? existing.registeredAt
        : registration.sentAt;

    const snapshot: SessionSnapshot = {
      tabId: registration.tabId,
      documentId: registration.documentId,
      agentInstanceId: registration.agentInstanceId,
      pageEpoch: registration.pageEpoch,
      lastSequence: registration.sequence,
      routeKey: registration.routeKey,
      registeredAt,
      lastSeenAt: registration.sentAt,
      ...(registration.conversationId === undefined
        ? {}
        : { conversationId: registration.conversationId }),
    };

    this.#sessions.set(registration.tabId, snapshot);
    return { accepted: true, session: this.#view(snapshot) };
  }

  applyNavigation(event: NavigationEvent): SessionMutationResult {
    const session = this.#sessions.get(event.tabId);
    const identityReject = this.#identityReject(session, event);
    if (identityReject !== undefined) {
      return { accepted: false, reason: identityReject };
    }
    if (session === undefined) {
      return { accepted: false, reason: "NO_SESSION" };
    }
    if (event.pageEpoch <= session.pageEpoch) {
      return { accepted: false, reason: "STALE_EPOCH" };
    }
    if (event.sequence <= session.lastSequence) {
      return { accepted: false, reason: "STALE_SEQUENCE" };
    }

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
    if (reject !== undefined) {
      return { accepted: false, reason: reject };
    }
    if (session === undefined) {
      return { accepted: false, reason: "NO_SESSION" };
    }

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
    if (reject !== undefined) {
      return { accepted: false, reason: reject };
    }
    if (session === undefined) {
      return { accepted: false, reason: "NO_SESSION" };
    }

    const next: SessionSnapshot = {
      ...session,
      lastSequence: event.sequence,
      lastSeenAt: event.sentAt,
      lastUserInteractionAt: event.sentAt,
    };
    this.#sessions.set(event.tabId, next);
    return { accepted: true, session: this.#view(next) };
  }

  removeTab(tabId: number): void {
    this.#sessions.delete(tabId);
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

  #sameEpochReject(
    session: SessionSnapshot | undefined,
    event: Pick<
      ObservationEvent | InteractionEvent,
      "documentId" | "agentInstanceId" | "pageEpoch" | "sequence"
    >,
  ): SessionEventRejectReason | undefined {
    const identityReject = this.#identityReject(session, event);
    if (identityReject !== undefined) {
      return identityReject;
    }
    if (session === undefined) {
      return "NO_SESSION";
    }
    if (event.pageEpoch < session.pageEpoch) {
      return "STALE_EPOCH";
    }
    if (event.pageEpoch > session.pageEpoch) {
      return "FUTURE_EPOCH";
    }
    if (event.sequence <= session.lastSequence) {
      return "STALE_SEQUENCE";
    }
    return undefined;
  }

  #identityReject(
    session: SessionSnapshot | undefined,
    event: Pick<NavigationEvent, "documentId" | "agentInstanceId">,
  ): SessionEventRejectReason | undefined {
    if (session === undefined) {
      return "NO_SESSION";
    }
    if (event.documentId !== session.documentId) {
      return "STALE_DOCUMENT";
    }
    if (event.agentInstanceId !== session.agentInstanceId) {
      return "STALE_AGENT";
    }
    return undefined;
  }

  #view(session: SessionSnapshot): SessionView {
    return {
      ...cloneSnapshot(session),
      controlEligibility: this.#controlEligibility(session),
    };
  }

  #controlEligibility(session: SessionSnapshot): ControlEligibility {
    const conversationId = session.conversationId;
    if (conversationId === undefined) {
      return "NONE";
    }

    const candidates = [...this.#sessions.values()]
      .filter((candidate) => candidate.conversationId === conversationId)
      .sort((left, right) => {
        const timeDifference = left.registeredAt - right.registeredAt;
        return timeDifference === 0 ? left.tabId - right.tabId : timeDifference;
      });

    return candidates[0]?.tabId === session.tabId ? "OWNER" : "MIRROR";
  }
}
