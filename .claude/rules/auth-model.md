---
paths:
  - "apps/api/plugins/auth/**"
  - "apps/api/src/middleware/**"
  - "packages/auth/**"
  - "apps/api/src/routes/v1/admin/**"
  - "apps/api/src/routes/auth/**"
  - "apps/api/src/routes/v1/auth/**"
---

# Auth model

Two distinct auth paths, both through `apps/api/plugins/auth/auth_middleware.ts`:

1. **Apikey path** — `x-api-key` is checked first. If present and invalid, returns `403 INVALID_API_KEY` immediately (no fallback). Used by integrating DPGs (aggregator-dpg, voice-dpg).
2. **Session path** — used by the UI when `x-api-key` is absent.

**`AUTH_PROVIDER` selects the identity provider on the session path**, resolved into `authConfig.provider` / `.keycloak_enabled` / `.betterauth_enabled` in `apps/api/src/config.ts`. **Two values, and they are exact complements. Default `betterauth` — every Keycloak path is dormant and the session path is byte-for-byte the pre-migration behaviour.**

**`dual` was removed** (`docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md`). It accepted Keycloak tokens alongside better-auth sessions during cutover, and it was the only mode in which `backfillKeycloakShell` ran — the just-in-time straggler net, which fired on a better-auth *login*. Two consequences:

- **Migrating every user into the realm is now a hard prerequisite** for flipping an instance to `keycloak` (`pnpm keycloak:migrate:users --apply`, then `--reconcile` to 1:1). Nothing creates a missing Keycloak identity on the fly any more, so an unmigrated user is locked out at the flip.
- An instance still configured with `AUTH_PROVIDER=dual` **fails at startup** with an actionable message (`assertAuthProviderSupported`, run before the Zod parse so the error is not a bare "Invalid input").

Rollback is still per-instance: better-auth's code remains, and its passwordless OTP login needs no `account` row, so a Keycloak-created user can sign in again after a flip back to `betterauth`.

`auth_middleware` and `validate_session` both delegate to `resolveKeycloakSession` (`plugins/auth/resolve_session.ts`) so the two cannot drift. Under `keycloak` it either resolves the request or fails it — a `fallthrough` is returned **only** under `betterauth`, and a token that *looks* Keycloak-issued but fails validation is rejected with its specific code rather than blurred into a generic 401.

**Under `keycloak`, better-auth's `/api/auth/*` mount is not registered at all** (`app.ts`). That mount previously stayed live in every mode, leaving `unified_otp`'s `verifyOtp` able to create users with no Keycloak identity. `x-api-key` auth is unaffected — `verifyApiKey` is an in-process call, not a route.

A bearer token is then forked by *kind* of caller. A client-credentials token (an integrating DPG) resolves through `resolveServiceAccount` (`src/services/auth/service_account.ts`) to that DPG's existing service `user` row — the bearer replacement for `verifyApiKey`, accepted alongside `x-api-key` during the compatibility window. Anything else takes the human path. The mapping is by convention: **Keycloak client id == `organization.slug`**, resolved via the org's `role='service'` member.

Two things that are easy to get wrong here:

- **Audience is a real check, and it is two lists, not one.** signals shares one realm with aggregator, so an aggregator-issued token carries the same `iss` and the same signature — signature + issuer alone would admit it. `KEYCLOAK_ACCEPTED_CLIENT_IDS` (human/session clients, default `signals-ui` only) and `KEYCLOAK_SERVICE_CLIENT_IDS` (integrating DPGs, **empty by default**) are checked against `azp`/`aud`. They are kept separate deliberately: merging them would let a token from the public `signals-ui` client be honoured as a service account, and an integrating DPG's token be provisioned as a human user. Both directions are rejected. `signals-api` is in neither by default — it is the API's own Admin-REST client, rejected on both paths.
- **The human path needs a named client and a signals realm role.** `verifyKeycloakToken` accepts on an `aud` match with no `azp` required, so `resolve_session.ts` treats a **missing `azp` as a rejection** — otherwise an `aud`-only token would skip the human/service fork and reach `provisionUserFromClaims` unattributed. On top of that, the token must carry one of `KEYCLOAK_REQUIRED_REALM_ROLES` (default `signals_participant,signals_admin`, stamped by `user_to_keycloak.ts`) or it gets `403 TOKEN_ROLE_REJECTED`. That is the defence-in-depth layer the client allowlist can't provide: the allowlist rests on claims a client controls, a realm role does not. Set the var empty only knowingly — the allowlist becomes the only cross-DPG gate again. Service tokens are exempt (their service accounts hold realm-management roles, not participant roles).
- **`provisioning.ts` is where the self-signup gate now lives** for Keycloak logins. Under `SELF_SIGNUP_MODE=gated`, a valid token whose `sub` has no local `user` row is refused rather than mirrored — otherwise the gate reopens at the Keycloak layer. The mirror's primary key is always the token's `sub`; nothing may mint a new id for an existing user.

