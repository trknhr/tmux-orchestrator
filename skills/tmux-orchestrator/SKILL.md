---
name: tmux-orchestrator
description: Orchestrate long-running tmux-backed coding agents through the tmux-orchestrator CLI. Use when the user wants to spawn or reuse agents, assign bounded tasks, inspect tmux sessions, wait for completion, or collect artifacts for roles like reviewer, investigator, or implementer.
---

# Tmux Orchestrator

Use this skill from the repository you want to orchestrate.

## Workflow

1. Check prerequisites
- Confirm `tmux` and an agent runtime such as `codex` or `claude-code` are available.
- Confirm `tmux-orchestrator` is available on `PATH`.
- If it is missing, install it first with `npm install -g tmux-orchestrator` or `pnpm add -g tmux-orchestrator`.

2. Inspect current state first
- Start the turn by auto-watching for task completions with:
  `tmux-orchestrator events --peek`
- If `events --peek` returns `task.completed`, immediately run `tmux-orchestrator collect <task-id>`.
- If `events --peek` returns `task.failed` or `task.timed-out`, surface that to the user and then acknowledge it with `tmux-orchestrator events ack <task-id>`.
- Run `tmux-orchestrator ps`.
- Reuse an existing idle agent when possible instead of spawning duplicates.
- Do not guess task IDs, socket paths, session names, or artifact paths. Read them from CLI output or `.tmux-orchestrator/registry.json`.

3. Spawn an agent when needed
- Command template:
  `tmux-orchestrator spawn <agent-id> --workdir "$PWD" --role <role>`
- Use short stable agent IDs such as `reviewer`, `investigator`, and `implementer`.
- If tmux socket access fails in the sandbox with errors like `Operation not permitted`, rerun the command with escalation.
- After spawning, always show both monitor commands returned by the CLI:
  - `tmux ... attach -t <session>`
  - `tmux ... capture-pane -p -J -t <target> -S -200`

4. Assign a bounded task
- Command template:
  `tmux-orchestrator assign <agent-id> --goal "<goal>" --instructions "<instructions>" --timeout-seconds <seconds>`
- Keep the task single-purpose and artifact-oriented.
- If the agent is already `busy`, do not interrupt or reassign unless the user explicitly asks.
- After assign, run `tmux-orchestrator ps` to confirm the task ID and runtime state.

5. Prefer dispatch for role-based routing
- When the user gives a natural-language request and wants the skill to choose the worker role, use:
  `tmux-orchestrator dispatch "<request>"`
- `dispatch` routes requests to fixed roles like `planner`, `reviewer`, `investigator`, `implementer`, and `docs`.
- It auto-spawns the configured agent when missing, then assigns the task.
- Override routing when needed with:
  `tmux-orchestrator dispatch "<request>" --kind <kind>`
  or
  `tmux-orchestrator dispatch "<request>" --route <route>`
- The default config directory is `./.tmux-orchestrator`. Use `roles.json` and `routes.json` there to lock a role to a runtime such as `codex` or `claude-code`.
- If a role's configured runtime changes, either respawn that role or give the new runtime a different `agentId`.

6. Default to background execution
- After assign, let the task run in the background unless the user explicitly asks to block on it.
- Keep the main conversation moving instead of waiting in the foreground.
- Surface monitor commands so the user can inspect the pane directly at any time.

7. Check for completion with events
- Treat `events` as the skill's automatic watch loop.
- Run `tmux-orchestrator events --peek` at the start of each turn that uses this skill, and again after background assignments when helpful.
- Use plain `events` when you intentionally want "read and acknowledge" in one step.
- `events --peek` is the default non-blocking completion check for hook-friendly workflows.
- When `events --peek` reports `task.completed`, immediately collect it in the same turn before doing other orchestration work.
- When `events --peek` reports `task.failed` or `task.timed-out`, acknowledge it after surfacing it to the user.

8. Use follow only when the user asks to block
- In this skill, `follow` means:
  - `tmux-orchestrator wait <task-id>`
  - `tmux-orchestrator collect <task-id>`
- If `wait` times out or fails, stop there and report the status instead of forcing `collect`.

9. Watch while the task is running
- To watch interactively, give:
  `tmux -S "<socket>" attach -t <session>`
- To inspect the pane without attaching, give:
  `tmux -S "<socket>" capture-pane -p -J -t <target> -S -200`

## Default Recipes

- `reviewer`: Review the current branch for regressions and missing tests. Write findings only.
- `planner`: Produce an implementation plan or execution slices without editing code.
- `investigator`: Reproduce or analyze a bug, then return causes, evidence, and next steps.
- `implementer`: Make a bounded code change, run focused verification, and summarize what changed.

For concrete command examples and prompt wording, read [references/recipes.md](references/recipes.md).

## Notes

- This CLI works best for longer-running, low-interruption tasks that end with one artifact.
- Prefer one stable agent per role so the user can keep monitoring the same tmux target.
- Prefer `dispatch` over manual role selection when the request shape already implies a role.
- Default to background execution plus periodic `events` checks, not blocking `follow`.
- In this skill, "automatic watch" means automatic `events --peek` polling during skill-driven turns, not an out-of-band push notification.
- In this skill, completed tasks are auto-collected as soon as they are detected.
- Use `follow` only when the user explicitly wants to wait in the current turn.
- Do not use the reviewer recipe for code edits unless the user explicitly changes that constraint.
