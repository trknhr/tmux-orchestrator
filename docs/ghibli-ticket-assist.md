# Ghibli Ticket Assist

This helper uses `agent-browser` to get you to the official Ghibli Museum / Lawson
ticket flow quickly at sale time, while leaving the final protected steps to you.

## What It Does

- waits until a configured release timestamp
- opens the official museum ticket page and the official Lawson entry page
- extracts the official `l-tike.com` purchase/calendar URLs from the Lawson page
- tries to land you on the calendar or purchase entry page
- can reuse a Chrome profile or a persistent `agent-browser` session

## What It Does Not Do

- no Lawson credential automation
- no CAPTCHA / queue / anti-bot bypass
- no final purchase confirmation

That boundary is intentional. The script is a reservation assist, not an unattended
purchase bot.

## Verified Official Flow

The official pages checked on April 5, 2026 were:

- `https://www.ghibli-museum.jp/ticket/`
- `https://www.lawson.co.jp/ghibli_museum/`

At that time, the official museum page said:

- tickets go on sale on the 10th of each month at 10:00 JST for the following month
- reservations are handled on the Lawson Web site

The Lawson page said:

- purchase requires a Lawson Web membership
- mobile phone number verification is required

Because these pages can change, treat the script as a helper for the current official
flow, not a permanent guarantee.

## Usage

```bash
./scripts/ghibli-ticket-assist.sh \
  --release-at 2026-04-10T10:00:00+09:00 \
  --headed
```

Reuse an existing Chrome profile:

```bash
./scripts/ghibli-ticket-assist.sh \
  --release-at 2026-04-10T10:00:00+09:00 \
  --profile Default \
  --capture-annotated
```

Stay on the official Lawson page without trying to open `l-tike.com` directly:

```bash
./scripts/ghibli-ticket-assist.sh --open-target none
```

## Notes

- In this workspace on April 5, 2026, `l-tike.com` direct navigation sometimes failed
  with browser/network protocol errors. The script falls back to the official Lawson
  page when that happens.
- If you already have a working browser session, try `--profile Default` or
  `--auto-connect` so the helper can reuse your normal browser state.
