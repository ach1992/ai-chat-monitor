import type { AutomationDecisionEnvelope } from "./types.js";

export type WriteGuardDisposition = "ATTEMPTED" | "AMBIGUOUS" | "VERIFIED";

export interface WriteGuardRecord {
  conversationId: string;
  assistantFingerprint: string;
  assistantDomMessageId?: string;
  outcomeSignature?: string;
  decisionId: string;
  documentId: string;
  attemptedAt: number;
  disposition: WriteGuardDisposition;
  action?: AutomationDecisionEnvelope["action"];
  conversationProtocolVersion?: number;
  continuationText?: string;
}

export interface AutomationWriteJournalState {
  version: 1;
  records: WriteGuardRecord[];
}

export interface AutomationWriteJournalPersistence {
  load(): Promise<AutomationWriteJournalState | undefined>;
  save(state: AutomationWriteJournalState): Promise<void>;
}

const MAX_WRITE_GUARD_RECORDS = 4_096;

function boundedDomMessageId(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= 200 ? value : undefined;
}

function boundedControlText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.length > 0 && normalized.length <= 1_000 ? normalized : undefined;
}

function validRecord(record: WriteGuardRecord): boolean {
  return (
    typeof record.conversationId === "string" &&
    record.conversationId.length > 0 &&
    typeof record.assistantFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(record.assistantFingerprint) &&
    (record.assistantDomMessageId === undefined || boundedDomMessageId(record.assistantDomMessageId) !== undefined) &&
    (record.outcomeSignature === undefined || /^[a-f0-9]{16}$/.test(record.outcomeSignature)) &&
    typeof record.decisionId === "string" &&
    record.decisionId.length > 0 &&
    typeof record.documentId === "string" &&
    record.documentId.length > 0 &&
    Number.isFinite(record.attemptedAt) &&
    (record.disposition === "ATTEMPTED" || record.disposition === "AMBIGUOUS" || record.disposition === "VERIFIED") &&
    (
      record.action === undefined ||
      record.action === "CONTINUATION" ||
      record.action === "PROTOCOL_BOOTSTRAP" ||
      record.action === "STATUS_RESPONSE"
    ) &&
    (record.conversationProtocolVersion === undefined || (
      Number.isInteger(record.conversationProtocolVersion) && record.conversationProtocolVersion >= 1
    )) &&
    (record.continuationText === undefined || boundedControlText(record.continuationText) !== undefined)
  );
}

function normalizeState(state: AutomationWriteJournalState | undefined): AutomationWriteJournalState {
  if (state?.version !== 1 || !Array.isArray(state.records)) return { version: 1, records: [] };
  return { version: 1, records: state.records.filter(validRecord).map((record) => ({ ...record })) };
}

function guardedResponseMatches(
  record: WriteGuardRecord,
  conversationId: string,
  assistantFingerprint: string,
  assistantDomMessageId: string | undefined,
): boolean {
  if (record.conversationId !== conversationId || record.assistantFingerprint !== assistantFingerprint) return false;
  return (
    record.assistantDomMessageId === undefined ||
    assistantDomMessageId === undefined ||
    record.assistantDomMessageId === assistantDomMessageId
  );
}

