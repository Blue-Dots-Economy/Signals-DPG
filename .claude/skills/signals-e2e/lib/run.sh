#!/usr/bin/env bash
# The one entry point for the signals-e2e skill.
#
#   bash lib/run.sh [dot] [alias]     — /signals-e2e [dot] [alias]
#   bash lib/run.sh cleanup <run-id>  — /signals-e2e cleanup [tag]
#
# dot defaults to blue_dot. alias, if given, must be one of the names in
# `print_alias_table` below (spec §6) — an unknown alias prints that table and
# exits 2 rather than silently running everything: a scoped run that quietly
# becomes a full one wastes half an hour, and a full run that quietly becomes
# scoped is worse, because it signs off on work it never touched.
#
# Runs under a real bash (this file is EXECUTED, `bash lib/run.sh ...`, never
# sourced) and is written for bash 3.2 (this host's /bin/bash) deliberately:
# no `declare -A` (macOS system bash has no associative arrays), and no
# `"${arr[@]}"` on an array that might be empty under `set -u` (bash 3.2 throws
# "unbound variable" for that — fixed only in bash 4.4+). Every branch below
# that used to be "build an args array" is a plain if/elif with a literal
# argument list instead.
set -uo pipefail

log() { echo "[signals-e2e] $*" >&2; }

# `-P` on both `cd` and `pwd` below resolves every symlink component, not just
# the leaf — REQUIRED here because this skill is normally INSTALLED as a
# symlink (`~/.claude/skills/signals-e2e` -> the real directory inside some
# checkout of this repo). Without `-P`, `cd`+`pwd` return the LOGICAL path
# (the one that still goes through `~/.claude/skills/...`), and climbing "up
# 3 dirs then into e2e/" from THAT path lands outside the repo entirely (e.g.
# `~/e2e`, which does not exist) rather than at the checkout's real `e2e/`.
# Confirmed live (F2): from the installed symlink, the logical derivation
# below resolved to a nonexistent directory while `-P` resolves to the real
# worktree.
HERE="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"   # .../lib, symlinks resolved
SKILL_DIR="$(cd -P "$HERE/.." && pwd -P)"                     # .../signals-e2e, symlinks resolved

# `resolve_dir` never lets a failed `cd` vanish into an empty string the way
# the old, unguarded `E2E_DIR="$(cd ... && pwd)"` did: this script only sets
# `-uo pipefail`, not `-e`, so a `cd` failing INSIDE a `$(...)` command
# substitution does not stop the script — it just makes the substitution
# print nothing, and the assignment silently becomes `""`. Every use of
# `resolve_dir` below is followed by an explicit non-empty check for exactly
# that reason: E2E_DIR (and SCRIPT_REPO) must never be allowed to become ""
# and then get used as a path anyway.
resolve_dir() { ( cd -P "$1" 2>/dev/null && pwd -P ); }

SCRIPT_REPO="$(resolve_dir "$HERE/../../../..")"
if [ -z "$SCRIPT_REPO" ] || [ ! -d "$SCRIPT_REPO" ]; then
  log "FAIL: could not resolve this script's own repo root from $HERE/../../../.. — unexpected layout."
  exit 1
fi

# E2E_DIR resolution (F2) — tried in order, first valid candidate wins, and
# an explicit override is trusted-or-rejected outright rather than silently
# falling through to a guess (a caller who bothered to set E2E_DIR gets a
# clear failure quoting their OWN value, not a mysteriously different
# directory). "Valid" means more than "exists": a directory could exist
# without being e2e/ at all, so every candidate is checked for the files
# every invocation of this script actually needs.
_looks_like_e2e_dir() { [ -d "$1" ] && [ -f "$1/package.json" ] && [ -f "$1/src/identities.ts" ]; }
E2E_DIR_OVERRIDE="${E2E_DIR:-}"
E2E_DIR=""
E2E_DIR_TRIED=""
try_e2e_dir() {
  local label="$1" candidate="$2" resolved
  [ -z "$candidate" ] && return 1
  resolved="$(resolve_dir "$candidate")"
  E2E_DIR_TRIED="$E2E_DIR_TRIED
  - $label ($candidate) -> ${resolved:-<does not exist>}"
  if [ -n "$resolved" ] && _looks_like_e2e_dir "$resolved"; then
    E2E_DIR="$resolved"
    return 0
  fi
  return 1
}

if [ -n "$E2E_DIR_OVERRIDE" ]; then
  if ! try_e2e_dir "E2E_DIR override" "$E2E_DIR_OVERRIDE"; then
    log "FAIL: E2E_DIR was explicitly set to '$E2E_DIR_OVERRIDE' but that is not a usable e2e/ checkout"
    log "  (expected a package.json and src/identities.ts under it; resolved: ${E2E_DIR_TRIED#*-> })."
    exit 1
  fi
elif try_e2e_dir "SIGNALS_REPO/e2e" "${SIGNALS_REPO:+$SIGNALS_REPO/e2e}"; then
  :
elif try_e2e_dir "this skill's own physical location" "$SKILL_DIR/../../../e2e"; then
  :
else
  GIT_TOP="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || true)"
  try_e2e_dir "git toplevel" "${GIT_TOP:+$GIT_TOP/e2e}" || true
fi

if [ -z "$E2E_DIR" ]; then
  log "FAIL: could not resolve the e2e/ checkout. This must never silently proceed with an empty or"
  log "  nonexistent E2E_DIR. Tried:$E2E_DIR_TRIED"
  log "Set E2E_DIR explicitly (the e2e/ directory itself), or SIGNALS_REPO (a checkout that carries its"
  log "  own e2e/), and retry."
  exit 1
fi

# This worktree may not be the checkout actually running the stack — same
# SIGNALS_REPO indirection stack-up.sh/search-indexer.mjs use (see their own
# header comments): this is an e2e-only worktree with no root .env of its own.
REPO="${SIGNALS_REPO:-$SCRIPT_REPO}"
STACK_ENV="$REPO/.env"

# ---------------------------------------------------------------------------
# 0. Preflight: docker + node's own version. SKILL.md's phase table promises
#    this; a missing docker or an out-of-range node otherwise surfaces ten
#    minutes later as a confusing knock-on error from stack-up.sh or one of
#    the stubs (search-stub.mjs imports a bare `.ts` file, relying on node's
#    default type-stripping — dead below node 22.18 — and this repo's own
#    `package.json` engines field pins >=24 repo-wide). Runs before the
#    `cleanup` short-circuit below too: cleanup.sh shells out to `docker exec`
#    for both psql and redis-cli.
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "FAIL: docker is not on PATH — the local stack (dpg-db, dpg-redis) and cleanup.sh's"
  log "  psql/redis-cli calls both need it."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  log "FAIL: docker is on PATH but its daemon isn't reachable (docker info failed) — start it and retry."
  exit 1
fi
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt 24 ]; then
  log "FAIL: node ${NODE_MAJOR:-<unreadable>} on PATH — this repo pins node >=24 (engines), and the"
  log "  e2e stubs rely on >=24's default TypeScript type-stripping to import .ts sources directly."
  exit 1
fi

