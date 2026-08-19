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
  export type GuardedHumanStateCheck = () => boolean;

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
    confidence: ObservationConfidence;
    observedAt: number;
  }

  export interface GuardedContinuationExpectation {
    decisionId: string;
    conversationId: string;
    routeKey: string;
    assistantFingerprint: string;
    assistantDomMessageId?: string;
    continuationText: string;
  }

  export interface PageGuardedSendResult {
    decisionId: string;
    status: "NOT_STARTED" | "VERIFIED" | "AMBIGUOUS";
    reason: string;
    observedConversationId?: string;
    observedAssistantFingerprint?: string;
  }

  const MAX_NORMALIZED_RESPONSE_CHARS = 12_000;
  const MAX_PAGE_TITLE_CHARS = 300;
  const SEND_VERIFICATION_TIMEOUT_MS = 5_000;
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
        // DOM drift must fail closed.
      }
    }
    return undefined;
  }

  function allMatches(document: Document, selectors: readonly string[]): Element[] {
    const found = new Set<Element>();
    for (const selector of selectors) {
      try { for (const element of document.querySelectorAll(selector)) found.add(element); } catch { /* fail closed */ }
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
        if ((user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return user;
      } catch {
        // DOM drift must not guess at turn ordering.
      }
    }
    return undefined;
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
    if (/error|something went wrong|failed/.test(lowered)) reasons.add("ERROR");
    return [...reasons];
  }

  function pageHasBlockingUi(document: Document): boolean {
    return allMatches(document, BLOCKING_SELECTORS).some((surface) => {
      const text = normalizeAssistantText(elementText(surface)).slice(0, 2_000);
      return blockingReasons(surface, text).length > 0;
    });
  }

  function targetMatches(target: EventTarget | null, selectors: readonly string[]): boolean {
    if (!(target instanceof Element)) return false;
    return selectors.some((selector) => {
      try { return target.matches(selector) || target.closest(selector) !== null; } catch { return false; }
    });
  }

  function sendControlIsUsable(element: HTMLElement): boolean {
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    return element.getAttribute("aria-disabled") !== "true";
  }

  function setComposerText(composer: HTMLElement, text: string): boolean {
    try {
      if (composer instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (setter !== undefined) setter.call(composer, text); else composer.value = text;
      } else if (composer instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter !== undefined) setter.call(composer, text); else composer.value = text;
      } else if (composer.isContentEditable) {
        composer.textContent = text;
      } else {
        return false;
      }
      try {
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      } catch {
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return normalizeAssistantText(elementText(composer)) === normalizeAssistantText(text);
    } catch {
      return false;
    }
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
      const latestAssistantElement = assistantMatches(this.#document).at(-1);
      const latestUserElement = latestAssistantElement === undefined
        ? undefined
        : latestUserBeforeAssistant(this.#document, latestAssistantElement);
      const blockingSurfaces = allMatches(this.#document, BLOCKING_SELECTORS);
      const reasons = new Set<BlockingReason>();
      for (const surface of blockingSurfaces) {
        const text = normalizeAssistantText(elementText(surface)).slice(0, 2_000);
        for (const reason of blockingReasons(surface, text)) reasons.add(reason);
      }
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
        composer: { present: composer !== undefined, hasText: normalizeAssistantText(composerText).length > 0, focused: composerFocused },
        blocking: { blocked: reasons.size > 0, reasons: [...reasons].sort() },
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

    async guardedSend(
      expectation: GuardedContinuationExpectation,
      humanStateIsCurrent: GuardedHumanStateCheck = () => true,
    ): Promise<PageGuardedSendResult> {
      const reject = (reason: string): PageGuardedSendResult => ({ decisionId: expectation.decisionId, status: "NOT_STARTED", reason });
      const ambiguous = (reason: string): PageGuardedSendResult => ({ decisionId: expectation.decisionId, status: "AMBIGUOUS", reason });
      const observation = await this.observe();
      if (
        !humanStateIsCurrent() ||
        observation.conversationId !== expectation.conversationId ||
        observation.routeKey !== expectation.routeKey ||
        observation.confidence !== "HIGH" ||
        observation.generation !== "IDLE" ||
        observation.blocking.blocked ||
        !observation.composer.present ||
        observation.composer.hasText ||
        observation.latestAssistant?.fingerprint !== expectation.assistantFingerprint ||
        (expectation.assistantDomMessageId !== undefined && observation.latestAssistant.domMessageId !== expectation.assistantDomMessageId)
      ) {
        return reject("Final page identity, human interaction, or UI safety guard did not match the decision envelope.");
      }

      const capturedAssistant = assistantMatches(this.#document).at(-1);
      if (capturedAssistant === undefined) return reject("Latest assistant response disappeared before mutation.");
      const capturedAssistantText = normalizeAssistantText(elementText(capturedAssistant));
      const capturedAssistantFingerprint = await fingerprintText(capturedAssistantText);

      const currentAssistant = assistantMatches(this.#document).at(-1);
      const composer = firstMatch<HTMLElement>(this.#document, COMPOSER_SELECTORS);
      const currentAssistantText = currentAssistant === undefined ? "" : normalizeAssistantText(elementText(currentAssistant));
      const currentMessageId = currentAssistant === undefined ? undefined : readMessageId(currentAssistant);

      if (
        !humanStateIsCurrent() ||
        this.currentConversationId() !== expectation.conversationId ||
        this.currentRouteKey() !== expectation.routeKey ||
        capturedAssistantFingerprint !== expectation.assistantFingerprint ||
        currentAssistantText !== capturedAssistantText ||
        (expectation.assistantDomMessageId !== undefined && currentMessageId !== expectation.assistantDomMessageId) ||
        composer === undefined ||
        normalizeAssistantText(elementText(composer)).length > 0 ||
        firstMatch<HTMLElement>(this.#document, STOP_SELECTORS) !== undefined ||
        pageHasBlockingUi(this.#document)
      ) {
        return reject("Synchronous pre-mutation revalidation detected changed page or human state.");
      }

      const usersBefore = userMatches(this.#document);
      const userCountBefore = usersBefore.length;
      const latestUserBefore = usersBefore.at(-1);
      const latestUserTextBefore = latestUserBefore === undefined ? undefined : normalizeAssistantText(elementText(latestUserBefore));
      if (!setComposerText(composer, expectation.continuationText)) {
        return ambiguous("Composer mutation started but the intended continuation text could not be confirmed.");
      }

      const postMutationAssistant = assistantMatches(this.#document).at(-1);
      const postMutationSendControl = firstMatch<HTMLElement>(this.#document, SEND_SELECTORS);
      if (
        this.currentConversationId() !== expectation.conversationId ||
        this.currentRouteKey() !== expectation.routeKey ||
        postMutationAssistant === undefined ||
        normalizeAssistantText(elementText(postMutationAssistant)) !== capturedAssistantText ||
        firstMatch<HTMLElement>(this.#document, STOP_SELECTORS) !== undefined ||
        pageHasBlockingUi(this.#document) ||
        postMutationSendControl === undefined ||
        !sendControlIsUsable(postMutationSendControl)
      ) {
        return ambiguous("Page safety state changed after composer mutation and before send.");
      }

      try {
        postMutationSendControl.click();
      } catch {
        return ambiguous("Send control invocation failed after composer mutation.");
      }

      const verified = await this.#verifySend(
        expectation,
        userCountBefore,
        latestUserTextBefore,
        SEND_VERIFICATION_TIMEOUT_MS,
      );
      if (!verified) {
        return ambiguous("The intended user turn and generation start could not both be verified.");
      }
      return {
        decisionId: expectation.decisionId,
        status: "VERIFIED",
        reason: "Intended user turn appeared and generation started.",
        observedConversationId: expectation.conversationId,
        observedAssistantFingerprint: expectation.assistantFingerprint,
      };
    }

    #verifySend(
      expectation: GuardedContinuationExpectation,
      userCountBefore: number,
      latestUserTextBefore: string | undefined,
      timeoutMs: number,
    ): Promise<boolean> {
      return new Promise((resolve) => {
        let settled = false;
        let sawUserTurn = false;
        let sawGeneration = false;
        const finish = (value: boolean): void => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearTimeout(timeout);
          resolve(value);
        };
        const check = (): void => {
          if (
            this.currentConversationId() !== expectation.conversationId ||
            this.currentRouteKey() !== expectation.routeKey
          ) {
            finish(false);
            return;
          }
          const users = userMatches(this.#document);
          const latestUser = users.at(-1);
          if (latestUser !== undefined) {
            const latestText = normalizeAssistantText(elementText(latestUser));
            if (
              latestText === normalizeAssistantText(expectation.continuationText) &&
              (users.length > userCountBefore || latestUserTextBefore !== latestText)
            ) {
              sawUserTurn = true;
            }
          }
          if (firstMatch<HTMLElement>(this.#document, STOP_SELECTORS) !== undefined) sawGeneration = true;
          if (sawUserTurn && sawGeneration) finish(true);
        };
        const observer = new MutationObserver(check);
        observer.observe(this.#document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        const timeout = setTimeout(() => finish(false), timeoutMs);
        check();
      });
    }
  }
}