#!/usr/bin/env bash
# Actually brings the local Signals stack up: env, infra, schema, cache
# clears, and the API + UI processes themselves. This is the executable
# version of `references/bringing-the-stack-up.md` — that file used to be the
# ONLY copy of this recipe, meant to be hand-transcribed by whichever agent
# was running the skill. A bare `run.sh` on a cold machine (nothing already
# listening) never brought anything up on its own: `stack-up.sh` only
# VERIFIES a target that is already live and gives up after ~40s if nothing
# answers, so a cold run's only outcome was a confusing failure with no stack
# ever started. This script is what run.sh now calls FIRST in that situation;
# `stack-up.sh` still runs afterward to do its own job (write the run's
# env.sh/marker, probe UI identity, read capability env) — see this script's
# own header note near the bottom about the division of labor.
#
# INVOCATION — executed with bash, never sourced (same reasoning as
# stack-up.sh: BASH_SOURCE and `local` are bash-only, the user's shell is
# zsh):
#
#   bash .claude/skills/signals-e2e/lib/bring-stack-up.sh <dot>
#
# Every gotcha comment below is preserved verbatim (or near enough) from
# references/bringing-the-stack-up.md's hand-run block — each one encodes a
# REAL failure this plan hit once, not a hypothetical.
set -uo pipefail

NET_DIR="${1:-blue_dot}"

log() { echo "[bring-stack-up] $*" >&2; }

# --- locate this script + the checkout that will run the stack -------------
# Same SIGNALS_REPO indirection (and the same main-checkout fallback via `git
# rev-parse --git-common-dir`) that stack-up.sh uses — see ITS header comment
# for the full reasoning. Duplicated rather than sourced (stack-up.sh is a
# top-level script with its own side effects, not a function library; sourcing
# it would run its whole body) — if this logic ever needs to change, change it
# in both places.
HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_REPO="$(cd -P "$HERE/../../../.." && pwd -P)"
REPO="${SIGNALS_REPO:-$SCRIPT_REPO}"
STACK_ENV="$REPO/.env"