export class AutomationWriteJournal {
  readonly #persistence: AutomationWriteJournalPersistence;
  #state: AutomationWriteJournalState = { version: 1, records: [] };
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(persistence: AutomationWriteJournalPersistence) { this.#persistence = persistence; }

  async restore(): Promise<void> { this.#state = normalizeState(await this.#persistence.load()); }
  snapshot(): AutomationWriteJournalState { return structuredClone(this.#state); }

  hasGuard(conversationId: string, assistantFingerprint: string, assistantDomMessageId?: string): boolean {
    const exactDomMessageId = boundedDomMessageId(assistantDomMessageId);
    return this.#state.records.some((record) =>
      guardedResponseMatches(record, conversationId, assistantFingerprint, exactDomMessageId),
    );
  }

  verifiedSince(conversationId: string, since: number): WriteGuardRecord[] {
    return this.#state.records
      .filter(
        (record) =>
          record.conversationId === conversationId &&
          record.disposition === "VERIFIED" &&
          record.action !== "PROTOCOL_BOOTSTRAP" &&
          record.attemptedAt > since,
      )
      .map((record) => ({ ...record }));
  }

  hasVerifiedProtocolBootstrapForUserTurn(
    conversationId: string,
    latestUserText: string | undefined,
    lastUserInteractionAt: number | undefined,
    version = 1,
  ): boolean {
    const controlText = boundedControlText(latestUserText);
    if (controlText === undefined) return false;
    return this.#state.records.some((record) =>
      record.conversationId === conversationId &&
      record.disposition === "VERIFIED" &&
      record.action === "PROTOCOL_BOOTSTRAP" &&
      record.conversationProtocolVersion === version &&
      record.continuationText === controlText &&
      (lastUserInteractionAt === undefined || record.attemptedAt > lastUserInteractionAt),
    );
  }

  hasVerifiedStatusResponseSince(
    conversationId: string,
    continuationText: string,
    since: number | undefined,
  ): boolean {
    const controlText = boundedControlText(continuationText);
    if (controlText === undefined) return false;
    return this.#state.records.some((record) =>
      record.conversationId === conversationId &&
      record.disposition === "VERIFIED" &&
      record.action === "STATUS_RESPONSE" &&
      record.continuationText === controlText &&
      (since === undefined || record.attemptedAt > since),
    );
  }

  reserve(envelope: AutomationDecisionEnvelope): Promise<boolean> {
    return this.#enqueue(async () => {
      const assistantDomMessageId = boundedDomMessageId(envelope.assistantDomMessageId);
      const continuationText = envelope.action === "PROTOCOL_BOOTSTRAP" || envelope.action === "STATUS_RESPONSE"
        ? boundedControlText(envelope.continuationText)
        : undefined;
      const retained = envelope.lastUserInteractionAt === undefined
        ? this.#state.records
        : this.#state.records.filter((record) =>
          record.conversationId !== envelope.conversationId ||
          record.attemptedAt > (envelope.lastUserInteractionAt ?? Number.NEGATIVE_INFINITY),
        );
      if (retained.some((record) =>
        guardedResponseMatches(
          record,
          envelope.conversationId,
          envelope.assistantFingerprint,
          assistantDomMessageId,
        ),
      )) return false;
      if (retained.length >= MAX_WRITE_GUARD_RECORDS) {
        throw new Error("Write guard journal capacity is exhausted; automatic mutation is blocked.");
      }
      const record: WriteGuardRecord = {
        conversationId: envelope.conversationId,
        assistantFingerprint: envelope.assistantFingerprint,
        ...(assistantDomMessageId === undefined ? {} : { assistantDomMessageId }),
        decisionId: envelope.decisionId,
        documentId: envelope.documentId,
        attemptedAt: envelope.createdAt,
        disposition: "ATTEMPTED",
        action: envelope.action,
        ...(envelope.conversationProtocolVersion === undefined
          ? {}
          : { conversationProtocolVersion: envelope.conversationProtocolVersion }),
        ...(continuationText === undefined ? {} : { continuationText }),
      };
      const next: AutomationWriteJournalState = { version: 1, records: [...retained, record] };
      await this.#persistence.save(next);
      this.#state = next;
      return true;
    });
  }

  setOutcomeSignature(decisionId: string, outcomeSignature: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!/^[a-f0-9]{16}$/.test(outcomeSignature)) throw new Error("Progress signature is invalid.");
      const index = this.#state.records.findIndex((record) => record.decisionId === decisionId);
      if (index < 0 || this.#state.records[index]?.disposition !== "ATTEMPTED") {
        throw new Error("Write guard is not available for progress annotation.");
      }
      const records = this.#state.records.map((record, recordIndex) =>
        recordIndex === index ? { ...record, outcomeSignature } : { ...record },
      );
      const next: AutomationWriteJournalState = { version: 1, records };
      await this.#persistence.save(next);
      this.#state = next;
    });
  }

  mark(decisionId: string, disposition: Exclude<WriteGuardDisposition, "ATTEMPTED">): Promise<void> {
    return this.#enqueue(async () => {
      const index = this.#state.records.findIndex((record) => record.decisionId === decisionId);
      if (index < 0) throw new Error("Write guard disappeared before outcome reconciliation.");
      const records = this.#state.records.map((record, recordIndex) =>
        recordIndex === index ? { ...record, disposition } : { ...record },
      );
      const next: AutomationWriteJournalState = { version: 1, records };
      await this.#persistence.save(next);
      this.#state = next;
    });
  }

  releaseNotStarted(decisionId: string): Promise<void> {
    return this.#enqueue(async () => {
      const record = this.#state.records.find((candidate) => candidate.decisionId === decisionId);
      if (record?.disposition !== "ATTEMPTED") return;
      const next: AutomationWriteJournalState = {
        version: 1,
        records: this.#state.records.filter((candidate) => candidate.decisionId !== decisionId),
      };
      await this.#persistence.save(next);
      this.#state = next;
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

}
