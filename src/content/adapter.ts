namespace GuardianContent {
  export const PROTOCOL_VERSION = 2 as const;

  export type GenerationState = "IDLE" | "GENERATING" | "UNKNOWN";
  export type BlockingReason = "MODAL" | "RATE_LIMIT" | "AUTH" | "NETWORK" | "ERROR";

  export interface PageObservation {
    conversationId?: string;
    routeKey: string;
    generation: GenerationState;
    latestAssistant?: {
      text: string;
      fingerprint: string;
      domMessageId?: string;
    };
    composer: {
      present: boolean;
      hasText: boolean;
      focused: boolean;
    };
    blocking: {
      blocked: boolean;
      reasons: BlockingReason[];
      summary?: string;
    };
    observedAt: number;
  }

  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'textarea[name="prompt-textarea"]',
    '[contenteditable="true"][data-testid*="composer"]',
  ] as const;
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop streaming"]',
  ] as const;
  const BLOCKING_SELECTORS = [
    '[role="dialog"]',
    '[role="alert"]',
    '[data-testid*="error"]',
  ] as const;

  export function extractConversationId(pathname: string): string | undefined {
    const segments = pathname.split("/").filter((segment) => segment.length > 0);
    const conversationMarker = segments.lastIndexOf("c");
    const rawId = segments[conversationMarker + 1];
    if (conversationMarker < 0 || rawId === undefined || rawId.length === 0) {
      return undefined;
    }

    try {
      return decodeURIComponent(rawId);
    } catch {
      return rawId;
    }
  }

  export function routeKey(pathname: string): string {
    const normalized = pathname.replace(/\/+$/, "");
    return normalized.length === 0 ? "/" : normalized;
  }

  export function normalizeAssistantText(value: string): string {
    return value
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  export async function fingerprintText(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function firstMatch<T extends Element>(document: Document, selectors: readonly string[]): T | undefined {
    for (const selector of selectors) {
      try {
        const element = document.querySelector<T>(selector);
        if (element !== null) {
          return element;
        }
      } catch {
        // A selector becoming invalid must fail closed instead of breaking observation.
      }
    }
    return undefined;
  }

  function allMatches(document: Document, selectors: readonly string[]): Element[] {
    const found = new Set<Element>();
    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          found.add(element);
        }
      } catch {
        // Ignore individual selector failures and retain the conservative remainder.
      }
    }
    return [...found];
  }

  function elementText(element: Element): string {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value;
    }
    return element.textContent ?? "";
  }

  function readMessageId(element: Element): string | undefined {
    const direct = element.getAttribute("data-message-id");
    if (direct !== null && direct.length > 0) {
      return direct;
    }

    const turn = element.closest(TURN_SELECTOR);
    const testId = turn?.getAttribute("data-testid");
    if (testId?.startsWith("conversation-turn-") === true) {
      const suffix = testId.slice("conversation-turn-".length);
      return suffix.length === 0 ? undefined : suffix;
    }
    return undefined;
  }

  function blockingReason(element: Element, text: string): BlockingReason[] {
    const reasons = new Set<BlockingReason>();
    if (element.getAttribute("role") === "dialog") {
      reasons.add("MODAL");
    }
    if (element.getAttribute("role") === "alert") {
      reasons.add("ERROR");
    }
    if ((element.getAttribute("data-testid") ?? "").toLowerCase().includes("error")) {
      reasons.add("ERROR");
    }

    const lowered = text.toLowerCase();
    if (/rate limit|too many requests|try again later|usage limit/.test(lowered)) {
      reasons.add("RATE_LIMIT");
    }
    if (/log in|sign in|session expired|verify you are human|authentication/.test(lowered)) {
      reasons.add("AUTH");
    }
    if (/network error|connection error|offline|reconnect/.test(lowered)) {
      reasons.add("NETWORK");
    }
    if (/error|something went wrong|failed/.test(lowered)) {
      reasons.add("ERROR");
    }

    return [...reasons];
  }

  export class BrowserChatGPTAdapter {
    readonly #document: Document;
    readonly #location: Pick<Location, "pathname">;

    constructor(document: Document, location: Pick<Location, "pathname">) {
      this.#document = document;
      this.#location = location;
    }

    currentRouteKey(): string {
      return routeKey(this.#location.pathname);
    }

    currentConversationId(): string | undefined {
      return extractConversationId(this.#location.pathname);
    }

    async observe(observedAt = Date.now()): Promise<PageObservation> {
      const conversationId = this.currentConversationId();
      const composer = firstMatch<HTMLElement>(this.#document, COMPOSER_SELECTORS);
      const stopControl = firstMatch<HTMLElement>(this.#document, STOP_SELECTORS);
      const assistantTurns = [...this.#document.querySelectorAll(ASSISTANT_SELECTOR)];
      const latestAssistantElement = assistantTurns.at(-1);
      const blockingSurfaces = allMatches(this.#document, BLOCKING_SELECTORS);

      const blockingReasons = new Set<BlockingReason>();
      const blockingSummaries: string[] = [];
      for (const surface of blockingSurfaces) {
        const text = normalizeAssistantText(elementText(surface)).slice(0, 240);
        const reasons = blockingReason(surface, text);
        if (reasons.length === 0) {
          continue;
        }
        for (const reason of reasons) {
          blockingReasons.add(reason);
        }
        if (text.length > 0) {
          blockingSummaries.push(text);
        }
      }

      const generation: GenerationState =
        stopControl !== undefined ? "GENERATING" : composer !== undefined ? "IDLE" : "UNKNOWN";
      const composerText = composer === undefined ? "" : elementText(composer);
      const activeElement = this.#document.activeElement;
      const composerFocused =
        composer !== undefined &&
        activeElement !== null &&
        (composer === activeElement || composer.contains(activeElement));

      const observation: PageObservation = {
        routeKey: this.currentRouteKey(),
        generation,
        composer: {
          present: composer !== undefined,
          hasText: normalizeAssistantText(composerText).length > 0,
          focused: composerFocused,
        },
        blocking: {
          blocked: blockingReasons.size > 0,
          reasons: [...blockingReasons].sort(),
          ...(blockingSummaries.length === 0
            ? {}
            : { summary: blockingSummaries.join(" | ").slice(0, 480) }),
        },
        observedAt,
        ...(conversationId === undefined ? {} : { conversationId }),
      };

      if (latestAssistantElement !== undefined) {
        const text = normalizeAssistantText(elementText(latestAssistantElement));
        if (text.length > 0) {
          const domMessageId = readMessageId(latestAssistantElement);
          observation.latestAssistant = {
            text,
            fingerprint: await fingerprintText(text),
            ...(domMessageId === undefined ? {} : { domMessageId }),
          };
        }
      }

      return observation;
    }
  }
}
