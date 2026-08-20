import type { TelegramHealthCode } from "./types.js";

export const TELEGRAM_ORIGIN_PATTERN = "https://api.telegram.org/*";
const DEFAULT_TIMEOUT_MS = 10_000;

export class TelegramDeliveryError extends Error {
  readonly code: TelegramHealthCode;

  constructor(code: TelegramHealthCode) {
    super(telegramDeliveryErrorMessage(code));
    this.name = "TelegramDeliveryError";
    this.code = code;
  }
}

export interface TelegramTransport {
  send(botToken: string, destination: string, text: string): Promise<void>;
}

function telegramDeliveryErrorMessage(code: TelegramHealthCode): string {
  switch (code) {
    case "TIMEOUT": return "Telegram delivery timed out.";
    case "RATE_LIMIT": return "Telegram rate limited the notification.";
    case "AUTHENTICATION": return "Telegram rejected the bot credential.";
    case "DESTINATION": return "Telegram rejected the configured destination or bot access.";
    case "NETWORK": return "Telegram could not be reached.";
    case "API_ERROR": return "Telegram returned an unsuccessful response.";
  }
}

function errorCodeForStatus(status: number): TelegramHealthCode {
  if (status === 429) return "RATE_LIMIT";
  if (status === 401 || status === 404) return "AUTHENTICATION";
  if (status === 400 || status === 403) return "DESTINATION";
  return "API_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bodyErrorCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.error_code === "number" && Number.isInteger(value.error_code) ? value.error_code : undefined;
}

export class TelegramBotApiTransport implements TelegramTransport {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async send(botToken: string, destination: string, text: string): Promise<void> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: destination, text }),
        signal: controller.signal,
        redirect: "error",
        referrerPolicy: "no-referrer",
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new TelegramDeliveryError(errorCodeForStatus(response.status));
      }

      if (!response.ok) throw new TelegramDeliveryError(errorCodeForStatus(response.status));
      if (!isRecord(body) || body.ok !== true) {
        throw new TelegramDeliveryError(errorCodeForStatus(bodyErrorCode(body) ?? response.status));
      }
    } catch (error) {
      if (error instanceof TelegramDeliveryError) throw error;
      if (controller.signal.aborted) throw new TelegramDeliveryError("TIMEOUT");
      throw new TelegramDeliveryError("NETWORK");
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}