# The two installs this script does NOT perform, checked HERE rather than
# discovered three layers down.
#
# Neither of these is optional and neither was preflighted, so a first-time run
# failed twice in a row with the cause hidden:
#
#   * no e2e/node_modules  ->  the search stub dies on `Cannot find module 'pg'`
#     inside a detached process, and the only symptom this script surfaces is
#     "search-stub did not answer at http://localhost:4546/... within 30s". The
#     real error sits in e2e/run/<id>/search-stub.log. Note run.sh already sets
#     NODE_PATH="$E2E_DIR/node_modules" for the stubs (§6) — it just never
#     ensured the directory exists.
#   * no Playwright browsers  ->  every UI spec fails with "Executable doesn't
#     exist", 22 of them on a full run, and they land in the report's "Not
#     working" section as unattributed failures a human is asked to triage.
#
# Deliberately a refusal with the exact command, not an auto-install: `npm ci`
# and a ~100 MB browser download are not side effects a test runner should
# perform behind the operator's back, and the node check directly above sets the
# precedent (it tells you to switch node rather than switching it for you).
if [ ! -d "$E2E_DIR/node_modules" ]; then
  log "FAIL: e2e/node_modules is missing — the stubs (search, mail sink, indexer) resolve"
  log "  'pg' from there via NODE_PATH, so they cannot start without it. Run:"
  log "    (cd '$E2E_DIR' && npm ci)"
  exit 1
fi
# Launch-and-close rather than a path check: the suite failed on
# `chromium_headless_shell`, which is a SEPARATE download from full chromium, so
# `chromium.executablePath()` can point at a browser that exists while the one
# Playwright actually launches does not. (`playwright install --dry-run` is no
# use either — it prints what it WOULD download and exits 0 regardless.)
# Costs ~0.5s and exercises the exact path every UI spec takes.
if ! (cd "$E2E_DIR" && node -e "require('playwright').chromium.launch().then(b=>b.close())" >/dev/null 2>&1); then
  log "FAIL: Playwright browsers are not installed for this host — every UI spec would fail"
  log "  with \"Executable doesn't exist\". Run:"
  log "    (cd '$E2E_DIR' && npx playwright install chromium)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 0b. Worker count (field-test fix, G1). playwright.config.ts's own default
#    is a flat 4 (`process.env.E2E_WORKERS ?? 4`) — sized for a CI box, not
#    for a machine that also hosts the app (API+UI), Postgres, Redis, three
#    e2e stubs, one HEADED Chromium per worker, and possibly a second
#    product's stack, all at once. A real run of this suite on an 8 GB Mac
#    measured 761 MB of free swap at 4 workers (10.5 of 11.3 GB used), UI
#    specs taking 24s-2.6min against 15s internal timeouts, and one failure
#    that was literally the OS killing a Chromium ("Target page, context or
#    browser has been closed"). Five whole specs failed at 4 workers and
#    passed at 2 with NO code change in between — that is this box
#    manufacturing phantom failures for a human to go hunt down, not real
#    flakiness.
#
#    min(4, max(1, floor(totalMemGB / 4))): floor(total/4) budgets roughly
#    4 GB per worker (one headed Chromium plus its share of the shared
#    services above) — that number is exactly what predicts this host's own
#    result (8 GB -> 2 workers, the setting the field test had to pass
#    E2E_WORKERS=2 by hand to get a trustworthy run). Capped at 4 so this is
#    never MORE aggressive than upstream's own default on a bigger box, and
#    floored at 1 so a run can always proceed even on a very small one. An
#    explicit E2E_WORKERS in the environment always wins over this
#    derivation and is never second-guessed.
# ---------------------------------------------------------------------------
if [ -n "${E2E_WORKERS:-}" ]; then
  log "E2E_WORKERS=$E2E_WORKERS set explicitly — using it as-is (no memory-based derivation)."
else
  TOTAL_MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || true)"
  if [ -z "$TOTAL_MEM_BYTES" ]; then
    TOTAL_MEM_BYTES="$(awk '/^MemTotal:/{print $2 * 1024; exit}' /proc/meminfo 2>/dev/null || true)"
  fi
  if [ -z "$TOTAL_MEM_BYTES" ] || ! [[ "$TOTAL_MEM_BYTES" =~ ^[0-9]+$ ]] || [ "$TOTAL_MEM_BYTES" -le 0 ]; then
    log "could not read total system memory (neither 'sysctl hw.memsize' nor /proc/meminfo answered) —"
    log "  falling back to playwright.config.ts's own default (4 workers). Set E2E_WORKERS explicitly to override."
  else
    TOTAL_MEM_GB=$(( TOTAL_MEM_BYTES / 1024 / 1024 / 1024 ))
    DERIVED_WORKERS=$(( TOTAL_MEM_GB / 4 ))
    [ "$DERIVED_WORKERS" -lt 1 ] && DERIVED_WORKERS=1
    [ "$DERIVED_WORKERS" -gt 4 ] && DERIVED_WORKERS=4
    export E2E_WORKERS="$DERIVED_WORKERS"
    log "derived E2E_WORKERS=$E2E_WORKERS from ${TOTAL_MEM_GB}GB total system memory" \
      "(min(4, max(1, floor(mem/4)))) — set E2E_WORKERS explicitly to override."
  fi
fi

# Single .env reader used everywhere below — cat/grep on a .env are
# permission-blocked in this environment (see run-signals-dpg's notes), so
# this is a node regex against the raw file. Prints the trimmed, unquoted
# value and exits 0, or prints nothing and exits non-zero when the key is
# absent, the file is unreadable, or the value is empty — callers can't
# mistake "not set" for "set to empty string".
read_env_value() {
  local key="$1" path="$2"
  node -e '
    const fs = require("fs");
    const [key, path] = process.argv.slice(1);
    let content;
    try { content = fs.readFileSync(path, "utf8"); } catch { process.exit(2); }
    const m = content.match(new RegExp("^" + key + "=(.*)$", "m"));
    if (!m) process.exit(3);
    const v = m[1].trim().replace(/^"(.*)"$/, "$1");
    if (!v) process.exit(3);
    process.stdout.write(v);
  ' "$key" "$path" 2>/dev/null
}

