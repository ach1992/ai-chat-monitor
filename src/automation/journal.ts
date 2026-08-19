import type { AutomationDecisionEnvelope } from "./types.js";

export type WriteGuardDisposition = "ATTEMPTED" | "AMBIGUOUS" | "VERIFIED";

export interface WriteGuardRecord {
  conversationId: string;
  assistantFingerprint: string;
  outcomeSignature?: string;
  decisionId: string;
  documentId: string;
  attemptedAt: number;
  disposition: WriteGuardDisposition;
}

export interface AutomationWriteJournalState {
  version: 1;
  records: WriteGuardRecord[];
}

export interface AutomationWriteJournalPersistence {
  load(): Promise<AutomationWriteJournalState | undefined>;
  save(state: AutomationWriteJournalState): Promise<void>;
}

function validRecord(record: WriteGuardRecord): boolean {
  return (
    typeof record.conversationId === "string" &&
    record.conversationId.length > 0 &&
    typeof record.assistantFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(record.assistantFingerprint) &&
    (record.outcomeSignature === undefined || /^[a-f0-9]{16}$/.test(record.outcomeSignature)) &&
    typeof record.decisionId === "string" &&
    record.decisionId.length > 0 &&
    typeof record.documentId === "string" &&
    record.documentId.length > 0 &&
    Number.isFinite(record.attemptedAt) &&
    (record.disposition === "ATTEMPTED" || record.disposition === "AMBIGUOUS" || record.disposition === "VERIFIED")
  );
}

function normalizeState(state: AutomationWriteJournalState | undefined): AutomationWriteJournalState {
  if (state?.version !== 1 || !Array.isArray(state.records)) return { version: 1, records: [] };
  return { version: 1, records: state.records.filter(validRecord).map((record) => ({ ...record })) };
}

export class AutomationWriteJournal {
  readonly #persistence: AutomationWriteJournalPersistence;
  #state: AutomationWriteJournalState = { version: 1, records: [] };
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(persistence: AutomationWriteJournalPersistence) { this.#persistence = persistence; }

  async restore(): Promise<void> { this.#state = normalizeState(await this.#persistence.load()); }
  snapshot(): AutomationWriteJournalState { return structuredClone(this.#state); }

  hasGuard(conversationId: string, assistantFingerprint: string): boolean {
    return this.#state.records.some(
      (record) => record.conversationId === conversationId && record.assistantFingerprint === assistantFingerprint,
    );
  }

  verifiedSince(conversationId: string, since: number): WriteGuardRecord[] {
    return this.#state.records
      .filter(
        (record) =>
          record.conversationId === conversationId &&
          record.disposition === "VERIFIED" &&
          record.attemptedAt > since,
      )
      .map((record) => ({ ...record }));
  }

  reserve(envelope: AutomationDecisionEnvelope): Promise<boolean> {
    return this.#enqueue(async () => {
      if (this.hasGuard(envelope.conversationId, envelope.assistantFingerprint)) return false;
      const record: WriteGuardRecord = {
        conversationId: envelope.conversationId,
        assistantFingerprint: envelope.assistantFingerprint,
        decisionId: envelope.decisionId,
        documentId: envelope.documentId,
        attemptedAt: envelope.createdAt,
        disposition: "ATTEMPTED",
      };
      const next: AutomationWriteJournalState = { version: 1, records: [...this.#state.records, record] };
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
