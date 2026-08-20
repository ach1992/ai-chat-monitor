# Chat Turn Guardian Privacy Policy

Last updated: August 20, 2026

Chat Turn Guardian is a Chromium extension whose single purpose is to supervise user-selected ChatGPT Web conversations and, only when its safety gates allow, request a configured continuation turn. It does not operate a developer-owned backend, analytics service, advertising service, or data broker.

This policy describes the data handled by the extension, why it is handled, where it is stored, and when it is sent to services the user chooses to configure.

## Data processed on supported ChatGPT pages

Chat Turn Guardian runs content scripts only on the supported ChatGPT Web origins declared in the extension manifest. To provide supervision, it processes page state such as conversation/route identity, generation state, blocking UI, composer state, user interaction timing, and recent visible user/assistant turn content.

Full conversation text is not persisted in the extension's audit history. Recent turn text may be held transiently in extension memory while the current page state is being evaluated. The extension derives bounded fingerprints and structured state needed for stale-state detection, ownership isolation, guarded-send revalidation, reliability checks, and audit diagnostics.

## AI classifier providers

AI classification is optional. If the user configures OpenRouter, NaraRouter, or a generic OpenAI-compatible HTTPS provider, Chat Turn Guardian may send a minimized recent conversation context to that selected provider when an ambiguous finished response needs classification.

Before provider transport, Chat Turn Guardian:

- limits context to at most 4 recent turns;
- limits each turn to at most 4,000 characters and total context to at most 8,000 characters;
- minimizes large code/log blocks;
- redacts common API-key, bearer-token, and token-like patterns; and
- sends only the classification context needed to return an advisory `CONTINUE`, `HOLD`, or `UNSURE` result.

Provider requests are sent directly from the trusted extension context to the provider endpoint over HTTPS. Automatic redirects are refused. The selected provider receives the transmitted context, model request, and the provider credential supplied by the user. Provider handling of that data is governed by the provider's own terms and privacy policy.

Chat Turn Guardian does not give any AI provider access to the DOM, browser tabs, approval authority, guarded-send mutation, or other extension credentials. Provider output is advisory and cannot authorize a send by itself.

## Telegram notifications

Telegram is optional and outbound-only. If the user configures and enables Telegram notifications, the extension sends notifications directly from the trusted extension context to the official Telegram Bot API over HTTPS using the bot token and destination supplied by the user.

Telegram v1 sends bounded Guardian notification metadata: the Guardian notification title, a bounded event/reason message, and a bounded conversation identifier when available. It does not send full chat transcripts or full ChatGPT messages. A Test notification contains only a fixed Chat Turn Guardian test message.

The user's Telegram bot token is a credential. It is stored only in trusted extension storage and is never returned in ordinary status APIs, rendered back into the Side Panel, written to audit history, or included in displayed transport errors. Telegram receives the Bot API request required to deliver the notification. Telegram's handling of that data is governed by Telegram's own terms and privacy policy.

Telegram cannot approve, control, or inject ChatGPT turns. Telegram delivery success or failure cannot change classifier output, `AUTO`/`HOLD` semantics, ownership, guarded-send authority, or conversation content.

## Browser notifications

Browser notifications are generated locally through the Chromium notifications API. Enabling Telegram does not replace browser notifications. Browser notification delivery does not send notification content to a Chat Turn Guardian-operated service.

## Data stored by the extension

Chat Turn Guardian uses Chromium extension storage for the minimum state needed to provide its features. Depending on configuration, this can include:

- automation policies and per-conversation settings;
- provider profiles, including provider API keys;
- Telegram configuration, including the bot token and destination;
- bounded audit/reliability metadata and fingerprints; and
- short-lived runtime/journal state used to reconcile guarded sends safely.

Durable credential-bearing storage is restricted to trusted extension contexts. Provider API keys and Telegram bot tokens are not exposed to ChatGPT page scripts or content scripts.

Provider credentials are removed when their provider profile is removed. A Telegram bot token remains stored while that Telegram configuration exists, including while Telegram delivery is disabled; entering a new token replaces it. Extension data can also be removed by uninstalling the extension or clearing its extension storage through the browser.

## Host permissions

Persistent host access is limited to the supported ChatGPT Web origins because page supervision is the extension's primary user-facing purpose.

The manifest also declares optional `https://*/*` host permission as a runtime envelope. This does not grant broad website access at installation. It allows the user to configure an arbitrary HTTPS OpenAI-compatible provider endpoint. When provider or Telegram access is needed, the Side Panel requests permission for the exact origin involved. Provider-origin permissions that are no longer used are removed on a best-effort basis.

## Data sharing and sales

Chat Turn Guardian does not sell user data. It does not use user data for advertising, credit-worthiness, or unrelated profiling. It does not transfer user data to a developer-operated server.

Data is shared only with an external provider or Telegram when the user enables the corresponding feature and the transfer is necessary to provide that feature, as described above.

## Security and limited use

Chat Turn Guardian limits collection, use, and transmission of user data to the extension's disclosed single purpose and related security/reliability operations. Credentials are kept in trusted extension storage; external transports require HTTPS; transport errors are sanitized; provider redirects are refused; and external notification/classification systems are isolated from chat mutation authority.

## Changes to this policy

If runtime data handling changes materially, this policy and the relevant in-product disclosures will be updated before that changed handling is released. Historical versions remain available through the public Git repository.

## Contact

Privacy questions and reports can be submitted through the public Chat Turn Guardian GitHub repository's issue tracker: `https://github.com/ach1992/chat-turn-guardian/issues`.