# `host:port` for a URL string, or empty + non-zero exit for anything that
# doesn't parse — used below to check an endpoint's VALUE, not just presence.
host_port_of() {
  node -e '
    try {
      const u = new URL(process.argv[1]);
      const port = u.port || (u.protocol === "https:" ? "443" : "80");
      process.stdout.write(`${u.hostname}:${port}`);
    } catch { process.exit(1); }
  ' "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# `cleanup <run-id>` — the standalone teardown-on-demand entry point. Reads
# the SAME Postgres creds stack-up.sh reads (never cleanup.sh's own generic
# defaults, which name a "signals" db this repo doesn't use), so a prior or
# orphaned run's residue can be cleared without re-deriving anything by hand.
# ---------------------------------------------------------------------------
if [ "${1:-}" = "cleanup" ]; then
  TAG="${2:?usage: run.sh cleanup <run-id>}"
  read_env_var_or() {
    local key="$1" path="$2" fallback="$3" value
    value="$(read_env_value "$key" "$path")"
    [ -n "$value" ] && printf '%s' "$value" || printf '%s' "$fallback"
  }
  CLEAN_PGUSER="$(read_env_var_or POSTGRES_USER "$STACK_ENV" postgres)"
  CLEAN_PGDB="$(read_env_var_or POSTGRES_DB "$STACK_ENV" signals)"
  log "cleaning run '$TAG' (PGUSER=$CLEAN_PGUSER PGDB=$CLEAN_PGDB)"
  PGUSER="$CLEAN_PGUSER" PGDB="$CLEAN_PGDB" bash "$HERE/cleanup.sh" "$TAG"
  exit $?
fi

# ---------------------------------------------------------------------------
# 1. Parse <dot> [alias]
# ---------------------------------------------------------------------------
DOT="${1:-blue_dot}"
ALIAS="${2:-}"

# ---------------------------------------------------------------------------
# 2. Alias table (spec §6). Resolves to a suite id (report.mjs's `SUITES`
#    catalogue, or empty for a cross-cutting alias with no single suite
#    number) and a Playwright --grep pattern matched against the existing
#    journey titles. An alias not in this table is refused, never silently
#    treated as "run everything".
# ---------------------------------------------------------------------------
print_alias_table() {
  cat >&2 <<'EOF'
Known aliases (spec §6) — usage: run.sh [dot] [alias]

  alias                    suite  grep pattern
  --------------------------------------------------------------------
  auth, login                2   Journey A|Journey B|Authenticated UI
  consent, legal              3   Journey K
  profile, form, schema       4   Journey A|Journey P
  u18, guardian                5   U18
  browse, search              6   Journey H
  map                          7   Journey M   (no journey yet — Plan 2)
  actions, connect, apply      8   Journey D|Journey E|Journey F|Journey R
  match                        9   Match Score (no journey yet — Plan 2)
  lifecycle, retire           10   Journey O
  share, public                11   Shareable Profile (no journey yet — Plan 2)
  support                     12   Journey L
  aggregator, admin           13   Journey I|Journey J|Journey V
  peer                         14   Peer Instance (no journey yet — Plan 2)
  emails                        —   Mail Sweep (cross-cutting, no journey yet — Plan 2)
  tourist                     16   Tourist (no journey yet — Plan 2)
  (omit alias)                  —   full run — every spec in tests/

See .claude/skills/signals-e2e/SKILL.md and references/ for what each suite
actually asserts today versus what is parked for the follow-on coverage plan.
EOF
}

ALIAS_SUITE_ID=""
ALIAS_GREP=""
resolve_alias() {
  case "$1" in
    auth|login)            ALIAS_SUITE_ID=2;  ALIAS_GREP='Journey A|Journey B|Authenticated UI' ;;
    consent|legal)         ALIAS_SUITE_ID=3;  ALIAS_GREP='Journey K' ;;
    profile|form|schema)   ALIAS_SUITE_ID=4;  ALIAS_GREP='Journey A|Journey P' ;;
    u18|guardian)          ALIAS_SUITE_ID=5;  ALIAS_GREP='U18' ;;
    browse|search)         ALIAS_SUITE_ID=6;  ALIAS_GREP='Journey H' ;;
    map)                   ALIAS_SUITE_ID=7;  ALIAS_GREP='Journey M' ;;
    actions|connect|apply) ALIAS_SUITE_ID=8;  ALIAS_GREP='Journey D|Journey E|Journey F|Journey R' ;;
    match)                 ALIAS_SUITE_ID=9;  ALIAS_GREP='Match Score' ;;
    lifecycle|retire)      ALIAS_SUITE_ID=10; ALIAS_GREP='Journey O' ;;
    share|public)          ALIAS_SUITE_ID=11; ALIAS_GREP='Shareable Profile' ;;
    support)               ALIAS_SUITE_ID=12; ALIAS_GREP='Journey L' ;;
    aggregator|admin)      ALIAS_SUITE_ID=13; ALIAS_GREP='Journey I|Journey J|Journey V' ;;
    peer)                  ALIAS_SUITE_ID=14; ALIAS_GREP='Peer Instance' ;;
    emails)                ALIAS_SUITE_ID=""; ALIAS_GREP='Mail Sweep' ;;
    tourist)               ALIAS_SUITE_ID=16; ALIAS_GREP='Tourist' ;;
    *) return 1 ;;
  esac
  return 0
}

if [ -n "$ALIAS" ]; then
  if ! resolve_alias "$ALIAS"; then
    log "unknown alias '$ALIAS'."
    print_alias_table
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# 3. A fresh run id, every invocation. `newPhone()` (e2e/src/identities.ts)
#    derives its phone-number sequence from the run id, so reusing one across
#    invocations collides with the previous run's identities and produces
#    confusing "identity must be new" failures — never accepted as an
#    argument here, always generated.
# ---------------------------------------------------------------------------
RUN="run$(date +%s)$$"
RUN_DIR="$E2E_DIR/run/$RUN"
mkdir -p "$RUN_DIR"
ENV_FILE="$RUN_DIR/env.sh"

log "run id: $RUN  dot: $DOT  alias: ${ALIAS:-<full run>}  repo: $REPO"

# ---------------------------------------------------------------------------
# 3b. Git provenance (R5, field-test fix). SIGNALS_REPO can point the STACK
#    (the app under test) at a checkout entirely different from the one
#    E2E_DIR's specs actually live in — this happened for real: app on
#    fix/637-legal-page-layout, specs on feat/signals-e2e-skill, 57 commits
#    apart, and nothing recorded or warned about it. That left one UI failure
#    in that run genuinely uninterpretable: real drift or stale spec,
#    unknowable. Recorded here (both SHAs/branches), diffed with `git -C`, and
#    handed to report.mjs so it renders right under the title — a diverged
#    pair must never be silently swallowed to be discovered only by a reader
#    who happens to check both checkouts by hand.
# ---------------------------------------------------------------------------
GIT_INFO_FILE="$RUN_DIR/git-info.json"
git_sha_of() { git -C "$1" rev-parse --short=12 HEAD 2>/dev/null || echo unknown; }
git_branch_of() { git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown; }

SPECS_SHA="$(git_sha_of "$E2E_DIR")"
SPECS_BRANCH="$(git_branch_of "$E2E_DIR")"
APP_SHA="$(git_sha_of "$REPO")"
APP_BRANCH="$(git_branch_of "$REPO")"

GIT_DIVERGED=false
GIT_COMPUTABLE=false
SPECS_AHEAD=0
APP_AHEAD=0
if [ "$SPECS_SHA" != "$APP_SHA" ] && [ "$SPECS_SHA" != "unknown" ] && [ "$APP_SHA" != "unknown" ]; then
  GIT_DIVERGED=true
  # Worktrees of the SAME repo share an object database, so this resolves even
  # though $E2E_DIR and $REPO may be different directories entirely. Two truly
  # unrelated repositories/histories make this fail — that's caught (non-zero
  # exit, empty $AHEAD_COUNTS) and surfaced as "diverged but not computable"
  # rather than crashing the run over a cosmetic detail.
  AHEAD_COUNTS="$(git -C "$E2E_DIR" rev-list --left-right --count "$APP_SHA...$SPECS_SHA" 2>/dev/null || true)"
  if [ -n "$AHEAD_COUNTS" ]; then
    GIT_COMPUTABLE=true
    APP_AHEAD="$(printf '%s' "$AHEAD_COUNTS" | awk '{print $1}')"
    SPECS_AHEAD="$(printf '%s' "$AHEAD_COUNTS" | awk '{print $2}')"
  fi
  log "⚠️  DIVERGED CHECKOUTS — specs ($E2E_DIR @ $SPECS_SHA/$SPECS_BRANCH) and app ($REPO @ $APP_SHA/$APP_BRANCH)" \
    "are NOT the same commit. See the report header for details; treat this signoff as provisional."
