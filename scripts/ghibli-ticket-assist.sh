#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

MUSEUM_TICKET_URL="https://www.ghibli-museum.jp/ticket/"
LAWSON_ENTRY_URL="https://www.lawson.co.jp/ghibli_museum/"
SESSION="ghibli-ticket-assist"
SESSION_NAME="ghibli-ticket-assist"
PROFILE=""
USE_AUTO_CONNECT=0
HEADED=1
OPEN_TARGET="calendar"
RELEASE_AT=""
CAPTURE_ANNOTATED=0
SCREENSHOT_DIR="$ROOT_DIR/tmp/ghibli-ticket"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ghibli-ticket-assist.sh [options]

This helper waits until a release time, opens the official Ghibli Museum / Lawson
ticket flow, extracts the official purchase URLs, and lands you on the ticket entry
page when possible.

It intentionally does not automate:
  - Lawson login
  - CAPTCHA or bot checks
  - final purchase / confirmation submission

Options:
  --release-at <iso8601>   Wait until a specific timestamp before opening pages.
                           Example: 2026-04-10T10:00:00+09:00
  --open-target <mode>     Which extracted page to open: calendar, purchase, none
                           Default: calendar
  --profile <name|path>    Reuse a Chrome profile with existing Lawson login state.
  --auto-connect           Connect to a running Chrome instead of launching a new one.
  --headed                 Show a browser window. Default.
  --headless               Run without showing a browser window.
  --capture-annotated      Save an annotated screenshot after landing.
  --session <name>         agent-browser isolated session name.
  --session-name <name>    Persist cookies/storage across runs.
  --help                   Show this help.

Examples:
  ./scripts/ghibli-ticket-assist.sh \
    --release-at 2026-04-10T10:00:00+09:00 \
    --headed

  ./scripts/ghibli-ticket-assist.sh \
    --release-at 2026-04-10T10:00:00+09:00 \
    --profile Default \
    --capture-annotated
EOF
}

log() {
  printf '[ghibli-ticket-assist] %s\n' "$*"
}

