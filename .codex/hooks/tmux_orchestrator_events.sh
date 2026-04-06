#!/bin/zsh
set -eu

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || exit 0)"
CLI="$ROOT/dist/src/cli.js"

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

if [[ ! -f "$CLI" ]]; then
  exit 0
fi

cmd=(node "$CLI" events --peek)

if [[ -d "$ROOT/.tmux-orchestrator" ]]; then
  cmd+=(--state-dir "$ROOT/.tmux-orchestrator")
fi

output="$("${cmd[@]}" 2>/dev/null || true)"

if [[ -z "$output" || "$output" == "No new events." ]]; then
  exit 0
fi

printf '%s\n' "$output"
