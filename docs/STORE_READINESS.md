# Chrome Web Store Readiness

Status: **v1.0 engineering readiness complete; Chrome Web Store publication deferred.**

Chat Turn Guardian v1.0 is engineered so a later public Chrome Web Store submission does not require weakening its security, privacy, permission, or architecture boundaries. This document is the durable release/distribution runbook. It is **not** a claim that Google has reviewed, approved, or published the extension.

Chrome Web Store policies and Developer Dashboard wording are version-sensitive. Re-verify current official requirements immediately before any future submission.

## v1.0 release architecture

- Manifest V3, Chrome/Chromium 114+.
- Product/manifest/package version: `1.0.0` for the v1.0 release line.
- Production extension/action icon set at 16, 32, 48, and 128 pixels under `src/assets/`.
- Toolbar action opens the Side Panel through `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`; unsupported tabs remain disabled by explicit host/tab gating.
- No remotely hosted executable code. AI-provider and Telegram responses are data only and are never evaluated as extension logic.
- `scripts/lint.mjs` rejects `eval()`, `new Function()`, remote `importScripts()`, remote dynamic imports, and remotely hosted executable `<script>` sources in extension source.
- Release packaging is deterministic, verifies manifest-referenced assets, requires `manifest.json` / `package.json` version parity, and excludes TypeScript, source maps, `.env` files, credentials, and unrelated development artifacts.
- CI validates the exact candidate SHA and retains release-package/provenance artifacts.

## Product and authority constraints

Store distribution must preserve the v1.0 product boundary:

- one narrow purpose: supervise explicitly selected ChatGPT conversations, safely continue only needless turn boundaries, and notify the user when configured;
- human interaction always wins;
- exact tab/document/content-agent/page epoch/route/conversation/assistant-response/response-instance identity;
- OWNER/MIRROR isolation; MIRROR never auto-sends;
- empty-composer and final synchronous revalidation immediately before mutation;
- stale-decision cancellation, no blind retry, and ambiguous-write freeze;
- fail closed on uncertainty/provider failure/platform blockers;
- provider output remains advisory only;
- provider/Telegram credentials remain in trusted extension contexts and secret-free status/log/audit surfaces;
- notification channels remain observational and can never authorize ChatGPT mutation;
- new channels/providers/page adapters must use bounded interfaces and cannot silently inherit guarded-send authority.

## Permission model and justifications

### Required permissions

- `storage`: selected chat policies, provider/Telegram configuration and credentials, bounded audit/reliability state, and recovery state.
- `sidePanel`: primary configuration/status surface and toolbar-action destination.
- `notifications`: local browser notifications for configured Guardian events.

### Persistent ChatGPT host permissions

`https://chatgpt.com/*` and `https://chat.openai.com/*` are the supported ChatGPT origins. Content scripts need these hosts to observe exact conversation/response identity, detect trusted human interaction/platform blockers, and perform the narrow configured continuation only after guarded revalidation.

### Optional HTTPS provider envelope

`optional_host_permissions: ["https://*/*"]` is intentionally retained because the generic OpenAI-compatible feature accepts a user-configured HTTPS provider origin that cannot be known at install time.

This is an **optional declaration envelope**, not install-time persistent access to all HTTPS sites. Guardian requests only the exact provider origin selected by the user. Provider origins no longer referenced by any saved profile are revoked on a best-effort basis.

Telegram separately requests only `https://api.telegram.org/*` when configured.

Do not replace the optional HTTPS envelope with a misleading hardcoded provider allowlist merely to make the manifest look narrower. Preserve the useful generic-provider capability, keep actual runtime grants exact-origin, and give reviewers the accurate justification.

## Privacy and disclosure

The public policy is [`PRIVACY.md`](../PRIVACY.md) and must remain synchronized with runtime behavior.

Current behavior/disclosure includes:

- Guardian processes supported ChatGPT page state and bounded recent visible conversation context for supervision;
- full chat transcripts are not stored by Guardian;
- optional AI classification sends only minimized, secret-redacted bounded recent context directly to the selected provider;
- optional Telegram sends bounded notification metadata and does not send full ChatGPT messages by default;
- provider API keys and Telegram bot tokens are not rendered back after storage and do not enter page/content/log/audit/status surfaces;
- there is no developer-operated backend, analytics service, advertising service, or data broker in v1.0;
- the privacy policy records the Chrome Web Store User Data Policy / Limited Use commitment applicable to the intended distribution path.

The Side Panel contains provider/Telegram disclosures and a collapsed **Privacy & Data** section at the bottom. The authoritative reviewer/listing copy is [`CHROME_WEB_STORE_LISTING.md`](CHROME_WEB_STORE_LISTING.md).

## Store assets

Repository assets currently include:

- extension/store icon: `src/assets/icon-128.png`;
- small promotional tile: `store-assets/small-promo-440x280.png`;
- optional marquee image: `store-assets/marquee-1400x560.png`.

A future submission still needs at least one clean screenshot captured from the **real current runtime** at an accepted Store size such as 1280x800 or 640x400. Do not fabricate/mock a screenshot and do not expose provider keys, Telegram bot tokens, destination identifiers, or sensitive ChatGPT content.

## v1.0 engineering evidence

The v1.0 baseline has production-like validation for the principal advertised surfaces, including:

- multi-tab supervision and guarded AUTO behavior;
- human-interaction and OWNER/MIRROR safety paths;
- provider configuration/readiness and fail-closed failures;
- browser notifications;
- toolbar action -> Side Panel;
- privacy disclosure placement;
- Telegram configuration persistence and a real owner-local outbound Test notification reaching Telegram with Guardian reporting `Configured`, `Enabled`, and `Healthy`.

See [`V1_VALIDATION.md`](V1_VALIDATION.md) for the durable acceptance/evidence map.

Rare ChatGPT platform states that only occur naturally are not claimed as live-passed when they did not occur. Their required fail-closed behavior remains regression-tested; do not manufacture those states for Store preparation.

## Future submission checklist

When the owner decides to submit Chat Turn Guardian to the Chrome Web Store, reopen the historical Store-readiness/public-release issue rather than creating duplicate tracking and perform this **against the then-current release candidate**:

1. Re-review the current official Chrome Web Store Developer Program Policies, User Data/Limited Use requirements, current extension permission guidance, Developer Dashboard privacy wording, and listing asset requirements.
2. Reconcile every applicable Developer Dashboard privacy/data-use checkbox with actual runtime behavior.
3. Run `npm ci`, `npm run validate`, `npm run smoke:extension`, and `npm run package` against the exact submission candidate SHA.
4. Verify `artifacts/SHA256SUMS.txt` and `artifacts/build-info.json`; confirm the submission ZIP contains only intended built extension files and no `.ts`, `.map`, `.env`, credentials, or development junk.
5. Validate every feature advertised in the listing against that production-like unpacked build.
6. Capture current real-runtime Store screenshot(s) with no sensitive data.
7. Review `CHROME_WEB_STORE_LISTING.md` and `PRIVACY.md` against the exact candidate and then-current policy/dashboard wording.
8. Obtain explicit owner authorization before any Developer Dashboard upload, submission for review, publication, visibility change, or production listing edit.

For unpacked validation upgrades, overwrite the **same existing unpacked extension folder** and use `chrome://extensions` -> **Reload**. Do not Remove/re-add merely to update a build.

## Publication gate

v1.0 engineering readiness does not imply Store delivery. Actual Chrome Web Store upload/submission/publication is an external production release action and is intentionally deferred. No Store action should be performed until it becomes an explicit owner-authorized outcome with current policy/package/listing evidence.