fi

node -e '
  const fs = require("fs");
  const [out, specsDir, specsSha, specsBranch, appDir, appSha, appBranch, diverged, computable, specsAhead, appAhead] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({
    specs: { dir: specsDir, sha: specsSha, branch: specsBranch },
    app: { dir: appDir, sha: appSha, branch: appBranch },
    diverged: diverged === "true",
    // When divergence could not be computed (no common ancestor, a detached
    // checkout, git unavailable), the ahead-counts are NULL rather than 0 — a
    // consumer must be able to tell "measured as equal" from "never measured".
    // Emitting 0 alongside computable:false made those indistinguishable, and
    // `diverged:false` was then only trustworthy by coincidence.
    computable: computable === "true",
    specsAhead: computable === "true" ? Number(specsAhead || 0) : null,
    appAhead: computable === "true" ? Number(appAhead || 0) : null,
  }));
' "$GIT_INFO_FILE" "$E2E_DIR" "$SPECS_SHA" "$SPECS_BRANCH" "$REPO" "$APP_SHA" "$APP_BRANCH" "$GIT_DIVERGED" "$GIT_COMPUTABLE" "$SPECS_AHEAD" "$APP_AHEAD"

# ---------------------------------------------------------------------------
# Teardown — installed BEFORE anything below can start a process or mutate the
# database, and trapped on EXIT so an interrupted run (Ctrl-C, a killed
# session) cleans up exactly like a finished one. `run_cleanup` is idempotent
# (guarded by CLEANUP_DONE) because the normal path also calls it explicitly,
# after the suite, so its residue count can feed the report — the trap is the
# safety net for every path that never reaches that point.
# ---------------------------------------------------------------------------
NOTIFY_PID=""
SEARCH_STUB_PID=""
INDEXER_PID=""
CLEANUP_DONE=false
RESIDUE_COUNT=0
CLEAN_PGUSER=""
CLEAN_PGDB=""
# The PID of whatever long-running foreground command is currently active
# (stack-up.sh, then npm run e2e:api, then npm run e2e:ui) — see run_fg below.
MAIN_CHILD_PID=""
# Set by on_signal only; teardown reads it to decide whether this run's
# directory is a finished artifact (kept) or interrupted debris (removed).
INTERRUPTED=false

stop_stubs() {
  local pid
  for pid in "$NOTIFY_PID" "$SEARCH_STUB_PID" "$INDEXER_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  wait >/dev/null 2>&1 || true
}

run_cleanup() {
  if [ "$CLEANUP_DONE" = true ]; then
    return 0
  fi
  CLEANUP_DONE=true
  if [ -z "$CLEAN_PGUSER" ] || [ -z "$CLEAN_PGDB" ]; then
    log "skipping final cleanup — Postgres creds were never resolved (failed before that step)"
    return 0
  fi
  local out="$RUN_DIR/cleanup-final.log"
  PGUSER="$CLEAN_PGUSER" PGDB="$CLEAN_PGDB" bash "$HERE/cleanup.sh" "$RUN" > "$out" 2>&1
  local code=$?
  cat "$out" >&2
  RESIDUE_COUNT="$(grep -c '^\[cleanup\] RESIDUE ' "$out" 2>/dev/null || true)"
  case "$RESIDUE_COUNT" in ''|*[!0-9]*) RESIDUE_COUNT=0 ;; esac
  return $code
}

teardown() {
  stop_stubs
  run_cleanup || true
  if [ "$INTERRUPTED" = true ]; then
    # An interrupted run has no finished report — its directory is debris,
    # not an artifact worth keeping (unlike a completed run's, which stays
    # for post-mortem). run_cleanup() above already ran exactly once (guarded
    # by CLEANUP_DONE) before this removes the directory it wrote into, so
    # there is nothing left to race.
    rm -rf "$RUN_DIR"
    log "interrupted — removed $RUN_DIR (a completed run's directory is kept; an interrupted one is not)"
  fi
}
trap teardown EXIT

# on_signal is the actual fix for "an interrupted run cleans up like a
# finished one". An `EXIT` trap ALONE does not fire promptly here: this
# script spends nearly all its time blocked on a foreground child (stack-up.sh,
# then `npm run e2e:api`/`e2e:ui`), and bash defers a trapped signal until the
# CURRENT foreground command returns — confirmed empirically on this host,
# including with an explicit trap already registered. `run_fg` below runs
# that child as a background job and `wait`s on it instead of exec'ing it
# directly, because bash's `wait` builtin is special-cased to return AS SOON
# AS a trapped signal arrives, even though the child keeps running — the trap
# then fires immediately, without waiting for the child.
#
# That still leaves the child alive, so on_signal has to kill it itself — and
# it must send SIGTERM, never SIGINT/SIGQUIT: confirmed empirically that a
# non-interactive, job-control-off bash (this script, launched via `... &`,
# exactly how `/signals-e2e` is invoked) sets SIGINT and SIGQUIT to SIG_IGN
# for every `&`-backgrounded child BEFORE exec — that disposition cannot be
# changed by the child itself once inherited, so `kill -INT` on a backgrounded
# `npm`/`playwright` process is a silent no-op even though the kill call
# itself reports success. SIGTERM carries no such exemption, and both `npm`
# and Playwright's own runner already handle it (Playwright installs a
# SIGTERM/SIGINT handler to abort in-flight browsers rather than orphaning
# them). No `setsid` on macOS, and process-group signalling behaved
# inconsistently across `set -m` states when tested here — sending SIGTERM to
# the direct child is what was actually verified to work, so that is what
# this does, with a SIGKILL fallback for a child that does not exit promptly.
on_signal() {
  local sig="$1" code="$2"
  log "received SIG$sig — stopping the running command and shutting down..."
  INTERRUPTED=true
  if [ -n "$MAIN_CHILD_PID" ]; then
    kill -TERM "$MAIN_CHILD_PID" >/dev/null 2>&1 || true
    sleep 1
    if kill -0 "$MAIN_CHILD_PID" >/dev/null 2>&1; then
      log "child $MAIN_CHILD_PID still alive 1s after SIGTERM — sending SIGKILL"
      kill -KILL "$MAIN_CHILD_PID" >/dev/null 2>&1 || true
    fi
    wait "$MAIN_CHILD_PID" >/dev/null 2>&1 || true
  fi
  # `exit` here runs the EXIT trap (`teardown`) exactly once — no separate
  # call needed, and no double-teardown to reason about.
  exit "$code"
}
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

# Runs "$@" as a background job and waits on it, recording its pid in
# MAIN_CHILD_PID for on_signal above. Every long-running foreground command
# in this script goes through this instead of being exec'd directly.
run_fg() {
  "$@" &
  MAIN_CHILD_PID=$!
  wait "$MAIN_CHILD_PID"
  local code=$?
  MAIN_CHILD_PID=""
  return $code
}

