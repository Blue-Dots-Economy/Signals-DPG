---
paths:
  - "apps/api/src/routes/v1/consent/**"
  - "apps/api/src/services/consent_*.ts"
  - "apps/api/src/services/item_service.ts"
  - "packages/schemas/src/consent_config.ts"
  - "packages/schemas/src/api/consent_schemas.ts"
  - "packages/config/src/consent_config_loader.ts"
---

# Consent (v1)

Consent is an **append-only ledger** (`consent_record` table). Latest event per `(subject, type)` wins by `seq`, never by timestamp. Content is never stored in the row — only `(category, version)`; the text is resolved from `consent.json`. Levels:

- **user** — `terms` / `privacy` (keyed on `user_id`), via `/api/v1/consent`.
- **item** — `profile_creation` (keyed on `item_id`; idempotent via a partial unique index) and `action` rows (keyed on `item_id` + `action_id`, with `action_type` / `action_stage`).

Two invariants worth internalising:

- **Version is derived server-side.** Never trust a client-supplied version integer. `apps/api/src/services/consent_version.ts` (`resolveConsentVersion`) reads the cached config for the `(network, brand, category[, actionType, stage])` tuple and records that. A client cannot record acceptance of a version the user never saw.
- **Consent copy lives in `consent.json`, not `network.json`.** Each network's `consent.json` sits beside its `network.json` (brand overrides in a brand-named sub-folder), is loaded via `CONSENT_CONFIG_SOURCE` (`local` default; remote is a follow-up returning `[]`), and is cached as `consent_config` entries alongside network schemas (`network_schema_cache.ts`). This **replaced** the inline `consent_text_initiator` / `consent_text_receiver` fields that used to live in `network.json` action definitions — do not reintroduce them. See `packages/config/CLAUDE.md` for the loader's brand-override and `__SUPPORT_EMAIL__` substitution mechanics.
- **Support email is a placeholder, not a literal.** Consent copy ships a `__SUPPORT_EMAIL__` token (T&C/Privacy/Grievances); the consent loader renders it to `CONSENT_SUPPORT_EMAIL` (default `hello@bluedotseconomy.org`) at load, so the address is deploy-time configurable without editing consent content (#266). Distinct from `SUPPORT_EMAIL` (the contact-form recipient). Deployed instances may also have it substituted upstream at ConfigMap render.

`create_item` accepts an optional `consent` block to capture profile-creation consent atomically with the profile. `perform_action` / `update_action_status` gate on action-consent at `initiate` / `accept` stages.

**Go-live gating is config-driven per domain (`go_live_required`).** A profile flips to `lifecycle_status = live` only when every gate the domain configures passes. Gates are **tokens, not field names**, in `network.json`'s `domains[].go_live_required` (vocabulary: `PROFILE_GO_LIVE_GATES` in `@dpg/schemas`). The registry mapping each token to its logic is `apps/api/src/services/items/go_live_gates.ts` (`GO_LIVE_GATE_CHECKS`); `classify_item` is generic over it — it runs whichever gates are configured and never branches on gate identity. To add a gate: add a token to `PROFILE_GO_LIVE_GATES` + one registry entry. Current tokens:

- `schema_required` — all `schema.required` fields populated (completeness).
- `consent_required` — `profile_creation` consent accepted **by the correct signer** (see U18 note below).
- `owner_required` — the profile owner's account has an owning aggregator (`user.onboarded_by_org_id`), #640/SS-3. **The one gate that is not a pure function of the item's own state**: it reads the prior lifecycle status and instance config, and it deliberately lets an already-`live` profile pass a condition it does not satisfy. Two guards, both load-bearing, documented on `GO_LIVE_GATE_CHECKS.owner_required` — read them before touching it.

Omitting `go_live_required` uses `DEFAULT_GO_LIVE_GATES` = `['schema_required']` — **consent is opt-in, not the default** (a change from the old "every network is consent-gated" rule). A domain that wants the historical behaviour lists both tokens. An empty array and unknown tokens are rejected at config load. `resolveGoLiveGates` (`item_service.ts`) resolves the effective set per (network, domain). Accepting profile consent (`routes/v1/consent/accept_profile_consent.ts`) calls `promoteItemOnProfileConsent`, which re-runs `classify_item` with the resolved gates and flips a `draft` item to `live`. Only `draft` is promoted: `paused` is sticky, `retired` is terminal, and `live` needs no change. **Profile completion % (`profile_completion_pct`) is intentionally independent of the gate set** — always required-only.

**U18 guardian gate is folded into `consent_required`.** For domains where `guardianConsentRequired(networkConfig, domain)` is true, a minor's profile cannot reach `live` on the ward's own self-consent — only a guardian's `source='guardian'` `profile_creation` row satisfies the gate. `guardianGateBlocksGoLive` (`services/item_service.ts`) remains **THE single source of truth** for the age check; the go-live call sites (`promoteItemOnProfileConsent`, `updateItemInternal`) compute a guardian-aware `consent_accepted` (`hasAcceptedProfileConsent && !guardianGateBlocksGoLive`) and pass it as the `consent_required` gate value — do not re-derive the age check inline, and do not add a separate `if guardianGateBlocksGoLive` branch (it belongs inside the consent gate). It is **fail-closed**: a null `date_of_birth` on a gated domain is never treated as adult (DOB capture is client-side; `u18_precheck` is a hint, not a control), and a minor with no guardian row stays `draft`. So the age control can never be disabled by config, `resolveGoLiveGates` **force-adds `consent_required` for any guardian-gated domain**, and the config schema **rejects** a guardian-gated domain that declares `go_live_required` without `consent_required`. The bypass #311 closed (a source-agnostic `hasAcceptedProfileConsent` promotion) stays closed: guardian-awareness lives in the one gate value, not a raw consent-presence check.

**Every promotion must publish an item event, after the transaction commits (#557).** A `draft → live` flip changes what search must return, and `item_search` is maintained by signals-search off item events — so a promotion that publishes nothing leaves the profile `draft` in the index: invisible in every ranked feed *and* every map viewport (the bbox filter joins `item_search` with `lifecycle_status = 'live'`), while the owner's own UI reads `items` and shows it Active. Nothing logs. Two rules for any new go-live path:

- **Publish after commit, never inside the transaction.** An event published pre-commit lets the search worker read the row before the promotion is visible and re-index the stale `draft` — the exact race that made U18 profiles permanently invisible (signals-search#122).
- **Best-effort, never fatal.** The consent row and the lifecycle flip are already committed; `publishItemEvent` swallows and warns, and callers must not let a Redis outage turn a recorded consent into a 500.

`promoteEligibleDraftsForUser` returns the promoted item **keys** (not a count) precisely so its caller can do this — an age write is user-level and can promote profiles the request never named. Use `publishItemEvents(keys, 'upsert', log)` for the de-duplicated fan-out.

The `/admin/participant` endpoint also records the ledger for external
channels: its `compliance` array maps to user-level `terms`/`privacy`
(`source='signup'`) and item-level `profile_creation` (`source='profile'`),
then promotes via `promoteItemOnProfileConsent`. The channel is captured in
each row's `metadata.channel`. It never records guardian consent (that
requires the OTP flow).

The participant endpoint validates consent payloads: any `compliance` value
`false` → `CONSENT_DECLINED`; `user_terms`/`user_privacy` are a both-or-none
pair (`USER_LEVEL_INCOMPLETE`); on guardian-gated domains the pair requires
`age` (integer years, stored as the `user.age` snapshot #331; `DOB_REQUIRED`,
handler-level via `guardianConsentRequired`).
Persisting `age` re-promotes all the user's eligible drafts
(`promoteEligibleDraftsForUser`). `GET /admin/participant` surfaces consent
status. It never records `source='guardian'` — U18 promotion still requires the
guardian OTP flow.
