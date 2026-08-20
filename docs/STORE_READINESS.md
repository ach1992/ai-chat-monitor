# Chrome Web Store Readiness

Chat Turn Guardian is developed so that a later public Chrome Web Store release does not require weakening its security, privacy, or architecture boundaries.

This document records durable engineering constraints and current implementation choices. It is not a claim that the extension is already published or approved by Google. Chrome Web Store policies are version-sensitive and must be re-verified against current official Chrome documentation immediately before submission.

## Current release architecture

- Manifest V3, Chrome/Chromium 114+.
- Production extension/action icon set at 16, 32, 48, and 128 pixels under `src/assets/`.
- Toolbar action opens the Side Panel through `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` while unsupported tabs remain disabled by explicit per-tab host gating.
- No remotely hosted executable code. Provider and Telegram network responses are data only and are never evaluated as extension logic.
- `scripts/lint.mjs` rejects `eval()`, `new Function()`, remote `importScripts()`, remote dynamic imports, and remotely hosted `<script>` sources in extension source.
- Release packaging is deterministic, verifies every manifest-referenced icon, requires `manifest.json` and `package.json` versions to match, and excludes TypeScript, source maps, `.env` files, and unrelated development artifacts.

## Product and authority constraints

- Keep one narrow, understandable product purpose: supervise explicitly selected ChatGPT conversations, safely continue needless turn boundaries, and notify the user when configured.
- Preserve fail-closed automation, human precedence, exact session identity, OWNER/MIRROR isolation, no blind retry, provider/notification transport isolation, and secret isolation.
- Treat provider API keys and Telegram bot tokens as credentials. Keep them in trusted extension storage and never expose them to page/content contexts, ordinary status responses, logs, audit history, screenshots, or listing metadata.
- Keep external data transfer minimized and purpose-bound. Classifier context is bounded/redacted; Telegram v1 sends bounded notification metadata and never exports full ChatGPT messages.
- Keep notification channels observational. Delivery failure or rate limiting must never change classifier decisions or browser mutation authority.
- Keep the codebase modular so notification channels, provider adapters, page adapters, and release surfaces can evolve without coupling them to guarded-send authority.

## Permission model and justifications

### Required extension permissions

- `storage`: user-selected policies, provider/Telegram configuration and credentials, bounded audit/reliability state, and guarded-send recovery state.
- `sidePanel`: the primary configuration/status surface and toolbar-action destination.
- `notifications`: local browser notifications for configured Guardian events.

### Persistent ChatGPT host permissions

`https://chatgpt.com/*` and `https://chat.openai.com/*` are required for the single user-facing purpose. Content scripts must observe the supported ChatGPT page, bind exact conversation/response identity, detect human interaction and platform blockers, and perform the narrow guarded continuation only after final synchronous revalidation.

### Optional HTTPS host envelope

`optional_host_permissions: ["https://*/*"]` is intentionally retained because the implemented generic OpenAI-compatible provider feature allows a user to enter an arbitrary HTTPS provider origin that cannot be known at install time.

This declaration is an optional runtime envelope, not install-time access to every HTTPS site. The Side Panel requests only the exact provider origin selected by the user. Telegram requests only `https://api.telegram.org/*`. Provider origins no longer referenced by any profile are revoked on a best-effort basis. Do not replace this with a misleading hardcoded provider allowlist merely to avoid the wildcard; instead keep the runtime request narrow and the Store justification accurate.

## Privacy and disclosure surfaces

The public privacy policy is [`PRIVACY.md`](../PRIVACY.md). It must stay synchronized with actual runtime behavior.

The Side Panel prominently discloses that Guardian processes supported ChatGPT page state and recent visible chat content, that full chat transcripts are not stored, that optional AI classification transfers a minimized secret-redacted recent context to the selected provider, and that optional Telegram transfers only bounded notification metadata.

Provider-specific disclosure states the current classification limit of at most 4 recent turns and 8,000 total characters after secret redaction. Telegram-specific disclosure states that Telegram v1 never sends full ChatGPT messages and accepts no inbound commands.

The privacy policy affirmatively states adherence to the Chrome Web Store User Data Policy, including Limited Use requirements, and documents every current external data recipient: the user-selected AI provider and Telegram when enabled. There is no developer-operated backend, analytics service, advertising service, or data broker.

The authoritative submission copy and privacy-practice justifications are in [`docs/CHROME_WEB_STORE_LISTING.md`](CHROME_WEB_STORE_LISTING.md).

## Store assets

- extension/store icon: `src/assets/icon-128.png`;
- small promotional tile: `store-assets/small-promo-440x280.png`;
- optional marquee image: `store-assets/marquee-1400x560.png`.

At least one Store screenshot must be captured from the real current extension experience at 1280x800 or 640x400. Do not fabricate a screenshot of a future or mocked UI. Real screenshots must not expose provider keys, Telegram bot tokens, sensitive ChatGPT content, or other private data.

## Release validation

Before submission:

1. Re-verify current official Chrome Web Store Developer Program Policies, user-data/limited-use requirements, current permission APIs, and listing-asset requirements.
2. Run `npm ci`, `npm run validate`, `npm run smoke:extension`, and `npm run package` against the exact release commit SHA.
3. Verify `artifacts/SHA256SUMS.txt` and `artifacts/build-info.json` provenance for that SHA.
4. Confirm the ZIP contains only the intended built extension payload and no `.ts`, `.map`, `.env`, credentials, or unrelated artifacts.
5. Validate every feature advertised in the Store listing against a production-like unpacked build.
6. Capture real Store screenshots only after that live validation passes.
7. Reconcile the Developer Dashboard Privacy practices checkboxes against current runtime behavior and current Dashboard wording; do not under-declare because labels changed.

For live unpacked-extension updates, overwrite the same existing unpacked extension folder and use `chrome://extensions` -> **Reload**. Do not Remove/re-add the extension unless a genuinely unavoidable identity-breaking reason has been proven.

## Publication gate

Engineering for store readiness is a standing project constraint. Actual Chrome Web Store upload, submission for review, publication, visibility changes, or production listing edits are external release actions and require explicit human authorization. Complete all safe preparation and live validation first, then stop only when that external action is the real next gate.
