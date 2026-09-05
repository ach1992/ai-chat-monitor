(() => {
  const CHANNEL = "AI_CHAT_MONITOR_HIDDEN_RESPONSE_V1";
  const MAX_CONVERSATION_ID_CHARS = 200;
  const MAX_MESSAGE_ID_CHARS = 200;
  const MAX_STATUS_CHARS = 80;
  const MAX_TEXT_CHARS = 262_144;
  const MAX_PARENT_HOPS = 24;

  type MarkerHealth = "DETECTED" | "MISSING" | "MALFORMED";
  type SemanticDecision =
    | "CONTINUE"
    | "HOLD_APPROVAL"
    | "HOLD_DECISION"
    | "HOLD_HUMAN_OPERATION"
    | "COMPLETE"
    | "PLATFORM_ERROR"
    | "RATE_LIMIT"
    | "UNSURE";

  interface ControlMessage {
    channel: typeof CHANNEL;
    type: "control";
    protocolVersion: 1;
    enabled: boolean;
    conversationId?: string;
  }

  interface ServerCompletionEvidence {
    conversationId: string;
    assistantMessageId: string;
    parentUserMessageId: string;
    messageStatus: string;
    endTurn: boolean;
    markerHealth: MarkerHealth;
    semanticDecision?: SemanticDecision;
    assistantTextLength: number;
  }

  if (typeof window.fetch !== "function") return;
  const originalFetch = window.fetch.bind(window);
  let enabled = false;
  let armedConversationId: string | undefined;
  let readbackStarted = false;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function boundedId(value: unknown, max = MAX_MESSAGE_ID_CHARS): string | undefined {
    return typeof value === "string" && /^[A-Za-z0-9_-]{4,200}$/.test(value)
      ? value.slice(0, max)
      : undefined;
  }

  function isControlMessage(value: unknown): value is ControlMessage {
    if (!isRecord(value) || value.channel !== CHANNEL || value.type !== "control" || value.protocolVersion !== 1) return false;
    if (typeof value.enabled !== "boolean") return false;
    if (value.conversationId !== undefined && boundedId(value.conversationId, MAX_CONVERSATION_ID_CHARS) === undefined) return false;
    return true;
  }

  function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
    if (typeof init?.method === "string" && init.method.length > 0) return init.method.toUpperCase();
    if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
    return "GET";
  }

  function requestPath(input: RequestInfo | URL): string | undefined {
    try {
      const raw = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof Request !== "undefined" && input instanceof Request
            ? input.url
            : undefined;
      if (raw === undefined) return undefined;
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return undefined;
      if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return undefined;
      return url.pathname;
    } catch {
      return undefined;
    }
  }

  function currentConversationId(): string | undefined {
    try {
      return boundedId(/(?:^|\/)c\/([^/]+)(?:\/|$)/.exec(new URL(location.href).pathname)?.[1], MAX_CONVERSATION_ID_CHARS);
    } catch {
      return undefined;
    }
  }

  function collectText(content: unknown): string {
    if (!isRecord(content)) return "";
    const parts = content.parts;
    if (!Array.isArray(parts)) {
      const text = typeof content.text === "string" ? content.text : "";
      return text.slice(0, MAX_TEXT_CHARS);
    }

    const chunks: string[] = [];
    let length = 0;
    for (const part of parts.slice(0, 256)) {
      let value: string | undefined;
      if (typeof part === "string") value = part;
      else if (isRecord(part)) {
        if (typeof part.text === "string") value = part.text;
        else if (typeof part.content === "string") value = part.content;
      }
      if (value === undefined || value.length === 0) continue;
      const remaining = MAX_TEXT_CHARS - length;
      if (remaining <= 0) break;
      const bounded = value.slice(0, remaining);
      chunks.push(bounded);
      length += bounded.length;
    }
    return chunks.join("\n");
  }

  const ALLOWED_DECISIONS = new Set<SemanticDecision>([
    "CONTINUE",
    "HOLD_APPROVAL",
    "HOLD_DECISION",
    "HOLD_HUMAN_OPERATION",
    "COMPLETE",
    "PLATFORM_ERROR",
    "RATE_LIMIT",
    "UNSURE",
  ]);
  const STATUS_PREFIX = "AI_CHAT_MONITOR_STATUS=";

  function markerAppearsInsideOpenFence(lines: string[], markerLineIndex: number): boolean {
    let openFence: { char: "`" | "~"; length: number } | undefined;
    for (let index = 0; index < markerLineIndex; index += 1) {
      const token = /^\s*(`{3,}|~{3,})/.exec(lines[index] ?? "")?.[1];
      if (token === undefined) continue;
      const char = token[0] as "`" | "~";
      if (openFence === undefined) {
        openFence = { char, length: token.length };
      } else if (char === openFence.char && token.length >= openFence.length) {
        openFence = undefined;
      }
    }
    return openFence !== undefined;
  }

  function inspectMarker(raw: string): { health: MarkerHealth; decision?: SemanticDecision } {
    const normalized = raw.replace(/\r\n?/g, "\n").trimEnd();
    if (normalized.length === 0) return { health: "MISSING" };

    let count = 0;
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(STATUS_PREFIX, offset);
      if (index < 0) break;
      count += 1;
      offset = index + STATUS_PREFIX.length;
    }
    if (count === 0) return { health: "MISSING" };
    if (count !== 1) return { health: "MALFORMED" };

    const lines = normalized.split("\n");
    const terminalLine = lines.at(-1)?.trim() ?? "";
    if (!terminalLine.startsWith(STATUS_PREFIX)) return { health: "MALFORMED" };
    if (markerAppearsInsideOpenFence(lines, lines.length - 1)) return { health: "MALFORMED" };

    const match = /^\{\s*"decision"\s*:\s*"([A-Z_]+)"\s*\}$/.exec(
      terminalLine.slice(STATUS_PREFIX.length).trim(),
    );
    const decision = match?.[1];
    if (decision === undefined || !ALLOWED_DECISIONS.has(decision as SemanticDecision)) {
      return { health: "MALFORMED" };
    }
    return { health: "DETECTED", decision: decision as SemanticDecision };
  }

  function nodeMessage(node: unknown): Record<string, unknown> | undefined {
    return isRecord(node) && isRecord(node.message) ? node.message : undefined;
  }

  function nodeParent(node: unknown): string | undefined {
    return isRecord(node) ? boundedId(node.parent) : undefined;
  }

  function messageRole(message: Record<string, unknown> | undefined): string | undefined {
    if (message === undefined || !isRecord(message.author)) return undefined;
    return typeof message.author.role === "string" ? message.author.role : undefined;
  }

  function extractCurrentAssistant(payload: unknown, conversationId: string): ServerCompletionEvidence | undefined {
    if (!isRecord(payload) || !isRecord(payload.mapping)) return undefined;
    const mapping = payload.mapping;
    let nodeId = boundedId(payload.current_node) ?? boundedId(payload.currentNode);
    if (nodeId === undefined) return undefined;

    let assistantNode: Record<string, unknown> | undefined;
    let assistantMessage: Record<string, unknown> | undefined;
    for (let hop = 0; hop < MAX_PARENT_HOPS && nodeId !== undefined; hop += 1) {
      const node = mapping[nodeId];
      const message = nodeMessage(node);
      if (messageRole(message) === "assistant") {
        assistantNode = isRecord(node) ? node : undefined;
        assistantMessage = message;
        break;
      }
      nodeId = nodeParent(node);
    }
    if (assistantNode === undefined || assistantMessage === undefined) return undefined;

    const assistantMessageId = boundedId(assistantMessage.id) ?? boundedId(assistantNode.id);
    if (assistantMessageId === undefined) return undefined;

    let parentNodeId = nodeParent(assistantNode);
    let parentUserMessageId: string | undefined;
    for (let hop = 0; hop < MAX_PARENT_HOPS && parentNodeId !== undefined; hop += 1) {
      const node = mapping[parentNodeId];
      const message = nodeMessage(node);
      if (messageRole(message) === "user") {
        parentUserMessageId = boundedId(message?.id) ?? (isRecord(node) ? boundedId(node.id) : undefined);
        break;
      }
      parentNodeId = nodeParent(node);
    }
    if (parentUserMessageId === undefined) return undefined;

    const messageStatus = typeof assistantMessage.status === "string"
      ? assistantMessage.status.slice(0, MAX_STATUS_CHARS)
      : "";
    const endTurn = assistantMessage.end_turn === true || assistantMessage.endTurn === true;
    if (messageStatus !== "finished_successfully" || !endTurn) return undefined;

    const text = collectText(assistantMessage.content);
    const marker = inspectMarker(text);
    return {
      conversationId,
      assistantMessageId,
      parentUserMessageId,
      messageStatus,
      endTurn,
      markerHealth: marker.health,
      ...(marker.decision === undefined ? {} : { semanticDecision: marker.decision }),
      assistantTextLength: text.length,
    };
  }

  function postEvidence(evidence: ServerCompletionEvidence): void {
    window.postMessage({
      channel: CHANNEL,
      type: "server-completion-evidence",
      protocolVersion: 1,
      evidence,
    }, location.origin);
  }

  async function readCanonicalConversation(conversationId: string): Promise<void> {
    try {
      const response = await originalFetch(`/backend-api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) return;
      const payload: unknown = await response.json();
      const evidence = extractCurrentAssistant(payload, conversationId);
      if (evidence !== undefined) postEvidence(evidence);
    } catch {
      // Fail closed: hidden completion evidence is optional unless it is exact and readable.
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || !isControlMessage(event.data)) return;
    enabled = event.data.enabled;
    if (!enabled) {
      armedConversationId = undefined;
      readbackStarted = false;
      return;
    }
    const conversationId = boundedId(event.data.conversationId, MAX_CONVERSATION_ID_CHARS) ?? currentConversationId();
    if (conversationId === undefined) return;
    armedConversationId = conversationId;
    readbackStarted = false;
  });

  const monitoredFetch: typeof window.fetch = async (...args) => {
    const method = requestMethod(args[0], args[1]);
    const path = requestPath(args[0]);
    const conversationIdAtStart = armedConversationId;
    const shouldReadback = enabled &&
      !readbackStarted &&
      conversationIdAtStart !== undefined &&
      document.visibilityState === "hidden" &&
      method === "POST" &&
      path === "/backend-api/f/conversation/prepare";

    const response = await originalFetch(...args);
    if (shouldReadback && armedConversationId === conversationIdAtStart && response.ok) {
      readbackStarted = true;
      void readCanonicalConversation(conversationIdAtStart);
    }
    return response;
  };

  window.fetch = monitoredFetch;
})();
