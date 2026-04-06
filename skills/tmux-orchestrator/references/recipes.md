# Recipes

## Review

Use when the user wants a findings-only pass over the current branch.

- Dispatch:
  `node dist/src/cli.js dispatch "Review the current branch for regressions and missing tests"`
- Spawn:
  `node dist/src/cli.js spawn reviewer --workdir "$PWD" --role reviewer`
- Assign:
  `node dist/src/cli.js assign reviewer --goal "Review the current branch for regressions and missing tests" --instructions "Do not modify files. Write findings only." --timeout-seconds 900`

## Plan

Use when the user wants task breakdown, execution slices, or routing decisions before implementation.

- Dispatch:
  `node dist/src/cli.js dispatch "Plan how to implement the requested feature safely"`
- Spawn:
  `node dist/src/cli.js spawn planner --workdir "$PWD" --role planner`
- Assign:
  `node dist/src/cli.js assign planner --goal "Plan how to implement the requested feature safely" --instructions "Produce an implementation plan only. Do not modify files." --timeout-seconds 900`

## Investigate

Use when the user wants root-cause analysis, failure triage, or reproduction work.

- Dispatch:
  `node dist/src/cli.js dispatch "Investigate the reported bug and identify the most likely root cause"`
- Spawn:
  `node dist/src/cli.js spawn investigator --workdir "$PWD" --role investigator`
- Assign:
  `node dist/src/cli.js assign investigator --goal "Investigate the reported bug or failing behavior and identify the most likely root cause" --instructions "Do not modify files unless explicitly told. Return evidence, hypotheses, and next steps." --timeout-seconds 900`

## Implement

Use when the user wants a bounded change delegated to a separate tmux-backed agent.

- Dispatch:
  `node dist/src/cli.js dispatch "Implement the requested change"`
- Spawn:
  `node dist/src/cli.js spawn implementer --workdir "$PWD" --role implementer`
- Assign:
  `node dist/src/cli.js assign implementer --goal "Implement the requested change" --instructions "Make the smallest correct change, run focused verification, and summarize changed files and results." --timeout-seconds 1800`

## Docs

Use when the user wants README or docs updates and no code changes.

- Dispatch:
  `node dist/src/cli.js dispatch "Update the README to explain the new workflow"`

## Monitoring

At the start of any skill-driven orchestration turn:

- Auto-watch with:
  `node dist/src/cli.js events --peek`
- If a completed task is reported, immediately run:
  `node dist/src/cli.js collect <task-id>`
- If a failed or timed-out task is reported, acknowledge it after surfacing it to the user:
  `node dist/src/cli.js events ack <task-id>`

After any spawn, show the two commands printed by the CLI:

- `tmux -S "<socket>" attach -t <session>`
- `tmux -S "<socket>" capture-pane -p -J -t <target> -S -200`

After any assign:

- Check status:
  `node dist/src/cli.js ps`
- Default to background mode and continue the main conversation.
- Check for newly completed tasks with:
  `node dist/src/cli.js events --peek`
- Treat that `events --peek` call as the automatic non-blocking watch step for this skill.
- If `task.completed` is reported there, collect it immediately before moving on.
- When the user explicitly wants blocking behavior, follow with:
  `node dist/src/cli.js wait <task-id>`
  then
  `node dist/src/cli.js collect <task-id>`

## Role Config

Use `./.tmux-orchestrator/roles.json` and `./.tmux-orchestrator/routes.json` to fix routing and per-role runtime choices.

- Set `command` per role to choose the worker runtime:
  - `codex`
  - `claude-code`
- Set `agentId` when you want a separate long-lived agent for a different runtime of the same logical role.
