# Chrome Web Store Listing

This file is the authoritative submission copy for the public Chrome Web Store listing. Reconcile it against the current shipped manifest and runtime behavior immediately before each submission.

## Product details

**Name:** Chat Turn Guardian

**Category:** Workflow & Planning

**Primary language:** English

**Single purpose:**

> Chat Turn Guardian supervises user-selected ChatGPT Web conversations and can request a configured continuation turn only when its conservative local safety gates determine that no genuine human decision is required.

**Short description:**

> Safely supervise selected ChatGPT conversations with guarded continuation, notifications, and fail-closed human control.

**Detailed description:**

Chat Turn Guardian helps users supervise selected ChatGPT Web conversations without surrendering human control. It observes the current conversation state, recognizes finished assistant turns, and can optionally request a configured continuation only after conservative local checks and exact-state revalidation succeed.

Key capabilities:

- per-conversation `OFF`, `OBSERVE`, `AUTO`, and `NOTIFY_ONLY` modes;
- exact tab/document/route/conversation/assistant-response identity checks before any automatic action;
- human typing, sending, editing, navigation, and blocking platform UI always cancel or prevent pending automation;
- fail-closed `HOLD`, `UNSURE`, stagnation, hard-fuse, and ambiguous-write handling;
- optional AI classification through a user-configured OpenRouter, NaraRouter, or HTTPS OpenAI-compatible provider;
- local browser notifications and optional outbound-only Telegram notifications;
- bounded, redacted reliability/audit diagnostics; and
- a Side Panel for configuration and status.

Privacy and data handling are part of the product design. Guardian processes ChatGPT page state and recent visible chat content only to provide its disclosed supervision purpose. Full chat transcripts are not persisted. If AI classification is configured, a minimized and secret-redacted recent context is sent directly to the selected provider. If Telegram is configured and enabled, only bounded Guardian notification metadata is sent directly to Telegram; Telegram v1 does not send full chat messages or accept inbound control commands. Provider and Telegram credentials stay in trusted extension storage and are not exposed to ChatGPT page/content contexts.

Chat Turn Guardian does not bypass ChatGPT safety controls, usage limits, confirmations, CAPTCHAs, platform blocking UI, or account restrictions. External classifier output is advisory only and cannot authorize a send by itself.

Privacy policy: https://github.com/ach1992/chat-turn-guardian/blob/main/PRIVACY.md

Support: https://github.com/ach1992/chat-turn-guardian/issues

## Privacy practices

### Single-purpose field

Use the single-purpose statement above verbatim unless runtime scope changes.

### Permission justifications

**`storage`**

Stores user-selected automation policy, provider profiles and credentials, Telegram configuration and credential, bounded reliability/audit metadata, and guarded-send recovery state. Credential-bearing durable storage is restricted to trusted extension contexts. This state is required to preserve explicit user configuration and fail-closed safety across service-worker restarts.

**`sidePanel`**

Provides the extension's primary configuration/status UI. The toolbar action opens this Side Panel only on supported ChatGPT tabs; unsupported tabs remain disabled.

**`notifications`**

Provides local browser notifications for configured Guardian events such as response completion, HOLD/human attention, UNSURE, stagnation, provider errors, and extension/platform errors. Notification delivery is observational and cannot authorize chat mutation.

**Persistent host access: `https://chatgpt.com/*`, `https://chat.openai.com/*`**

Required for the extension's single purpose: content scripts must observe supported ChatGPT pages, bind exact conversation/response identity, detect user interaction and platform blockers, and perform the narrow guarded continuation only after final synchronous revalidation. No persistent access is requested for unrelated sites.

**Optional host envelope: `https://*/*`**

The generic OpenAI-compatible provider feature lets the user enter an arbitrary HTTPS provider origin that is not knowable at install time. Chromium requires such dynamically discovered hosts to be declared in `optional_host_permissions`. The declaration does not grant broad HTTPS access at installation. The Side Panel requests only the exact origin chosen by the user at runtime. Telegram similarly requests only `https://api.telegram.org/*`. Provider origins no longer used by any profile are revoked on a best-effort basis. The wildcard is therefore a runtime declaration envelope for implemented user-selected HTTPS transports, not future-proof or persistent browsing access.

### Remote code declaration

**No, this extension does not use remotely hosted executable code.**

All JavaScript executed by the extension is packaged in the release ZIP. Network responses from AI providers and Telegram are data only. Provider output is parsed as bounded classification data and never evaluated or loaded as executable logic. The release validation rejects `eval()` and other remote-code patterns covered by repository checks.

### User-data disclosure

The extension handles the following functional data classes and they must be mapped to every applicable checkbox shown by the current Developer Dashboard at submission time:

- website content / user-generated chat content: recent visible ChatGPT user and assistant turns used for supervision and optional classification;
- web browsing/activity data limited to supported ChatGPT route/conversation state required for the user-facing supervision feature;
- authentication information supplied by the user: provider API keys and optional Telegram bot token;
- user configuration and interaction state: modes, timings, notification preferences, provider/Telegram settings, user-interaction cancellation state, and bounded audit/reliability metadata.

Do not under-declare because a Dashboard label changed. Re-open the current Privacy practices tab immediately before submission and select every category whose then-current wording covers the runtime behavior above.

### Limited Use certification

Certify only while `PRIVACY.md`, the store listing, and actual runtime remain synchronized. Chat Turn Guardian uses user data only to provide or secure its disclosed single purpose, does not sell data, does not use data for personalized advertising or credit-worthiness, and transfers data only to the user-selected provider/Telegram service when needed for the corresponding enabled feature.

### Privacy policy URL

`https://github.com/ach1992/chat-turn-guardian/blob/main/PRIVACY.md`

## Required listing assets

Current Chrome Web Store guidance requires:

- 128x128 store/extension icon: `src/assets/icon-128.png`;
- at least one real 1280x800 or 640x400 screenshot, up to five;
- 440x280 small promotional tile;
- optional 1400x560 marquee image; and
- a promotional YouTube video only when one is intentionally supplied; do not invent or upload a placeholder video.

Screenshots must show the current actual extension experience, not mocked future features. Capture at least the primary current-tab Side Panel state and, if advertised in the listing, the provider/Telegram configuration surfaces. Never place real provider or Telegram credentials in listing screenshots.

## Release/package requirements

Before submission:

1. `manifest.json` and `package.json` versions must match.
2. Build/test/smoke/package validation must run against the exact release commit SHA.
3. `artifacts/chat-turn-guardian-<version>.zip` must be produced by `npm run package` from that exact SHA.
4. Verify `SHA256SUMS.txt` and `build-info.json` provenance.
5. Confirm the ZIP contains no `.ts`, `.map`, `.env`, credentials, development junk, or unrelated files.
6. Confirm every manifest-referenced icon exists at the declared size.
7. Re-run a real unpacked-extension validation of every feature advertised in this listing.
8. Use the same existing unpacked extension folder for live updates and Chrome's **Reload** action; do not Remove/re-add the extension merely to update a build.

## Human-only publication gate

Do not upload, submit for review, or publish a Chrome Web Store item without explicit owner authorization. Before that gate, complete every safe preparation step, capture real listing screenshots/promo assets, verify current policies again, and record only non-secret live evidence.