die() {
  log "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --release-at)
      [[ $# -ge 2 ]] || die "Missing value for --release-at"
      RELEASE_AT="$2"
      shift 2
      ;;
    --open-target)
      [[ $# -ge 2 ]] || die "Missing value for --open-target"
      OPEN_TARGET="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || die "Missing value for --profile"
      PROFILE="$2"
      shift 2
      ;;
    --auto-connect)
      USE_AUTO_CONNECT=1
      shift
      ;;
    --headed)
      HEADED=1
      shift
      ;;
    --headless)
      HEADED=0
      shift
      ;;
    --capture-annotated)
      CAPTURE_ANNOTATED=1
      shift
      ;;
    --session)
      [[ $# -ge 2 ]] || die "Missing value for --session"
      SESSION="$2"
      shift 2
      ;;
    --session-name)
      [[ $# -ge 2 ]] || die "Missing value for --session-name"
      SESSION_NAME="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

case "$OPEN_TARGET" in
  calendar|purchase|none) ;;
  *)
    die "--open-target must be one of: calendar, purchase, none"
    ;;
esac

if ((USE_AUTO_CONNECT)) && [[ -n "$PROFILE" ]]; then
  die "Use either --auto-connect or --profile, not both."
fi

if ! command -v agent-browser >/dev/null 2>&1; then
  die "agent-browser is not installed."
fi

if ! command -v node >/dev/null 2>&1; then
  die "node is required to parse timestamps and JSON."
fi

browser() {
  local -a cmd=(agent-browser --session "$SESSION" --session-name "$SESSION_NAME")

  if ((HEADED)); then
    cmd+=(--headed)
  else
    cmd+=(--headed false)
  fi

  if ((USE_AUTO_CONNECT)); then
    cmd+=(--auto-connect)
  fi

  if [[ -n "$PROFILE" ]]; then
    cmd+=(--profile "$PROFILE")
  fi

  cmd+=("$@")
  "${cmd[@]}"
}

json_get() {
  local key="$1"
  node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8");
    const data = JSON.parse(input);
    const value = data[process.argv[1]];
    if (typeof value === "string") {
      process.stdout.write(value);
    }
  ' "$key"
}

sleep_until_release() {
  [[ -n "$RELEASE_AT" ]] || return 0

  local wait_seconds
  wait_seconds=$(
    node -e '
      const input = process.argv[1];
      const target = Date.parse(input);
      if (!Number.isFinite(target)) {
        console.error("Invalid timestamp:", input);
        process.exit(2);
      }
      const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      process.stdout.write(String(seconds));
    ' "$RELEASE_AT"
  ) || die "Could not parse --release-at value: $RELEASE_AT"

  if [[ "$wait_seconds" == "0" ]]; then
    log "Release time already reached: $RELEASE_AT"
    return 0
  fi

  log "Waiting ${wait_seconds}s until ${RELEASE_AT}"
  sleep "$wait_seconds"
}

open_official_pages() {
  log "Opening official museum ticket page"
  browser open "$MUSEUM_TICKET_URL" >/dev/null
  browser wait 2000 >/dev/null || true

  log "Opening official Lawson entry page"
  browser open "$LAWSON_ENTRY_URL" >/dev/null
  browser wait 2000 >/dev/null || true
}

extract_ticket_urls() {
  browser eval --stdin <<'EVALEOF'
(() => {
  const links = Array.from(document.querySelectorAll('a')).map((a) => ({
    text: (a.innerText || a.textContent || '').trim(),
    href: a.href,
  }));
  const normalize = (value) => (typeof value === 'string' ? value.replace(/^http:\/\//, 'https://') : null);
  const purchase = links.find((link) => /^https?:\/\/l-tike\.com\/ghibli\/?$/.test(link.href));
  const calendar = links.find((link) => /^https?:\/\/l-tike\.com\/ghibli\/calendar\/?$/.test(link.href));
  return {
    purchaseUrl: normalize(purchase?.href ?? null),
    calendarUrl: normalize(calendar?.href ?? null),
  };
})()
EVALEOF
}

try_open_target() {
  local url="$1"
  local label="$2"

  [[ -n "$url" ]] || return 1

  log "Opening ${label}: ${url}"

  if ! browser open "$url" >/dev/null 2>&1; then
    log "Direct open failed for ${label}; staying on the official Lawson page."
    return 1
  fi

  browser wait 2500 >/dev/null || true

  local current_url
  current_url=$(browser get url 2>/dev/null || true)
  if [[ "$current_url" == chrome-error://* ]]; then
    log "${label} opened to a Chrome error page; falling back to the official Lawson page."
    return 1
  fi

  return 0
}

capture_annotated() {
  ((CAPTURE_ANNOTATED)) || return 0

  mkdir -p "$SCREENSHOT_DIR"
  local shot_path="$SCREENSHOT_DIR/landing-$(date +%Y%m%d-%H%M%S).png"
  browser screenshot --annotate "$shot_path" >/dev/null
  log "Annotated screenshot: $shot_path"
}

print_summary() {
  local purchase_url="$1"
  local calendar_url="$2"
  local current_url=""

  current_url=$(browser get url 2>/dev/null || true)

  printf '\n'
  log "Official museum page: $MUSEUM_TICKET_URL"
  log "Official Lawson page: $LAWSON_ENTRY_URL"
  log "Extracted purchase URL: ${purchase_url:-"(not found)"}"
  log "Extracted calendar URL: ${calendar_url:-"(not found)"}"
  log "Current browser URL: ${current_url:-"(unknown)"}"
  log "Stopped before Lawson login / CAPTCHA / final confirmation by design."
}

main() {
  sleep_until_release
  open_official_pages

  local urls_json purchase_url calendar_url target_url
  urls_json=$(extract_ticket_urls)
  purchase_url=$(printf '%s' "$urls_json" | json_get purchaseUrl || true)
  calendar_url=$(printf '%s' "$urls_json" | json_get calendarUrl || true)

  case "$OPEN_TARGET" in
    calendar)
      target_url="$calendar_url"
      ;;
    purchase)
      target_url="$purchase_url"
      ;;
    none)
      target_url=""
      ;;
  esac

  if [[ -n "$target_url" ]] && ! try_open_target "$target_url" "$OPEN_TARGET"; then
    browser open "$LAWSON_ENTRY_URL" >/dev/null
    browser wait 1500 >/dev/null || true
  fi

  capture_annotated
  print_summary "$purchase_url" "$calendar_url"
}

main "$@"
