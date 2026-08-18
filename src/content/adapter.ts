namespace GuardianContent {
  export const PROTOCOL_VERSION = 2 as const;

  export type GenerationState = "IDLE" | "GENERATING" | "UNKNOWN";
  export type ObservationConfidence = "HIGH" | "LOW";
  export type BlockingReason =
    | "MODAL"
    | "RATE_LIMIT"
    | "AUTH"
    | "NETWORK"
    | "ERROR"
    | "CAPTCHA"
    | "ACCOUNT_VERIFICATION"
    | "CONFIRMATION_REQUIRED";

  export interface PageObservation {
    conversationId?: string;
    routeKey: string;
    generation: GenerationState;
    latestAssistant?: {
      normalizedText: string;
      textLength: number;
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
    };
    confidence: ObservationConfidence;
    observedAt: number;
  }

  const MAX_NORMALIZED_RESPONSE_CHARS = 12_000;
  const ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    'article[data-turn="assistant"]',
  ] as const;
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    'textarea[data-testid="prompt-textarea"]',
    'textarea[name="prompt-textarea"]',
    '[contenteditable="true"][data-testid*="composer"]',
    '[contenteditable="true"][role="textbox"]',
  ] as const;
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
  ] as const;
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop streaming"]',
    'button[aria-label*="stop"]',
  ] as const;
  const BLOCKING_SELECTORS = [
    '[role="dialog"]',
    '[role="alert"]',
    '[data-testid*="error"]',
    '[data-testid*="rate-limit"]',
  ] as const;

  export function extractConversationId(pathname: string): string | undefined {
    const match = /^\/c\/([^/?#]+)/.exec(pathname);
    const rawId = match?.[1];
    if (rawId === undefined) return undefined;

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawId);
    } catch {
      decoded = rawId;
    }
    return /^[A-Za-z0-9_-]{4,200}$/.test(decoded) ? decoded : undefined;
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
        if (element !== null) return element;
      } catch {
        // Selector drift must fail closed instead of breaking the observer.
      }
    }
    return undefined;
  }

  function allMatches(document: Document, selectors: readonly string[]): Element[] {
    const found = new Set<Element>();
    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) found.add(element);
      } catch {
        // Retain the conservative remainder if one heuristic becomes invalid.
      }
    }
    return [...found];
  }

  function assistantMatches(document: Document): Element[] {
    return allMatches(document, ASSISTANT_SELECTORS);
  }

  function elementText(element: Element): string {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
    return element.textContent ?? "";
  }

  function readMessageId(element: Element): string | undefined {
    const direct = element.getAttribute("data-message-id");
    if (direct !== null && direct.length > 0) return direct;
    const turn = element.closest(TURN_SELECTOR);
    const testId = turn?.getAttribute("data-testid");
    if (testId?.startsWith("conversation-turn-") === true) {
      const suffix = testId.slice("conversation-turn-".length);
      return suffix.length === 0 ? undefined : suffix;
    }
    return undefined;
  }

  function blockingReasons(element: Element, text: string): BlockingReason[] {
    const reasons = new Set<BlockingReason>();
    if (element.getAttribute("role") === "dialog") reasons.add("MODAL");
    if (element.getAttribute("role") === "alert") reasons.add("ERROR");
    if ((element.getAttribute("data-testid") ?? "").toLowerCase().includes("error")) reasons.add("ERROR");

    const lowered = text.toLowerCase();
    if (/rate limit|too many requests|try again later|usage limit/.test(lowered)) reasons.add("RATE_LIMIT");
    if (/log in|sign in|session expired|authentication/.test(lowered)) reasons.add("AUTH");
    if (/network error|connection error|offline|reconnect/.test(lowered)) reasons.add("NETWORK");
    if (/captcha|verify you are human|human verification/.test(lowered)) reasons.add("CAPTCHA");
    if (/verify (your )?account|account verification/.test(lowered)) reasons.add("ACCOUNT_VERIFICATION");
    if (/confirm|confirmation required|are you sure|permission required/.test(lowered)) reasons.add("CONFIRMATION_REQUIRED");
    if (/error|something went wrong|failed/.test(lowered)) reasons.add("ERROR");
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

    isComposerTarget(target: EventTarget | null): boolean {
      if (!(target instanceof Node)) return false;
      const composer = firstMatch<HTMLElement>(this.#document, COMPOSER_SELECTORS);
      return composer !== undefined && (target === composer || composer.contains(target));
    }

    isManualSendTarget(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      return SEND_SELECTORS.some((selector) => {
        try {
          return target.matches(selector) || target.closest(selector) !== null;
        } catch {
          return false;
        }
      });
    }

    async observe(observedAt = Date.now()): Promise<PageObservation> {
      const conversationId = this.currentConversationId();
      const composer = firstMatch<HTMLElement>(this.#document, COMPOSER_SELECTORS);
      const stopControl = firstMatch<HTMLElement>(this.#document, STOP_SELECTORS);
      const latestAssistantElement = assistantMatches(this.#document).at(-1);
      const blockingSurfaces = allMatches(this.#document, BLOCKING_SELECTORS);

      const reasons = new Set<BlockingReason>();
      for (const surface of blockingSurfaces) {
        const text = normalizeAssistantText(elementText(surface)).slice(0, 2_000);
        for (const reason of blockingReasons(surface, text)) reasons.add(reason);
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
        blocking: { blocked: reasons.size > 0, reasons: [...reasons].sort() },
        confidence: conversationId !== undefined && (composer !== undefined || latestAssistantElement !== undefined) ? "HIGH" : "LOW",
        observedAt,
        ...(conversationId === undefined ? {} : { conversationId }),
      };

      if (latestAssistantElement !== undefined) {
        const normalizedText = normalizeAssistantText(elementText(latestAssistantElement));
        if (normalizedText.length > 0) {
          const domMessageId = readMessageId(latestAssistantElement);
          observation.latestAssistant = {
            normalizedText: normalizedText.slice(0, MAX_NORMALIZED_RESPONSE_CHARS),
            textLength: normalizedText.length,
            fingerprint: await fingerprintText(normalizedText),
            ...(domMessageId === undefined ? {} : { domMessageId }),
          };
        }
      }

      return observation;
    }
  }
}
