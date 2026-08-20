# Chrome Web Store Readiness

Chat Turn Guardian is developed so that a later public Chrome Web Store release does not require weakening its security, privacy, or architecture boundaries.

This document is an engineering/release-readiness checklist, not a claim that the extension is already published or approved by Google. Chrome Web Store policies are version-sensitive and must be re-verified against current official Chrome documentation immediately before submission.

## Product constraints

- Keep one narrow, understandable product purpose: supervise explicitly selected ChatGPT conversations, safely continue needless turn boundaries, and notify the user when configured.
- Keep Manifest V3 logic self-contained in the packaged extension. Remote services may provide data/classification/notification delivery, but must not supply executable extension logic.
- Request only permissions and host access required by implemented features. Prefer optional/exact-origin access for external providers and notification transports where practical; do not request permissions merely for possible future features.
- Preserve fail-closed automation, human precedence, exact session identity, OWNER/MIRROR isolation, no blind retry, provider/notification transport isolation, and secret isolation.
- Treat provider API keys and Telegram bot tokens as credentials. Keep them in trusted extension storage and never expose them to page/content contexts, ordinary status responses, logs, audit history, screenshots, or listing metadata.
- Keep external data transfer minimized and purpose-bound. Classifier context stays bounded/redacted; Telegram notifications default to bounded metadata and do not export full chat content.
- Keep notification channels observational. Delivery failure or rate limiting must never change classifier decisions or browser mutation authority.
- Keep the codebase modular so notification channels, provider adapters, page adapters, and release surfaces can evolve without coupling them to guarded-send authority.

## Store-review readiness

Before any public/unlisted/private Chrome Web Store submission, verify current official policy and complete at least:

- manifest/name/version/description/icon review;
- permission and host-permission audit with a written justification for each requested capability;
- Chrome Web Store single-purpose statement consistent with actual runtime behavior;
- accurate Privacy practices declarations;
- an accurate public privacy policy describing local processing/storage and every third-party transfer used by enabled features;
- clear in-product disclosure/consent where current policy requires it, including changes to data practices introduced by later versions;
- confirmation that no remotely hosted code, `eval`-style fetched logic, or external command interpreter is used;
- secure HTTPS transport for external services and bounded/sanitized errors that do not leak credentials;
- listing assets: production-quality icon, screenshots, description, and other required store metadata;
- production-like validation of every advertised feature before upload;
- deterministic release ZIP/version/provenance checks tied to the exact reviewed commit;
- final review of current Chrome Web Store Developer Program Policies immediately before submission.

## Telegram v1 and store privacy

Telegram v1 is outbound notification-only. The user explicitly configures their own bot token and destination. The extension may send only the configured Guardian notification events and bounded/minimized metadata needed to make those notifications useful. Telegram does not gain authority to send ChatGPT messages, answer approvals, control AUTO, or alter classification/state.

Because enabling Telegram transfers notification data to a third-party service, the public release path must disclose that transfer accurately in the extension UI/store privacy material and privacy policy, consistent with the exact data actually sent by the implementation.

## Publication gate

Engineering for store-readiness is a standing project constraint. Actual Chrome Web Store submission/publication is a separate release action: it requires current policy review, final release evidence, completed listing/privacy assets, and explicit human authorization for the external publication action.