if [ ! -f "$STACK_ENV" ] && [ -z "${SIGNALS_REPO:-}" ]; then
  COMMON_DIR="$(git -C "$SCRIPT_REPO" rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$COMMON_DIR" ]; then
    case "$COMMON_DIR" in /*) ;; *) COMMON_DIR="$SCRIPT_REPO/$COMMON_DIR" ;; esac
    CANDIDATE="$(cd "$COMMON_DIR/.." 2>/dev/null && pwd -P || true)"
    if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE/.env" ]; then
      REPO="$CANDIDATE"
      STACK_ENV="$REPO/.env"
      log "no .env in this worktree — using the main checkout at $REPO (set SIGNALS_REPO to override)"
    fi
  fi
fi

if [ ! -f "$STACK_ENV" ]; then
  log "FAIL: no .env at $STACK_ENV, and no main checkout with one could be found."
  log "Set SIGNALS_REPO to the checkout that runs the stack and create its .env from .env.example first."
  exit 1
fi

CFG="$REPO/examples/schemas/$NET_DIR/network.json"
if [ ! -f "$CFG" ]; then
  log "FAIL: no network at $CFG. Available: $(ls "$REPO/examples/schemas" 2>/dev/null)"
  exit 1
fi
NET_ID="$(cd "$REPO" && node -e "console.log(require('./examples/schemas/$NET_DIR/network.json').id)")"
DOMAINS="$(cd "$REPO" && node -e "console.log(require('./examples/schemas/$NET_DIR/network.json').domains.map(d=>d.id).join(','))")"
SERVED="$(node -e "console.log('$DOMAINS'.split(',').map(s=>s.trim()).filter(Boolean).map(d=>'$NET_ID/'+d).join(','))")"
log "network=$NET_ID served=$SERVED repo=$REPO"

cd "$REPO"

# 1) Env. Idempotent (delete + append).
#
#    Back up first. These files are gitignored, so git will not save anyone from
#    this, and the rewrite below is lossy in a way that is easy to miss: it
#    DELETES lines it then re-adds with the recipe's own values. A real run took
#    CREATE_TEST_OTP, SELF_SIGNUP_MODE and all three NOTIFICATION_SERVICE_* out
#    of a developer's .env and repointed VITE_NETWORK_ID at another dot. One
#    timestamped copy per run makes that recoverable instead of archaeology.
for f in .env apps/ui/.env; do
  [ -f "$f" ] && cp "$f" "$f.pre-e2e.$(date +%s)" 2>/dev/null
done
#
#    ⚑ BLANK-UI GOTCHA #1 — the network id lives in TWO files. The turbo
#    wrapper (scripts/turbo-with-root-env.mjs) injects root .env into Vite, and
#    Vite gives that injected value PRECEDENCE over apps/ui/.env. A stale
#    VITE_NETWORK_ID in root .env silently overrides the UI, which then resolves
#    the wrong network, 404s on fetchNetworkConfig, and renders blank — even in
#    incognito, and `?network=` will not fix it. Set BOTH. Same for
#    VITE_SERVED_BINDINGS, or the UI serves the wrong domains.
sed -i '' '/^SERVED_DOMAINS=/d' .env; printf 'SERVED_DOMAINS="%s"\n' "$SERVED" >> .env
sed -i '' '/^NETWORK_CONFIG_LOCAL_FILE=/d' .env
printf 'NETWORK_CONFIG_LOCAL_FILE="../../examples/schemas/%s/network.json"\n' "$NET_DIR" >> .env
for k in VITE_NETWORK_ID VITE_SERVED_BINDINGS VITE_DEFAULT_NETWORK_THEME; do sed -i '' "/^$k=/d" .env; done
printf 'VITE_NETWORK_ID=%s\nVITE_SERVED_BINDINGS=%s\nVITE_DEFAULT_NETWORK_THEME=%s\n' "$NET_ID" "$SERVED" "$NET_ID" >> .env

touch apps/ui/.env
for k in VITE_NETWORK_ID VITE_SERVED_BINDINGS VITE_DEFAULT_NETWORK_THEME VITE_DEFAULT_BRAND; do sed -i '' "/^$k=/d" apps/ui/.env; done
printf 'VITE_NETWORK_ID=%s\nVITE_SERVED_BINDINGS=%s\nVITE_DEFAULT_NETWORK_THEME=%s\nVITE_DEFAULT_BRAND=standard\n' "$NET_ID" "$SERVED" "$NET_ID" >> apps/ui/.env

#    ⚑ BLANK-UI GOTCHA #2 — VITE_API_URL. A .env copied from another checkout
#    often carries a stale LAN IP, unreachable now, so the UI's first fetch
#    (/network/schemas) fails and it hangs on its loading skeleton — which looks
#    blank/white in dark mode, with nothing in the console. Force both files to
#    localhost; root wins, so both must agree.
for f in .env apps/ui/.env; do sed -i '' '/^VITE_API_URL=/d' "$f"; printf 'VITE_API_URL=http://localhost:2742\n' >> "$f"; done

# 2) E2E-ONLY ENV — this is what separates a stack that can be tested from one
#    that merely runs. Without these the suite skips silently or asserts against
#    an empty inbox.
#      CREATE_TEST_OTP        every OTP becomes "000000", so login and guardian
#                             flows run unattended. Boot FAILS if this is ever
#                             set with INSTANCE_ENV=production — by design.
#      SELF_SIGNUP_MODE       'allowed', or the suite cannot create its personas.
#      NOTIFICATION_SERVICE_* ALL THREE, or getNotificationClient() returns
#                             undefined and the API sends NOTHING while looking
#                             healthy (apps/api/src/utils/notificationClient.ts).
#                             The sink ignores HMAC, so the key/secret are dummies.
#      SIGNALS_SEARCH_URL     points at the search stub so its envelope
#      + _API_KEY             recorder actually sees traffic (F7 — this used
#                             to be left unset, so run.sh warned about it on
#                             EVERY cold run even though nothing had ever set
#                             it. SKILL.md §6 already tells the reader to
#                             confirm this is set; now the recipe that brings
#                             the stack up is what actually sets it). BOTH
#                             vars are required — signals_search_client.ts's
#                             searchSignals() throws "not configured" and the
#                             discover BFF falls back to native if EITHER is
#                             unset, so URL-only would still route zero
#                             traffic to the stub. The stub only checks the
#                             key's PRESENCE, never its value (same as the
#                             notification key/secret above), so a dummy is
#                             fine.
#      SUPPORT_EMAIL          BOTH, or `GET /api/v1/support/config` reports
#      + NOTIFICATION_FROM_   `enabled: false` — it mirrors the submit route's
#        EMAIL                503 condition exactly, `Boolean(recipients &&
#                             fromEmail && getDefaultEmailSender())`
#                             (support_config.ts). The UI then never renders the
#                             "Contact support" entry at all
#                             (user-menu.tsx: `{supportConfig.enabled && …}`),
#                             so journey-l-support's locator times out and the
#                             report blames the SELECTOR. Evidenced: the recipe
#                             set neither var, and that failure was mislabelled
#                             `suite-defect` on a real run. The sink already
#                             captures whatever is sent, so with these two set
#                             the journey TESTS support instead of skipping it.
for k in CREATE_TEST_OTP SELF_SIGNUP_MODE NOTIFICATION_SERVICE_ENDPOINT NOTIFICATION_SERVICE_KEY_ID NOTIFICATION_SERVICE_SECRET SIGNALS_SEARCH_URL SIGNALS_SEARCH_API_KEY SUPPORT_EMAIL NOTIFICATION_FROM_EMAIL; do
  sed -i '' "/^$k=/d" .env
done
cat >> .env <<'ENVEOF'
CREATE_TEST_OTP=true
SELF_SIGNUP_MODE=allowed
NOTIFICATION_SERVICE_ENDPOINT=http://localhost:4545
NOTIFICATION_SERVICE_KEY_ID=e2e-local
NOTIFICATION_SERVICE_SECRET=e2e-local-sink-ignores-hmac
SIGNALS_SEARCH_URL=http://localhost:4546
SIGNALS_SEARCH_API_KEY=e2e-local-stub-ignores-key-value
SUPPORT_EMAIL=support@signals-e2e.test
NOTIFICATION_FROM_EMAIL=no-reply@signals-e2e.test
ENVEOF

# 3) Infra
docker compose up -d db redis >/dev/null 2>&1
for i in $(seq 1 20); do docker exec dpg-db pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
PGUSER=$(sed -n 's/^POSTGRES_USER=//p' .env | tr -d '"' | head -1)
PGDB=$(sed -n 's/^POSTGRES_DB=//p' .env | tr -d '"' | head -1)
REDISPW=$(sed -n 's/^REDIS_PASSWORD=//p' .env | tr -d '"' | head -1)

# 4) Schema — idempotent; adds columns added since this DB was created.
docker exec -i dpg-db psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=0 < apps/api/db/postgres/schema.sql >/dev/null 2>&1

# 5) Caches. The network-schema cache MUST go on a dot change or the UI serves a
#    stale/empty config and renders blank.
find /var/folders /private/var/folders /tmp -maxdepth 5 -type d -name 'dpg-network-schema-cache' -exec rm -rf {} + 2>/dev/null
[ -n "$REDISPW" ] && docker exec dpg-redis redis-cli -a "$REDISPW" --no-auth-warning \
  EVAL "local k=redis.call('keys','item-*'); for i=1,#k do redis.call('del',k[i]) end; return #k" 0 >/dev/null 2>&1

# 6) Stop anything already on those ports — but IDENTIFY it first (F4). An
#    unconditional `lsof ... | xargs kill` here once killed the Blue Dots
#    AGGREGATOR portal (a completely different product) on a machine where
#    port 3000 happened to be its home, not the Signals UI's — the skill's own
#    gotcha table already documents that exact collision, and stack-up.sh
#    already knows how to tell the two apps apart (the `/src/main.tsx`
#    module-script marker, below); the old kill step just never asked. Same
#    principle now applies to :2742 (the API): a random other process there
#    is not ours to kill either. Never kill a listener this script cannot
#    positively identify as Signals' own.
#
# Marker choice for the UI mirrors stack-up.sh's `is_signals_ui` exactly (see
# THAT function's comment for the full reasoning) — duplicated rather than
# shared for the same reason as the REPO-resolution block above.
is_signals_ui() {
  local url="$1" body
  body="$(curl -s "$url/" 2>/dev/null)"
  case "$body" in
    *'/src/main.tsx'*) return 0 ;;
    *) return 1 ;;
  esac
}

# The API has no equivalent brand/marker page, but `/api/v1/network/schemas`
# always answers 200 with a JSON ARRAY (even for an unknown `network=`,
# per-entry filtering just yields `[]` — see fetch_schemas.ts) — a shape a
# stray unrelated process on :2742 is exceedingly unlikely to reproduce.
is_signals_api() {
  local url="$1" body
  body="$(curl -s "$url/api/v1/network/schemas?network=__e2e_identity_probe__" 2>/dev/null)"
  case "$body" in
    '['*) return 0 ;;
    *) return 1 ;;
  esac
}

# Kills the LISTEN pid on $1 only if $2 (a checker function name) says it's
# ours. $3 ("required"|"optional") controls what happens when something else
# is squatting there: a required port (the API's — nothing else can serve it)
# is a hard failure with an actionable message; an optional one (the UI's
# primary port — a real fallback to :5173 exists and stack-up.sh already
# probes both) is a clear log line and this script carries on.
stop_port_if_signals() {
  local port="$1" checker="$2" mode="$3" pid
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | head -1)"
  if [ -z "$pid" ]; then
    return 0
  fi
  if "$checker" "http://localhost:$port"; then
    log "port $port: identified as Signals (pid $pid) — stopping it so this run can relaunch cleanly."
    kill "$pid" >/dev/null 2>&1 || true
    sleep 1
    return 0
  fi
  log "port $port: something is listening (pid $pid) but it does NOT look like Signals — leaving it alone."
  if [ "$mode" = "required" ]; then
    log "FAIL: :$port is required for the Signals API and is occupied by an unidentified process (pid $pid)."
    log "Stop whatever that is yourself, or set a different port, and retry — this script will not kill an"
    log "unidentified process."
    exit 1
  fi
  log "(this port is not required — the UI dev server picks a fallback port, e.g. :5173, automatically.)"
  return 0
}

stop_port_if_signals 2742 is_signals_api required
stop_port_if_signals 3000 is_signals_ui optional
ps -Ao pid,command | grep -iE 'turbo.*filter=(api|ui)|tsx watch src/server|--import tsx src/server.ts' | grep -v grep | awk '{print $1}' | xargs kill 2>/dev/null
sleep 2

# 7) Start.
#    ⚑ The API must be a DIRECT node launch reading root .env. `pnpm dev:api`
#    spawns through turbo, which keeps a schema cache in a tmpdir step 5 cannot
#    reach — so /network/schemas returns empty and the UI goes blank. No
#    tsx-watch here either: re-run this script after API code changes.
#
#    ⚑ FULLY DETACH both launches — process LIFETIME first, output second.
#    A bare `&` leaves the dev server as a CHILD OF THIS SCRIPT'S OWN PROCESS
#    GROUP, not an independent process: whatever reaps or signals the group
#    this script is running in (a CI step killed for exceeding its timeout, an
#    agent harness tearing down a backgrounded invocation, a plain Ctrl-C at a
#    real terminal) takes the API and UI down WITH it — silently, mid-suite,
#    with nothing in either dev server's own log explaining why, because
#    nothing in that log ever ran: the process just stops. Confirmed live,
#    reproduced directly against this exact script: sending SIGTERM to this
#    script's own process group while a plain `nohup ... & disown` had it
#    running left the API mid-shutdown and Turborepo reporting "Force killed
#    Turborepo tasks: ui#dev" — `disown` alone only stops bash's job table
#    from `wait`-ing on the child or forwarding SIGHUP to it; it does NOT move
#    the child to a different process group, so a signal aimed at the GROUP
#    still reaches it.
#
#    `spawn_detached` (below) is what actually fixes that, via Node's
#    `child_process.spawn({ detached: true })` — which calls `setsid()` on
#    POSIX, making the child the leader of a brand-new SESSION (stronger than
#    just a new process group), with no shell job control involved at all.
#    Node is already a hard prerequisite of this whole skill (preflight checks
#    >=24), so this adds no new dependency, and there is no `setsid` BINARY on
#    macOS to shell out to instead.
#
#    Bash's own `set -m` (job-control/monitor mode) looks like an equally
#    plausible fix — it also gives a `&`-backgrounded job its own process
#    group — and was tried first. It does not work here: confirmed live, it
#    hangs the launching (sub)shell INDEFINITELY the moment there is no
#    controlling terminal at all — which is exactly what `nohup bash lib/run.sh
#    ... &` (this skill's own documented shape for automation, SKILL.md §5)
#    produces. Reproduced directly: the exact subshell this step used to
#    launch the API sat alive and idle for minutes under that invocation
#    shape, never returning, while the API it had already started was
#    perfectly healthy — bash's job-control machinery apparently tries (and
#    fails) to do terminal-related bookkeeping with no tty to do it against.
#    `spawn_detached` has no such dependency: it returns as soon as Node has
#    started the child and called `.unref()`, regardless of whether a
#    controlling terminal exists.
#
#    The SECOND, previously-reported symptom of the same underlying gap is an
#    output problem, not a lifetime one: `spawn_detached` also redirects each
#    child's stdout+stderr straight to its own log file (never inherited),
#    for the same reason `</dev/null` + an explicit redirect were tried
#    first — a dev server that shares this script's own stdout can make a
#    CALLER that pipes this script's output (`| tail -30`) hang waiting for
#    EOF on a pipe the long-lived dev server never closes, even though the
#    job itself returns control to this script immediately. Confirmed live: a
#    field run piped this way never saw its own "ready" summary — the UI
#    launch line was still alive, and only its stdout/stderr were missing —
#    for ~25 minutes.
#
# spawn_detached <cwd> <logfile> <command> [args...] — starts <command> fully
# detached (own session, stdio redirected to <logfile>, never waited on) and
# returns immediately. $! is not meaningful here (the node -e process itself
# exits right after spawning); nothing in this script needs the child's pid.
spawn_detached() {
  local cwd="$1" logfile="$2"
  shift 2
  # The `--` before "$@" is load-bearing, not decorative: without it, `node
  # -e` still parses ITS OWN recognized flags out of whatever trailing args
  # follow the -e script — confirmed live, `node --env-file=../../.env`
  # forwarded as a plain positional arg made THIS wrapper process itself try
  # (and fail) to load `../../.env` relative to ITS OWN cwd, before ever
  # reaching the spawn() call below. `--` tells node "everything after this
  # is process.argv for the script, not a flag for me".
  SPAWN_CWD="$cwd" SPAWN_LOG="$logfile" node -e '
    const { spawn } = require("child_process");
    const fs = require("fs");
    const fd = fs.openSync(process.env.SPAWN_LOG, "a");
    const [cmd, ...args] = process.argv.slice(1);
    const child = spawn(cmd, args, {
      cwd: process.env.SPAWN_CWD,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.unref();
  ' -- "$@"
}

spawn_detached "$REPO/apps/api" /tmp/signals-api.log \
  node --env-file=../../.env --import tsx src/server.ts
UICMD="dev:ui"; [ "$NET_DIR" = "orange_dot" ] && UICMD="dev:tourist"   # orange_dot is the tourist app
spawn_detached "$REPO" /tmp/signals-ui.log pnpm "$UICMD"

# 8) Verify. A zero schema count means the UI WILL be blank — do not proceed.
# This loop breaks on the FIRST success rather than sleeping the full ceiling
# every time — cheap and correct either way (a warm API answers within a
# couple seconds; a cold `tsx` transpile of the whole server is the actual
# dominant cost here, seconds, not this loop's granularity).
for i in $(seq 1 40); do curl -sf "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" >/dev/null 2>&1 && break; sleep 1; done
SCHEMA_LINE="$(curl -s "http://localhost:2742/api/v1/network/schemas?network=$NET_ID" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const n=JSON.parse(d).length;console.log(n+" entries "+(n>0?"(OK)":"(EMPTY -> UI will be blank)"))}catch(e){console.log("0 (parse failed)")}})')"
log "config: $SCHEMA_LINE"
case "$SCHEMA_LINE" in
  0\ *|*EMPTY*)
    log "FAIL: /network/schemas returned no usable entries for $NET_ID — see /tmp/signals-api.log."
    exit 1
    ;;
esac

# Same retry ceiling as the API probe above, and for a sharper reason: Vite
# prints "ready in 365 ms" and only THEN starts re-optimizing dependencies when
# the lockfile has changed, which it has on any fresh checkout. A single probe
# here caught that window and failed with "no Signals UI found" while the UI was
# seconds from serving — reproduced on a cold checkout, passing on the very next
# run once Vite's dep cache was warm. That is the worst possible shape: it fails
# for the first-time user and works for everyone who has already run it.
UI_LINE=""
for i in $(seq 1 40); do
  for p in 3000 5173; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$p/" 2>/dev/null)
    if [ "$code" = "200" ] && is_signals_ui "http://localhost:$p"; then
      UI_LINE="http://localhost:$p"
      break
    fi
  done
  [ -n "$UI_LINE" ] && break
  sleep 1
done
if [ -z "$UI_LINE" ]; then
  log "FAIL: no Signals UI found on :3000 or :5173 after starting it (waited 40s) — see /tmp/signals-ui.log."
  exit 1
fi

# This summary is the LAST thing this script prints, deliberately — see the
# detachment comment in step 7. A reader who only sees output up to here still
# gets the two lines that actually matter, and the script exits promptly
# whether its own stdout is a terminal or a pipe.
log "ready  dot=$NET_DIR network=$NET_ID"
log "api:    http://localhost:2742"
log "ui:     $UI_LINE"
log "logs:   /tmp/signals-api.log  /tmp/signals-ui.log"
