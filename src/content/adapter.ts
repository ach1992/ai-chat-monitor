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
    | "CONFIRMATION_REQUIRED"
    | "CONVERSATION_FULL";

  export interface PageObservation {
    conversationId?: string;
    routeKey: string;
    pageTitle?: string;
    generation: GenerationState;
    latestUser?: {
      normalizedText: string;
      textLength: number;
      domMessageId?: string;
    };
    latestAssistant?: {
      normalizedText: string;
      textLength: number;
      fingerprint: string;
      domMessageId?: string;
    };
    composer: { present: boolean; hasText: boolean; focused: boolean };
    blocking: { blocked: boolean; reasons: BlockingReason[] };
    actions: { retryAvailable: boolean; continueGeneratingAvailable: boolean };
    confidence: ObservationConfidence;
    observedAt: number;
  }

  const MAX_NORMALIZED_RESPONSE_CHARS = 12_000;
  const MAX_PAGE_TITLE_CHARS = 300;
  const STATUS_PREFIXES = [
    "CHAT_TURN_GUARDIAN_STATUS=",
    "CHAT_TURN_GUARDIAN_STATUS_V1=",
  ] as const;
  const ASSISTANT_SELECTORS = ['[data-message-author-role="assistant"]', 'article[data-turn="assistant"]'] as const;
  const USER_SELECTORS = ['[data-message-author-role="user"]', 'article[data-turn="user"]'] as const;
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
  const EDIT_SELECTORS = [
    'button[aria-label*="Edit"]',
    'button[aria-label*="edit"]',
    '[data-testid*="edit"]',
  ] as const;
  const BLOCKING_SELECTORS = [
    '[role="dialog"]',
    '[role="alert"]',
    '[data-testid*="error"]',
    '[data-testid*="rate-limit"]',
  ] as const;
  const RETRY_SELECTORS = [
    'button[data-testid*="retry"]',
    'button[aria-label*="Retry"]',
    'button[aria-label*="retry"]',
  ] as const;
  const CONTINUE_GENERATING_SELECTORS = [
    'button[data-testid*="continue"]',
    'button[aria-label*="Continue generating"]',
    'button[aria-label*="continue generating"]',
  ] as const;

  export function extractConversationId(pathname: string): string | undefined {
    const match = /^\/c\/([^/?#]+)/.exec(pathname);
    const rawId = match?.[1];
    if (rawId === undefined) return undefined;
    let decoded: string;
    try { decoded = decodeURIComponent(rawId); } catch { decoded = rawId; }
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
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function firstMatch<T extends Element>(document: Document, selectors: readonly string[]): T | undefined {
    for (const selector of selectors) {
      try {
        const element = document.querySelector<T>(selector);
        if (element !== null) return element;
      } catch {
        // DOM drift must remain observational and fail closed.
      }
    }
    return undefined;
  }

  function allMatches(document: Document, selectors: readonly string[]): Element[] {
    const found = new Set<Element>();
    for (const selector of selectors) {
      try { for (const element of document.querySelectorAll(selector)) found.add(element); } catch { /* ignore invalid/drifted selectors */ }
    }
    return [...found];
  }

  function assistantMatches(document: Document): Element[] { return allMatches(document, ASSISTANT_SELECTORS); }
  function userMatches(document: Document): Element[] { return allMatches(document, USER_SELECTORS); }

  function latestUserBeforeAssistant(document: Document, assistant: Element): Element | undefined {
    const users = userMatches(document);
    for (let index = users.length - 1; index >= 0; index -= 1) {
      const user = users[index];
      if (user === undefined) continue;
      try {
        const position = user.compareDocumentPosition(assistant);
        if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return user;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  function hasUserAfterAssistant(document: Document, assistant: Element): boolean {
    for (const user of userMatches(document)) {
      try {
        const position = assistant.compareDocumentPosition(user);
        if ((position & Node.DOCUMENT_POSITION_DISCONNECTED) !== 0) return true;
        if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  function containsStatusPrefix(value: string): boolean {
    return STATUS_PREFIXES.some((prefix) => value.includes(prefix));
  }

  function elementText(element: Element): string {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;

    const rendered = element instanceof HTMLElement && typeof element.innerText === "string"
      ? element.innerText
      : element.textContent ?? "";
    const structural = element.textContent ?? "";
    let selected = rendered;

    // Chromium may leave layout-derived innerText stale in background tabs while
    // structural DOM text already contains the completed assistant response.
    if (!containsStatusPrefix(rendered) && containsStatusPrefix(structural)) selected = structural;

    const querySelectorAll = (element as ParentNode).querySelectorAll;
    if (containsStatusPrefix(selected) && typeof querySelectorAll === "function") {
      try {
        const markerIsInCode = [...querySelectorAll.call(element, "pre, code")].some((code) =>
          containsStatusPrefix(code.textContent ?? ""),
        );
        if (markerIsInCode) return `${selected}\n[Guardian status rendered inside a code block]`;
      } catch {
        // Keep the observed text; parser ambiguity still fails safely.
      }
    }
    return selected;
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
    if (element.getAttribute("role") === "alert") {
      const id = element.getAttribute("id") ?? "";
      const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
      const inertAccessibilityRegion = id.startsWith("aria-notify-live-region-") || classes.includes("sr-only");
      if (!inertAccessibilityRegion && text.trim().length > 0) reasons.add("ERROR");
    }
    const testId = (element.getAttribute("data-testid") ?? "").toLowerCase();
    if (testId.includes("error")) reasons.add("ERROR");
    if (testId.includes("rate-limit")) reasons.add("RATE_LIMIT");
    const lowered = text.toLowerCase();
    if (/rate limit|too many requests|try again later|usage limit/.test(lowered)) reasons.add("RATE_LIMIT");
    if (/log in|sign in|session expired|authentication/.test(lowered)) reasons.add("AUTH");
    if (/network error|connection error|offline|reconnect/.test(lowered)) reasons.add("NETWORK");
    if (/captcha|verify you are human|human verification/.test(lowered)) reasons.add("CAPTCHA");
    if (/verify (your )?account|account verification/.test(lowered)) reasons.add("ACCOUNT_VERIFICATION");
    if (/confirm|confirmation required|are you sure|permission required/.test(lowered)) reasons.add("CONFIRMATION_REQUIRED");
    if (/conversation (?:is )?(?:full|at (?:its )?limit)|context (?:is )?full|new chat required|start a new chat/.test(lowered)) {
      reasons.add("CONVERSATION_FULL");
    }
    if (/error|something went wrong|failed/.test(lowered)) reasons.add("ERROR");
    return [...reasons];
  }

  function controlTextMatches(document: Document, pattern: RegExp): boolean {
    try {
      return [...document.querySelectorAll("button")].some((button) => {
        const aria = button.getAttribute("aria-label") ?? "";
        const testId = button.getAttribute("data-testid") ?? "";
        const text = button.textContent ?? "";
        return pattern.test(`${aria} ${testId} ${text}`);
      });
    } catch {
      return false;
    }
  }

  function targetMatches(target: EventTarget | null, selectors: readonly string[]): boolean {
    if (!(target instanceof Element)) return false;
    return selectors.some((selector) => {
      try { return target.matches(selector) || target.closest(selector) !== null; } catch { return false; }
    });
  }

  export class BrowserChatGPTAdapter {
    readonly #document: Document;
    readonly #location: Pick<Location, "pathname">;

    constructor(document: Document, location: Pick<Location, "pathname">) {
      this.#document = document;
      this.#location = location;
    }

    currentRouteKey(): string { return routeKey(this.#location.pathname); }
    currentConversationId(): string | undefined { return extractConversationId(this.#location.pathname); }

    isComposerTarget(target: EventTarget | null): boolean {
      if (!(target instanceof Node)) return false;
      const composer = firstMatch<HTMLElement>(this.#document, COMPOSER_SELECTORS);
      return composer !== undefined && (target === composer || composer.contains(target));
    }

    isManualSendTarget(target: EventTarget | null): boolean { return targetMatches(target, SEND_SELECTORS); }
    isStopGenerationTarget(target: EventTarget | null): boolean { return targetMatches(target, STOP_SELECTORS); }
    isEditTurnTarget(target: EventTarget | null): boolean { return targetMatches(target, EDIT_SELECTORS); }
    isBlockingInteractionTarget(target: EventTarget | null): boolean { return targetMatches(target, BLOCKING_SELECTORS); }

    async observe(observedAt = Date.now()): Promise<PageObservation> {
      const conversationId = this.currentConversationId();
      const composer = firstMatch<HTMLElement>(this.#document, COMPOSER_SELECTORS);
      const stopControl = firstMatch<HTMLElement>(this.#document, STOP_SELECTORS);
      const latestAssistantCandidate = assistantMatches(this.#document).at(-1);
      const latestAssistantElement = latestAssistantCandidate !== undefined && !hasUserAfterAssistant(this.#document, latestAssistantCandidate)
        ? latestAssistantCandidate
        : undefined;
      const latestUserElement = latestAssistantElement === undefined
        ? undefined
        : latestUserBeforeAssistant(this.#document, latestAssistantElement);

      const reasons = new Set<BlockingReason>();
      for (const surface of allMatches(this.#document, BLOCKING_SELECTORS)) {
        const text = normalizeAssistantText(elementText(surface)).slice(0, 2_000);
        for (const reason of blockingReasons(surface, text)) reasons.add(reason);
      }

      const retryAvailable = firstMatch<HTMLElement>(this.#document, RETRY_SELECTORS) !== undefined ||
        controlTextMatches(this.#document, /\bretry\b|\btry again\b/i);
      const continueGeneratingAvailable = firstMatch<HTMLElement>(this.#document, CONTINUE_GENERATING_SELECTORS) !== undefined ||
        controlTextMatches(this.#document, /continue generating/i);
      const generation: GenerationState = stopControl !== undefined ? "GENERATING" : composer !== undefined ? "IDLE" : "UNKNOWN";
      const composerText = composer === undefined ? "" : elementText(composer);
      const activeElement = this.#document.activeElement;
      const composerFocused = composer !== undefined && activeElement !== null && (composer === activeElement || composer.contains(activeElement));
      const pageTitle = typeof this.#document.title === "string"
        ? normalizeAssistantText(this.#document.title).slice(0, MAX_PAGE_TITLE_CHARS)
        : "";

      const observation: PageObservation = {
        routeKey: this.currentRouteKey(),
        ...(pageTitle.length === 0 ? {} : { pageTitle }),
        generation,
        composer: {
          present: composer !== undefined,
          hasText: normalizeAssistantText(composerText).length > 0,
          focused: composerFocused,
        },
        blocking: { blocked: reasons.size > 0, reasons: [...reasons].sort() },
        actions: { retryAvailable, continueGeneratingAvailable },
        confidence: conversationId !== undefined && (composer !== undefined || latestAssistantElement !== undefined) ? "HIGH" : "LOW",
        observedAt,
        ...(conversationId === undefined ? {} : { conversationId }),
      };

      if (latestUserElement !== undefined) {
        const normalizedText = normalizeAssistantText(elementText(latestUserElement));
        if (normalizedText.length > 0) {
          const domMessageId = readMessageId(latestUserElement);
          observation.latestUser = {
            normalizedText: normalizedText.slice(-MAX_NORMALIZED_RESPONSE_CHARS),
            textLength: normalizedText.length,
            ...(domMessageId === undefined ? {} : { domMessageId }),
          };
        }
      }

      if (latestAssistantElement !== undefined) {
        const normalizedText = normalizeAssistantText(elementText(latestAssistantElement));
        if (normalizedText.length > 0) {
          const domMessageId = readMessageId(latestAssistantElement);
          observation.latestAssistant = {
            normalizedText: normalizedText.slice(-MAX_NORMALIZED_RESPONSE_CHARS),
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