`/api/v1/admin/*` additionally requires `x-acting-org-id`, validated by `apps/api/src/middleware/acting_org.ts`.

**`ACTING_ORG_SOURCE` decides whether that header authorises itself.** Default `header` — today's behaviour exactly, and the header is unchanged in every mode. Under `claim_preferred` the asserted org must fall inside the `signals_acting_orgs` grant carried by the token (threaded onto `request.acting_org_grant` by `resolve_session.ts`), falling back to the header when a token carries no grant; `claim_required` refuses a grantless token outright. `['*']` is a wildcard grant, currently used for the platform `network_service` client — **an explicit grant that should later be replaced by an enumerated org list.** `request.acting_org`'s shape is unchanged in all modes, so no route needs edits. See §5.1 of the migration design, and note the pre-existing gap it closes: the membership check looks for membership of *some* org, never the asserted one. The `organization.type` column (`network_service` | `aggregator` | `voice`) gates what each acting org may do — e.g. only `network_service` may upsert aggregators. The middleware populates `request.user` and `request.acting_org`; routes should read those, not re-parse headers. `POST /api/v1/admin/participant/decrypt` returns decrypted participant profile `item_state`; ownership is keyed on the item creator's `user.onboarded_by_org_id` (aggregators see only items whose creator they onboarded; `network_service` sees all items in served networks) — never on the lazily-materialized `item_metrics` cache.

`AUTH_MIDDLEWARE_ENABLED` (default `true`) is the kill switch — useful when running migrations or seed scripts that shouldn't hit the auth path.

**Self-signup + login channels.** `SELF_SIGNUP_MODE` (default `gated`) and `LOGIN_CHANNELS` (default `phone,email`) are resolved into `authConfig` in `apps/api/src/config.ts` and enforced in the `unified_otp` plugin (`packages/auth/plugins/unified_otp.ts` → `assertSelfSignupAllowed`). `gated` (the default) blocks self-service account creation via the public OTP flow — new participants must be onboarded via `POST /api/v1/admin/participant`; `allowed` opens public self-registration. `GET /api/v1/auth/config` (public, unauthenticated, in `routes/v1/auth/auth_config.ts`) surfaces `{ selfSignupAllowed, loginChannels, authProvider, keycloak }` to the UI, but **server env stays the single source of truth** — never gate on the client-reported value.

**The UI's login screen is chosen from that endpoint, not from a build arg.** `authProvider` and the OIDC connection details are served precisely so the decision is a runtime one: there is deliberately no `VITE_AUTH_PROVIDER` build arg in `apps/ui/Dockerfile` or the local-setup compose. Baking it in once meant a UI image built for Keycloak redirected every user into an OIDC flow while the API was still on `betterauth` — the OTP endpoints were never called, and flipping back needed an image rebuild. `apps/ui/src/hooks/use-auth-config.ts` fetches it once per session; `apps/ui/src/lib/keycloak-config.ts` maps it (`keycloak` → OIDC screen; `betterauth` → OTP screen). A `VITE_AUTH_PROVIDER` set through `window.__DPG_UI_CONFIG__` still overrides, for a UI-side canary at rollout. See `packages/auth/CLAUDE.md` for the OTP flow internals and the `assertSelfSignupAllowed` dual-call-site invariant.

**Inter-instance peer auth.** Four peer routes are guarded by `apps/api/src/middleware/peer_instance_guard.ts`, an HMAC instance token bound to path + body (`utils/instance_token.ts`): the three `*_local` reads (`network/item/count_local`, `fetch_local`, `markers_local`) and the write `network/action/perform`. Signing material is `INSTANCE_SHARED_SECRET` (required, min 32, identical across a network's instances). The guard returns `401 PEER_AUTH_FAILED`, never throws.

**The write route uses `peer_instance_guard_strict` and does NOT honour `PEER_AUTH_MODE`.** `permissive` (the default) exists so peers predating inter-instance auth keep working during rollout — it forgives a *missing* token on the reads. `network/action/perform` never had a legitimate unsigned in-repo caller, and its body asserts identity (`source_item_owner`, `performed_by_*`) rather than selecting rows, so it rejects an unsigned request in every mode. Extending `permissive` to it would leave that identity assertion open in every deployment that has not flipped the flag.

`missing` (neither header) is the only reason `permissive` forgives. A token sent *without* its timestamp — or the reverse — is `incomplete` and always rejected: it is a failed authentication attempt, not an unsigned caller.

The HMAC is computed over the **raw request bytes** (captured by `plugins/raw_body.ts`), never a re-serialization of `request.body`. A preHandler runs after Zod, which strips undeclared keys and injects defaults, so re-serializing produced a different string from the one the sender signed — that mismatch has silently broken federation twice (`lifecycle_filter`, then `order_by`).

**Replay:** the signed string is `timestamp.targetPath.sha256(body)` with a ±300s window and no nonce, so a captured signed request can be replayed within that window. That was inert while every peer route was a read; it now covers a write, where the action pair cap absorbs the duplicate. Binding an idempotency key into the signed string would close it properly.