# ---------------------------------------------------------------------------
# 4. Stack reuse, bring-up, or verify-only — three distinct outcomes:
#      (a) a live marker for the SAME dot from a PRIOR e2e run — reuse it,
#          skip stack-up.sh entirely. Verified live (not just "the marker
#          file exists") by re-probing the api and ui urls it recorded.
#      (b) no marker, but the target already answers (started some other
#          way) — run stack-up.sh only, to verify + write this run's own
#          env.sh/marker.
#      (c) no marker, and nothing answers — actually bring the stack up
#          first (lib/bring-stack-up.sh), then stack-up.sh to verify + write.
#    Every path still gets its own fresh E2E_RUN_ID (see the run-id comment
#    above) even when the underlying stack itself is reused.
# ---------------------------------------------------------------------------
find_live_marker() {
  local dot="$1" m api network ui code
  for m in $(ls -t "$E2E_DIR"/run/*/stack.marker 2>/dev/null); do
    [ -f "$m" ] || continue
    grep -q "^dot=${dot}\$" "$m" || continue
    api="$(awk -F= '/^api=/{print $2}' "$m")"
    network="$(awk -F= '/^network=/{print $2}' "$m")"
    ui="$(awk -F= '/^ui=/{print $2}' "$m")"
    [ -z "$api" ] && continue
    code="$(curl -s -o /dev/null -w '%{http_code}' "$api/api/v1/network/schemas?network=$network" 2>/dev/null)"
    [ "$code" = "200" ] || continue
    code="$(curl -s -o /dev/null -w '%{http_code}' "$ui/" 2>/dev/null)"
    [ "$code" = "200" ] || continue
    echo "$m"
    return 0
  done
  return 1
}

STACK_REUSED=false
MARKER_FOUND="$(find_live_marker "$DOT" || true)"
if [ -n "$MARKER_FOUND" ] && [ -f "$(dirname "$MARKER_FOUND")/env.sh" ]; then
  OLD_RUN_DIR="$(dirname "$MARKER_FOUND")"
  log "stack reuse detected — a live target already matches dot=$DOT (marker: $MARKER_FOUND, from run $(basename "$OLD_RUN_DIR")). Skipping stack-up.sh."
  cp "$OLD_RUN_DIR/env.sh" "$ENV_FILE"
  cp "$MARKER_FOUND" "$RUN_DIR/stack.marker"
  # Appended last so it wins when the file is sourced below — this run's own
  # id overrides whatever E2E_RUN_ID the reused stack's env.sh carried.
  printf "export E2E_RUN_ID='%s'\n" "$RUN" >> "$ENV_FILE"
  STACK_REUSED=true
else
  # No marker from a PRIOR e2e run — but the target could still be live right
  # now from an unrelated source (a manual run-signals-dpg session, or an e2e
  # run whose marker aged out). A cheap, single-shot probe here decides
  # whether anything needs bringing up at all, rather than assuming "no
  # marker" means "nothing is running".
  #
  # (F3) Before this existed, EVERY cold-machine invocation (nothing running
  # at all) landed in this branch, logged the line below unconditionally, and
  # handed straight to stack-up.sh — which only VERIFIES a live target and
  # gives up after ~40s if nothing answers. The log line read as though
  # something was being started; nothing was, and the run just died 40s
  # later with no stack ever brought up. `bring-stack-up.sh` (this repo's
  # executable copy of `references/bringing-the-stack-up.md`) is what
  # actually starts docker/db/redis, applies the schema, and launches the API
  # + UI — it is only invoked when the quick probe below finds nothing live.
  QUICK_NET_ID="$(cd "$REPO" 2>/dev/null && node -e "try{console.log(require('./examples/schemas/$DOT/network.json').id)}catch{process.exit(1)}" 2>/dev/null || true)"
  ALREADY_LIVE=false
  if [ -n "$QUICK_NET_ID" ] && curl -sf "http://localhost:2742/api/v1/network/schemas?network=$QUICK_NET_ID" >/dev/null 2>&1; then
    ALREADY_LIVE=true
  fi

  if [ "$ALREADY_LIVE" = true ]; then
    log "API already answering for dot=$DOT (network=$QUICK_NET_ID) — verifying only (lib/stack-up.sh); nothing to bring up."
  else
    log "no live stack for dot=$DOT — bringing one up now (lib/bring-stack-up.sh: infra, schema, API, UI)."
    if ! run_fg bash "$HERE/bring-stack-up.sh" "$DOT"; then
      log "FAIL: bring-stack-up.sh could not bring the target to a ready state (see its output above)."
      exit 1
    fi
  fi

  # EXECUTED under bash, never sourced (stack-up.sh's own header explains why:
  # BASH_SOURCE and a `local status` are bash-only, and the user's shell is
  # zsh). Its exit status is checked BEFORE the env file it wrote is sourced —
  # a mid-failure leaves a partially-populated env.sh alongside a non-zero
  # exit, and sourcing that as if it had succeeded would silently run the
  # suite against half-configured capabilities.
  if ! run_fg bash "$HERE/stack-up.sh" "$DOT" "$RUN"; then
    log "FAIL: stack-up.sh could not verify the target (see its output above)."
    exit 1
  fi
fi

if [ ! -f "$ENV_FILE" ]; then
  log "FAIL: stack-up.sh reported success but left no env file at $ENV_FILE."
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
log "env loaded — E2E_RUN_ID=${E2E_RUN_ID:-} E2E_UI_BASE_URL=${E2E_UI_BASE_URL:-} E2E_API_BASE_URL=${E2E_API_BASE_URL:-}"

# ---------------------------------------------------------------------------
# 4b. Notification preflight (defect fix). The API's notification client
# (apps/api/src/utils/notificationClient.ts:14-18) returns undefined — logs
# the OTP, sends NOTHING — unless ALL THREE of NOTIFICATION_SERVICE_ENDPOINT,
# _KEY_ID and _SECRET are set on the TARGET (not this worktree). With only the
# endpoint set, `notificationStub` reads as enabled while every mail assertion
# silently passes against an empty inbox.
#
# Presence alone is NOT enough, though: if the endpoint is a REAL
# notification service (not this run's sink), the sink stays empty exactly
# like the all-absent case above, AND this run dispatches real email/SMS —
# `newPhone()` mints numbers shaped `+919XXXXXXXXX`, valid Indian mobiles,
# with only the empty DLT template ids standing between that and texting a
# stranger. So the endpoint's host:port is checked against the sink's, not
# just asserted non-empty. Key/secret stay presence-only: the sink ignores
# HMAC, so any non-empty value satisfies it.
# ---------------------------------------------------------------------------
NOTIFY_SINK_HOST_PORT="localhost:4545"
SEARCH_STUB_HOST_PORT="localhost:4546"

assert_notification_env() {
  local missing="" key value endpoint got
  for key in NOTIFICATION_SERVICE_ENDPOINT NOTIFICATION_SERVICE_KEY_ID NOTIFICATION_SERVICE_SECRET; do
    value="$(read_env_value "$key" "$STACK_ENV")"
    [ -z "$value" ] && missing="$missing $key"
  done
  if [ -n "$missing" ]; then
    log "FAIL: the notification client needs ALL THREE of NOTIFICATION_SERVICE_ENDPOINT,"
    log "  NOTIFICATION_SERVICE_KEY_ID and NOTIFICATION_SERVICE_SECRET — missing on $STACK_ENV:$missing"
    log "  With even one absent, the API logs the OTP and sends nothing: notificationStub would"
    log "  read as enabled while every mail assertion silently passes against an empty inbox."
    log "  Set all three (dummy key/secret are fine, the sink ignores HMAC), restart the API, retry."
    return 1
  fi
  endpoint="$(read_env_value NOTIFICATION_SERVICE_ENDPOINT "$STACK_ENV")"
  got="$(host_port_of "$endpoint")"
  if [ "$got" != "$NOTIFY_SINK_HOST_PORT" ]; then
    log "FAIL: NOTIFICATION_SERVICE_ENDPOINT=$endpoint does not point at the sink ($NOTIFY_SINK_HOST_PORT)."
    log "  A real endpoint here means this run dispatches REAL email/SMS — including to +919-shaped"
    log "  numbers this suite mints itself. Point it at the sink on $STACK_ENV, restart the API, retry."
    return 1
  fi
  log "notification preflight OK — endpoint/key/secret all present on $STACK_ENV and endpoint matches the sink"
  return 0
}

# ---------------------------------------------------------------------------
# 4c. Search preflight. SIGNALS_SEARCH_URL is OPTIONAL — real signals-search
# is opt-in per host (see stack-up.sh's E2E_REAL_SEARCH_URL comment), so its
# absence is expected on a target this recipe didn't bring up itself, not a
# failure. (F7) `bring-stack-up.sh` now sets it — and `SIGNALS_SEARCH_API_KEY`
# alongside it — pointed at the stub, so this normally reads as OK rather than
# warning on every cold run.
#
# BOTH vars matter, not just the URL: `signals_search_client.ts`'s
# `searchSignals()` throws "not configured" and the discover BFF silently
# falls back to native whenever EITHER `SIGNALS_SEARCH_URL` or
# `SIGNALS_SEARCH_API_KEY` is unset — so a URL-only setup would pass the OLD
# version of this check while still routing zero traffic to the stub, the
# exact "capability reads as enabled, records nothing" bug this function
# exists to catch, just moved one env var over. The stub itself only checks
# the key's PRESENCE (`Boolean(req.headers['x-api-key'])`), never its value,
# so a dummy key satisfies it, same as the notification key/secret above.
#
# If SIGNALS_SEARCH_URL points anywhere other than the search stub, the
# stub's envelope recorder sees no traffic and silently records nothing while
# the `search-stub` capability still reads as available — same shape of bug
# as the notification one above, just without the real-world-harm
# consequence, so it degrades to a warning rather than a hard fail when
# simply absent (a target this recipe didn't bring up may legitimately not
# have it set).
# ---------------------------------------------------------------------------
assert_search_env() {
  local value key got
  value="$(read_env_value SIGNALS_SEARCH_URL "$STACK_ENV")"
  if [ -z "$value" ]; then
    log "SIGNALS_SEARCH_URL not set on $STACK_ENV — the search-stub's envelope recorder will see no"
    log "  traffic this run (native/items fallback only). Set it to http://$SEARCH_STUB_HOST_PORT"
    log "  (and SIGNALS_SEARCH_API_KEY to any non-empty value) first if this run needs to assert on"
    log "  recorded search envelopes."
    return 0
  fi
  key="$(read_env_value SIGNALS_SEARCH_API_KEY "$STACK_ENV")"
  if [ -z "$key" ]; then
    log "FAIL: SIGNALS_SEARCH_URL is set on $STACK_ENV but SIGNALS_SEARCH_API_KEY is not — searchSignals()"
    log "  treats EITHER being unset as \"not configured\" and silently falls back to native, so the stub"
    log "  would see no traffic while this capability still reads as enabled. Set both (the stub ignores"
    log "  the key's value, only its presence), restart the API, retry."
    return 1
  fi
  got="$(host_port_of "$value")"
  if [ "$got" != "$SEARCH_STUB_HOST_PORT" ]; then
    log "FAIL: SIGNALS_SEARCH_URL=$value does not point at the search stub ($SEARCH_STUB_HOST_PORT) —"
    log "  the envelope recorder would silently record nothing while this capability reads as enabled."
    return 1
  fi
  log "search preflight OK — SIGNALS_SEARCH_URL/_API_KEY both present and the URL matches the search stub"
  return 0
}

if ! assert_notification_env; then
  exit 1
fi
if ! assert_search_env; then
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Start the three stubs, waiting for each to answer before continuing.
#    Always started fresh (not reused) and always torn down on EXIT — their
#    lifecycle belongs to this invocation, independent of whether the
#    underlying API/UI/DB stack was reused above.
# ---------------------------------------------------------------------------
free_port() {
  local port="$1" pid
  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    log "port $port already in use (pid $pid) — a stray from an earlier run's failed teardown. Killing it."
    kill $pid >/dev/null 2>&1 || true
    sleep 1
  fi
}

wait_for() {
  local url="$1" name="$2" i
  for i in $(seq 1 30); do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  log "FAIL: $name did not answer at $url within 30s — see $RUN_DIR/$name.log"
  return 1
}

free_port 4545
free_port 4546
free_port 4547

SINK_PORT=4545 node "$HERE/notify-sink.mjs" > "$RUN_DIR/notify-sink.log" 2>&1 &
NOTIFY_PID=$!
NODE_PATH="$E2E_DIR/node_modules" PGURL="$E2E_DB_URL" SEARCH_STUB_PORT=4546 \
  node "$HERE/search-stub.mjs" > "$RUN_DIR/search-stub.log" 2>&1 &
SEARCH_STUB_PID=$!
NODE_PATH="$E2E_DIR/node_modules" PGURL="$E2E_DB_URL" REDIS_CONTAINER="${REDIS_CONTAINER:-dpg-redis}" \
  SIGNALS_REPO="$REPO" INDEXER_PORT=4547 \
  node "$HERE/search-indexer.mjs" > "$RUN_DIR/search-indexer.log" 2>&1 &
INDEXER_PID=$!

if ! wait_for "http://localhost:4545/providers" "notify-sink"; then exit 1; fi
if ! wait_for "http://localhost:4546/_e2e/envelopes" "search-stub"; then exit 1; fi
if ! wait_for "http://localhost:4547/_e2e/stats" "search-indexer"; then exit 1; fi
log "three stubs live — notify-sink:4545 search-stub:4546 search-indexer:4547"

# ---------------------------------------------------------------------------
# 6. Snapshot before, so cleanup can prove "no residue" rather than merely
#    "the deletes ran". Needs the SAME Postgres creds stack-up.sh derived for
#    E2E_DB_URL — parsed back out of it rather than re-read from .env a second
#    time, so there is exactly one place that can disagree with itself.
# ---------------------------------------------------------------------------
if [[ "$E2E_DB_URL" =~ ^postgres://([^:]+):([^@]*)@[^/:]+:[0-9]+/(.+)$ ]]; then
  CLEAN_PGUSER="${BASH_REMATCH[1]}"
  CLEAN_PGDB="${BASH_REMATCH[3]}"
else
  log "FAIL: could not parse E2E_DB_URL to derive Postgres creds for cleanup.sh."
  exit 1
fi

# Exit status checked — an unreachable/misconfigured DB here used to fail
# silently: cleanup.sh's OWN hard failure ("could not read a row count") still
# exits non-zero, but nothing here consulted that, so the run carried on with
# no snapshot-before.txt and later downgraded to "no baseline, skipping the
# residue check" — a warning, not a failure, ending green with zero evidence
# the target was ever reachable at all.
if ! PGUSER="$CLEAN_PGUSER" PGDB="$CLEAN_PGDB" bash "$HERE/cleanup.sh" "$RUN" --snapshot-only; then
  log "FAIL: could not snapshot the DB before the suite starts (cleanup.sh --snapshot-only exited"
  log "  non-zero — target unreachable, misconfigured, or a table is missing). Aborting rather than"
  log "  running the suite blind with no residue baseline to diff against afterward."
  exit 1
fi

# ---------------------------------------------------------------------------
# 7. Run the suite: API tier (deterministic, no browser), then UI tier
#    (headless by default — see HEADED_ARGS below; a visible Chromium window
#    popping up mid-run is a real interruption on a shared desktop, and buys
#    nothing on an unattended signoff). Both run even if the first has
#    failures — a failing api spec must not hide the ui tier's own results —
#    and each tier's own `test-results/results.json` is copied out before the
#    next tier's Playwright invocation overwrites the same path. Each tier is
#    first asked (via `tier_test_count`, below) whether it has anything to run
#    for the current `--grep` at all, and skipped rather than run-and-fail
#    when it doesn't — see that function's comment for why.
# ---------------------------------------------------------------------------
cd "$E2E_DIR"
export E2E_ENV="${E2E_ENV:-local}"

# R4 (field-test fix) — a FULL signoff run gets --retries=0, never
# playwright.config.ts's own `retries: 1`: a retry on a full run is exactly
# how a real collision (three workers minting the same phone number) turned
# into "3 hard failures + 2 flaky passes" that read as partially clean when
# it was one bug throughout. "One restart is a fix; a retry loop is a lie."
# A SCOPED/alias run keeps the config default (1) on purpose — its whole
# point is fast dev feedback on a shared, sometimes-flaky external target,
# and report.mjs's own new flaky category (2b) means a scoped run's retries
# no longer hide anything: a flaky pass is reported, never silently folded
# into section 1, and still fails the run's exit code.
if [ -z "$ALIAS" ]; then
  RETRY_ARGS="--retries=0"
else
  RETRY_ARGS=""
fi

# Headless by default (Playwright's own default — this is deliberately
# ADDITIVE, never subtractive): a visible Chromium window popping up mid-run
# is a real interruption on a machine someone is actively using, and an
# unattended signoff gets nothing from being watchable. `E2E_HEADED=1` (or
# `true`) opts back in, e.g. to actually watch a run or drive the UI
# interactively while triaging a flake — an explicit setting always wins,
# same convention as `E2E_WORKERS` above. Headless Chromium is also
# meaningfully lighter on memory than headed, which helps rather than hurts
# the worker-count story above.
if [ "${E2E_HEADED:-}" = "1" ] || [ "${E2E_HEADED:-}" = "true" ]; then
  HEADED_ARGS="--headed"
  log "E2E_HEADED=$E2E_HEADED — running the UI tier headed (a visible browser window will open)."
else
  HEADED_ARGS=""
fi

# A tier that exits non-zero must never be silently discarded just because
# Playwright itself captured no failed spec — a `--grep` matching zero tests
# ("No tests found") exits 1 while writing `errors: [...]` and
# `stats: {expected:0, skipped:0, ...}`, and a fixture throwing or a bad
# config can exit non-zero with NO results.json at all. Both are consulted
# here (API_CODE/UI_CODE were previously captured and never read) by folding
# the exit code into that tier's own `errors[]` whenever it disagrees with
# what results.json shows — report.mjs's new check on `errors`/`stats` then
# turns that into a section-2 entry instead of a fabricated, lying "clean"
# empty-suites file.
inject_exit_code_error() {
  local path="$1" tier="$2" code="$3"
  node -e '
    const fs = require("fs");
    const [path, tier, code] = process.argv.slice(1);
    let data;
    try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch { data = { suites: [] }; }
    const anyFailed = (suites) => (suites || []).some((s) =>
      anyFailed(s.suites) ||
      (s.specs || []).some((spec) => (spec.tests || []).some((t) =>
        (t.results || []).some((r) => r.status === "failed" || r.status === "timedOut"))));
    const codeNum = Number(code);
    if (codeNum !== 0 && !anyFailed(data.suites)) {
      data.errors = [...(data.errors || []), {
        message: `${tier} tier exited ${codeNum} with no failed spec captured in results.json ` +
          "(no tests matched --grep, a fixture threw before any test ran, or the reporter crashed).",
      }];
    }
    fs.writeFileSync(path, JSON.stringify(data));
  ' "$path" "$tier" "$code"
}

# Whether a tier has ANYTHING to run for the current --grep, asked of
# Playwright itself via `--list` rather than inferred from an exit code. An
# alias whose journey lives in only one tier (e.g. `consent` — API-only) makes
# the OTHER tier's `--grep` legitimately match nothing: running it for real
# would exit 1 with "Error: No tests found", which used to get folded (via
# inject_exit_code_error above) into a section-2 "not working" entry even
# though the alias's real coverage passed cleanly in its own tier. That is a
# different failure shape from "this alias matched nothing in EITHER tier"
# (the original bug this suite's alias table exists to catch, e.g. `map` —
# no journey written yet at all) — the distinction can only be drawn at the
# merged-results level (step 7b below), not per tier, so this function's only
# job is to answer "does this ONE tier have anything", cheaply, before
# spending the time to actually run it.
#
# `--list` always exits 0 (confirmed live, this Playwright version) and prints
# `Total: N tests in M files` regardless of N — including 0 — so N is parsed
# out of that line rather than relied on as an exit code. A line that fails to
# parse (a crashed config, an unexpected output shape) returns -1, which every
# caller below treats as "unknown — run the tier for real" rather than
# silently skipping it: an unparseable `--list` must never be the reason a
# tier's real error goes unseen.
tier_test_count() {
  local dir="$1" grep_pat="$2" out n
  if [ -n "$grep_pat" ]; then
    out="$(npx playwright test "$dir" --grep "$grep_pat" --list 2>&1)"
  else
    out="$(npx playwright test "$dir" --list 2>&1)"
  fi
  n="$(printf '%s\n' "$out" | grep -Eo 'Total: [0-9]+ test' | grep -Eo '[0-9]+' | tail -1)"
  if [[ "$n" =~ ^[0-9]+$ ]]; then
    printf '%s' "$n"
  else
    printf '%s' "-1"
  fi
}

API_COUNT="$(tier_test_count tests/api "$ALIAS_GREP")"
if [ "$API_COUNT" = "0" ]; then
  log "API tier: --list matched 0 tests (grep: ${ALIAS_GREP:-<none>}) — skipping this tier;" \
    "this alias's coverage may live entirely in the other tier, which is not a failure on its own."
  echo '{"suites":[]}' > "$RUN_DIR/results-api.json"
  API_CODE=0
else
  rm -f test-results/results.json
  # ALIAS_GREP and RETRY_ARGS are mutually exclusive by construction (both
  # derive from whether $ALIAS is set) — an alias run never gets --retries=0,
  # a full run never has a --grep.
  if [ -n "$ALIAS_GREP" ]; then
    run_fg npm run e2e:api -- --grep "$ALIAS_GREP"
  elif [ -n "$RETRY_ARGS" ]; then
    run_fg npm run e2e:api -- "$RETRY_ARGS"
  else
    run_fg npm run e2e:api
  fi
  API_CODE=$?
  if [ -f test-results/results.json ]; then
    cp test-results/results.json "$RUN_DIR/results-api.json"
  else
    echo '{"suites":[]}' > "$RUN_DIR/results-api.json"
  fi
  inject_exit_code_error "$RUN_DIR/results-api.json" API "$API_CODE"
fi
log "API tier exit code: $API_CODE"

UI_COUNT="$(tier_test_count tests/ui "$ALIAS_GREP")"
if [ "$UI_COUNT" = "0" ]; then
  log "UI tier: --list matched 0 tests (grep: ${ALIAS_GREP:-<none>}) — skipping this tier;" \
    "this alias's coverage may live entirely in the other tier, which is not a failure on its own."
  echo '{"suites":[]}' > "$RUN_DIR/results-ui.json"
  UI_CODE=0
else
  rm -f test-results/results.json
  # $HEADED_ARGS unquoted deliberately: "" word-splits to nothing (headless,
  # the default), "--headed" contributes exactly one word (E2E_HEADED=1) — the
  # same bash-3.2-safe "no arrays" approach every other optional flag in this
  # script uses, see this file's own header comment.
  if [ -n "$ALIAS_GREP" ]; then
    run_fg npm run e2e:ui -- $HEADED_ARGS --grep "$ALIAS_GREP"
  elif [ -n "$RETRY_ARGS" ]; then
    run_fg npm run e2e:ui -- $HEADED_ARGS "$RETRY_ARGS"
  else
    run_fg npm run e2e:ui -- $HEADED_ARGS
  fi
  UI_CODE=$?
  if [ -f test-results/results.json ]; then
    cp test-results/results.json "$RUN_DIR/results-ui.json"
  else
    echo '{"suites":[]}' > "$RUN_DIR/results-ui.json"
  fi
  inject_exit_code_error "$RUN_DIR/results-ui.json" UI "$UI_CODE"
fi
log "UI tier exit code: $UI_CODE"

# ---------------------------------------------------------------------------
# 7b. Merge at the results level, not the exit-code level — this is what
#     makes "matched nothing in one tier, passed in the other" read as green
#     and "matched nothing in EITHER tier" (both skipped above, so both
#     contribute an empty `suites: []` and zero stats) still read as
#     report.mjs's `zeroExecuted` section-2 entry. `flaky` is carried through
#     alongside expected/skipped/unexpected — playwright.config.ts sets
#     `retries: 1` deliberately (a real external-target flake passes on
#     retry), and dropping `flaky` here made report.mjs's `zeroExecuted` check
#     blind to a run whose only spec passed on retry (counted as 0 executed)
#     while section 1 correctly showed it as working.
# ---------------------------------------------------------------------------
node -e '
  const fs = require("fs");
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
  const a = readJson(process.argv[1]);
  const b = readJson(process.argv[2]);
  const merged = {
    suites: [...(a.suites || []), ...(b.suites || [])],
    errors: [...(a.errors || []), ...(b.errors || [])],
    stats: {
      expected: (a.stats?.expected || 0) + (b.stats?.expected || 0),
      skipped: (a.stats?.skipped || 0) + (b.stats?.skipped || 0),
      unexpected: (a.stats?.unexpected || 0) + (b.stats?.unexpected || 0),
      flaky: (a.stats?.flaky || 0) + (b.stats?.flaky || 0),
    },
  };
  fs.writeFileSync(process.argv[3], JSON.stringify(merged));
' "$RUN_DIR/results-api.json" "$RUN_DIR/results-ui.json" "$RUN_DIR/results-merged.json"

# ---------------------------------------------------------------------------
# 8a. Final cleanup — explicit (not just the EXIT trap), so its residue count
#     is known before the report is built. Sets CLEANUP_DONE, so the trap's
#     own call to run_cleanup at step 9's `exit` is a no-op.
# ---------------------------------------------------------------------------
run_cleanup
CLEANUP_CODE=$?
if [ "$CLEANUP_CODE" -eq 0 ]; then
  log "cleanup: clean — no residue"
else
  log "cleanup: FAIL — residue in $RESIDUE_COUNT table(s), see $RUN_DIR/cleanup-final.log"
fi

# ---------------------------------------------------------------------------
# 8b. Coverage drift (spec §9) — whatever `npm run coverage` finds unmapped,
#     flattened into the plain string lines report.mjs's section 5 expects.
#     Not gated on its own exit code; a drifted coverage check still has to
#     surface in the SAME signoff, not abort it before section 2 is known.
# ---------------------------------------------------------------------------
node scripts/check-coverage.mjs --json > "$RUN_DIR/coverage.json" 2>"$RUN_DIR/coverage.err.log" || true
node -e '
  const fs = require("fs");
  let data;
  try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { data = {}; }
  const lines = [];
  for (const r of data.unmapped || []) lines.push(`route ${r}`);
  for (const [k, v] of Object.entries(data.features || {})) {
    for (const u of (v && v.unmapped) || []) lines.push(`${k} ${u}`);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(lines));
' "$RUN_DIR/coverage.json" "$RUN_DIR/coverage-drift.json"

# ---------------------------------------------------------------------------
# 9. The report (section 2's grouping, 2b flaky, section 4 dedupe, the git-
#    provenance header — see report.mjs). Exit with ITS code — non-zero iff
#    section 2 (Not working) or 2b (Flaky) is non-empty, per report.mjs's
#    contract.
#
# R6 (field-test fix) — written to the FILE ONLY here, deliberately not
# tee'd to stdout at this point. The field-test run DID print the report to
# stdout, but ~840 lines before the "report written to ..." log line — headed
# Playwright output and per-failure trace dumps buried it so completely that
# the agent read the file separately with `cat`, summarised it in its own
# words, and its human never saw the five sections at all. The fix is to make
# the full report the LAST thing this script ever prints — after the "written
# to" log line, not folded into the middle of a thousand-line stream — so a
# human (or an agent that's supposed to relay this verbatim, per SKILL.md's
# ground rules) cannot scroll past it.
# ---------------------------------------------------------------------------
REPORT_MD="$RUN_DIR/report.md"
if [ -n "$ALIAS" ]; then
  node "$SKILL_DIR/lib/report.mjs" \
    --results "$RUN_DIR/results-merged.json" \
    --residue "$RESIDUE_COUNT" \
    --cleanup-code "$CLEANUP_CODE" \
    --coverage-drift "$RUN_DIR/coverage-drift.json" \
    --git-info "$GIT_INFO_FILE" \
    --scoped-alias "$ALIAS" \
    --scoped-suites "$ALIAS_SUITE_ID" \
    > "$REPORT_MD"
else
  node "$SKILL_DIR/lib/report.mjs" \
    --results "$RUN_DIR/results-merged.json" \
    --residue "$RESIDUE_COUNT" \
    --cleanup-code "$CLEANUP_CODE" \
    --coverage-drift "$RUN_DIR/coverage-drift.json" \
    --git-info "$GIT_INFO_FILE" \
    > "$REPORT_MD"
fi
REPORT_CODE=$?

log "report written to $REPORT_MD — exit code $REPORT_CODE"
log "──────────────────────────────────────────────────────────────────────"
log "the signoff report follows — this is the point of this run, read it, do not just check the exit code:"
echo
cat "$REPORT_MD"
exit "$REPORT_CODE"
