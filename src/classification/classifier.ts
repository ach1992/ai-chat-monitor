import { sanitizeContext, type ContextSanitizerOptions } from "./context.js";
import { evaluateDeterministicRules } from "./rules.js";
import { unsureResult, type ClassificationResult, type ConversationTurn } from "./types.js";
import type { ProviderManager } from "../providers/manager.js";

export interface StopClassifierInput {
  turns: readonly ConversationTurn[];
}

export class ConservativeStopClassifier {
  readonly #providers: ProviderManager | undefined;
  readonly #sanitizerOptions: ContextSanitizerOptions;

  constructor(
    providers?: ProviderManager,
    sanitizerOptions: ContextSanitizerOptions = {},
  ) {
    this.#providers = providers;
    this.#sanitizerOptions = { ...sanitizerOptions };
  }

  async classify(input: StopClassifierInput): Promise<ClassificationResult> {
    const context = sanitizeContext(input.turns, this.#sanitizerOptions);
    if (context.turns.length === 0) {
      return unsureResult("AMBIGUOUS", "No usable recent conversation context was available.");
    }

    const deterministic = evaluateDeterministicRules(context);
    if (deterministic !== undefined) return deterministic;
    if (this.#providers === undefined) {
      return unsureResult("PROVIDER_FAILURE", "No provider is configured for an ambiguous stop.");
    }

    return this.#providers.classify({ context });
  }
}
