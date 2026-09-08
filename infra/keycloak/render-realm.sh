#!/bin/sh
# Renders realm JSON templates from /opt/keycloak/data/import-template into the
# import dir, substituting the __PLACEHOLDER__ tokens, then hands off to the
# upstream Keycloak entrypoint.
#
# Why a render step: Keycloak --import-realm does not perform env-var
# substitution on realm JSON. The signals clients' redirectUris/webOrigins have
# to name a real browser-facing host, and the OTP flow needs working SMTP for
# the email channel — neither can be hardcoded per environment.
#
# Same approach and the same placeholder names as
# aggregator-dpg/infra/keycloak/render-realm.sh, so the two realm exports stay
# interchangeable while the shared `bluedots` realm has two producers.
#
# NOTE: this only takes effect on FIRST import. Once the realm exists in
# Keycloak's database, changes here are ignored — that is what
# init/apply-user-profile.sh is for.
set -eu

SRC_DIR="/opt/keycloak/data/import-template"
DST_DIR="/opt/keycloak/data/import"

: "${PUBLIC_BASE_URL:?PUBLIC_BASE_URL must be set (e.g. http://localhost:5173)}"

# Browser-facing base URL of the signals API. The BFF login (AUTH-VULN-03/04)
# runs the OIDC code exchange server-side, so Keycloak redirects the browser to
# the API's /api/v1/auth/session/callback — which means the API's own origin has
# to be a registered redirect URI for `signals-ui`. Defaults to PUBLIC_BASE_URL,
# which is correct wherever the UI and API share a host.
: "${API_BASE_URL:=$PUBLIC_BASE_URL}"

# SMTP placeholders. Empty values are valid: when SMTP_AUTH=false, Keycloak
# ignores SMTP_USER/SMTP_PASSWORD even if they are empty strings. Without
# working SMTP the email OTP channel cannot deliver a code — phone still can.
: "${SMTP_HOST:=mailpit}"
: "${SMTP_PORT:=1025}"
: "${SMTP_FROM:=no-reply@bluedots.local}"
: "${SMTP_FROM_DISPLAY:=Blue Dots}"
: "${SMTP_SSL:=false}"
: "${SMTP_STARTTLS:=false}"
: "${SMTP_AUTH:=false}"
: "${SMTP_USER:=}"
: "${SMTP_PASSWORD:=}"

# Realm display name, also used by the OTP login theme's brand strings.
: "${BRAND_LONG_NAME:=Blue Dots}"

mkdir -p "$DST_DIR"

# Escape sed replacement metacharacters (& and |) in any substituted value.
escape() {
  printf '%s' "$1" | sed -e 's/[&|]/\\&/g'
}

PUBLIC_BASE_URL_ESC=$(escape "$PUBLIC_BASE_URL")
API_BASE_URL_ESC=$(escape "$API_BASE_URL")
SMTP_HOST_ESC=$(escape "$SMTP_HOST")
SMTP_PORT_ESC=$(escape "$SMTP_PORT")
SMTP_FROM_ESC=$(escape "$SMTP_FROM")
SMTP_FROM_DISPLAY_ESC=$(escape "$SMTP_FROM_DISPLAY")
SMTP_SSL_ESC=$(escape "$SMTP_SSL")
SMTP_STARTTLS_ESC=$(escape "$SMTP_STARTTLS")
SMTP_AUTH_ESC=$(escape "$SMTP_AUTH")
SMTP_USER_ESC=$(escape "$SMTP_USER")
SMTP_PASSWORD_ESC=$(escape "$SMTP_PASSWORD")
BRAND_LONG_NAME_ESC=$(escape "$BRAND_LONG_NAME")

for src in "$SRC_DIR"/*.json; do
  [ -f "$src" ] || continue
  dst="$DST_DIR/$(basename "$src")"
  sed \
    -e "s|__PUBLIC_BASE_URL__|${PUBLIC_BASE_URL_ESC}|g" \
    -e "s|__API_BASE_URL__|${API_BASE_URL_ESC}|g" \
    -e "s|__SMTP_HOST__|${SMTP_HOST_ESC}|g" \
    -e "s|__SMTP_PORT__|${SMTP_PORT_ESC}|g" \
    -e "s|__SMTP_FROM__|${SMTP_FROM_ESC}|g" \
    -e "s|__SMTP_FROM_DISPLAY__|${SMTP_FROM_DISPLAY_ESC}|g" \
    -e "s|__SMTP_SSL__|${SMTP_SSL_ESC}|g" \
    -e "s|__SMTP_STARTTLS__|${SMTP_STARTTLS_ESC}|g" \
    -e "s|__SMTP_AUTH__|${SMTP_AUTH_ESC}|g" \
    -e "s|__SMTP_USER__|${SMTP_USER_ESC}|g" \
    -e "s|__SMTP_PASSWORD__|${SMTP_PASSWORD_ESC}|g" \
    -e "s|__BRAND_LONG_NAME__|${BRAND_LONG_NAME_ESC}|g" \
    "$src" > "$dst"
  echo "rendered $(basename "$src") -> $dst (PUBLIC_BASE_URL=$PUBLIC_BASE_URL, API_BASE_URL=$API_BASE_URL, SMTP=$SMTP_HOST:$SMTP_PORT auth=$SMTP_AUTH)"
done

exec /opt/keycloak/bin/kc.sh "$@"
