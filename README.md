# tmux-orchestrator

Small tmux-backed orchestration CLI for running multiple interactive coding agents on an
isolated socket.

## Install

```bash
npm install -g tmux-orchestrator
```

Or run it without a global install:

```bash
npx tmux-orchestrator@latest ps
```

Prerequisites:

- `tmux`
- an agent runtime such as `codex` or `claude-code` available on `PATH`

## Commands

```bash
tmux-orchestrator spawn reviewer --workdir ~/src/github.com/paperclipai/paperclip --role reviewer
tmux-orchestrator spawn implementer --workdir ~/src/github.com/paperclipai/paperclip --role implementer
tmux-orchestrator spawn docs --workdir "$PWD" --role docs --command "codex --profile docs"

tmux-orchestrator assign reviewer \
  --goal "Review the current branch for regressions and missing tests" \
  --instructions "Do not modify files. Write findings only." \
  --timeout-seconds 900

tmux-orchestrator dispatch "Review the current branch for regressions and missing tests"
tmux-orchestrator dispatch "Plan how to add automatic role routing for multi-stage work"
tmux-orchestrator dispatch "Update the README to explain the new dispatch command"

tmux-orchestrator ps
tmux-orchestrator events
tmux-orchestrator events --peek --json
tmux-orchestrator events ack T-001
tmux-orchestrator wait T-001
tmux-orchestrator collect T-001
```

## Model

- `spawn` can be run from a normal shell. You do not need to start inside tmux first.
- `spawn` creates a detached tmux session on a private socket, then launches `codex` in that pane by default.
- `spawn --command "<cmd>"` overrides the launched command if you want something other than the default `codex`.
- `assign` sends a fixed-format task prompt to the pane.
- `dispatch` classifies a request, chooses a configured route such as `review`, `plan`, `implement`, or `docs`, auto-spawns the target role when needed, and then assigns the task.
- `events` reports terminal task events that have not been surfaced yet, acknowledges them by default, and self-heals task state for completed or overdue tasks.
- `events --peek` reports the same events without acknowledging them, which is better for hook-driven polling.
- `events ack <task-id>` or `events ack --all` acknowledges previously peeked terminal events.
- `wait` watches for an exact completion marker in the completion file and only marks the task done once the output artifact exists.
- `collect` reads the output artifact, records that the task output was collected, and suppresses future `events` notifications for that task.

State lives under the XDG state directory by default:

- `${TMUX_ORCHESTRATOR_STATE_DIR}` when set
- otherwise `${XDG_STATE_HOME:-$HOME/.local/state}/tmux-orchestrator`

You can still force repo-local state explicitly with `--state-dir ./.tmux-orchestrator`.

- `registry.json`: source of truth for agents and tasks
- `artifacts/<task-id>/`: output file plus `.status` completion file

Dispatch config lives under `${TMUX_ORCHESTRATOR_CONFIG_DIR:-./.tmux-orchestrator}` by default:

- `roles.json`: fixed roles plus runtime/workdir defaults
- `routes.json`: task kinds to role mappings
- `dispatch.json`: optional combined file with both `roles` and `routes`

Example `roles.json`:

```json
{
  "planner": {
    "agentId": "planner-claude",
    "command": "claude-code",
    "timeoutSeconds": 900
  },
  "reviewer": {
    "command": "codex",
    "timeoutSeconds": 900
  },
  "implementer": {
    "command": "claude-code",
    "timeoutSeconds": 1800
  }
}
```

Example `routes.json`:

```json
{
  "review": { "role": "reviewer" },
  "plan": { "role": "planner" },
  "feature": { "role": "planner" },
  "implement": { "role": "implementer" },
  "docs": { "role": "docs" }
}
```

Notes:

- `dispatch` auto-classifies requests when `--kind`/`--route` is omitted.
- If you change a role's runtime command, either respawn that role or give the new runtime a different `agentId`.
- Existing agents are reused only when `agentId`, `role`, `workdir`, and `command` still match the current config.

Socket defaults:

- `TMUX_ORCHESTRATOR_SOCKET`: explicit socket path
- `TMUX_ORCHESTRATOR_SOCKET_DIR`: directory for the default socket

Default socket path:

```bash
${TMUX_ORCHESTRATOR_SOCKET_DIR:-${TMPDIR:-/tmp}/tmux-orchestrator-sockets}/orchestrator.sock
```

## Development

```bash
pnpm install
pnpm run build
pnpm run cli -- ps
pnpm test
```
