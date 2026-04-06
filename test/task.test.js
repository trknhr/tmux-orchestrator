import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { buildTaskPrompt, completionMarkerMatches } from '../dist/src/task.js'
import { writeRegistry } from '../dist/src/state.js'

const execFile = promisify(execFileCallback)
const repoRoot = new URL('..', import.meta.url).pathname

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function runCli(args, cwd = repoRoot) {
  const env = arguments.length > 2 ? arguments[2] : undefined
  return execFile(process.execPath, [join(repoRoot, 'dist/src/cli.js'), ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  })
}

function createShortRoot(prefix) {
  return join('/tmp', `${prefix}-${randomUUID().slice(0, 8)}`)
}

async function createFakeTmuxEnv(root, options = {}) {
  const binDir = join(root, 'bin')
  const tmuxPath = join(binDir, 'tmux')
  const logPath = join(root, 'tmux.log')
  const sessionsPath = join(root, 'tmux-sessions.txt')
  const preseedSessions = options.preseedSessions ?? ['orch-reviewer']

  await mkdir(binDir, { recursive: true })
  await writeFile(sessionsPath, preseedSessions.length > 0 ? `${preseedSessions.join('\n')}\n` : '')
  await writeFile(
    tmuxPath,
    [
      '#!/bin/sh',
      'log_file="${FAKE_TMUX_LOG:-}"',
      'sessions_file="${FAKE_TMUX_SESSIONS:-}"',
      'command="${3:-}"',
      'lookup_tmux_target() {',
      '  previous=""',
      '  for arg in "$@"; do',
      '    if [ "$previous" = "-t" ] || [ "$previous" = "-s" ]; then',
      '      printf \'%s\' "$arg"',
      '      return 0',
      '    fi',
      '    previous="$arg"',
      '  done',
      '  return 1',
      '}',
      'if [ -n "$log_file" ]; then',
      '  printf \'%s\\n\' "$*" >> "$log_file"',
      'fi',
      'if [ -n "$sessions_file" ] && [ ! -f "$sessions_file" ]; then',
      '  : > "$sessions_file"',
      'fi',
      'if [ "$command" = "has-session" ]; then',
      '  session="$(lookup_tmux_target "$@")"',
      '  if [ -n "$sessions_file" ] && grep -Fx "$session" "$sessions_file" >/dev/null 2>&1; then',
      '    exit 0',
      '  fi',
      "  echo \"can't find session: $session\" >&2",
      '  exit 1',
      'fi',
      'if [ "$command" = "new-session" ]; then',
      '  session="$(lookup_tmux_target "$@")"',
      '  if [ -n "$sessions_file" ] && ! grep -Fx "$session" "$sessions_file" >/dev/null 2>&1; then',
      '    printf \'%s\\n\' "$session" >> "$sessions_file"',
      '  fi',
      '  exit 0',
      'fi',
      'if [ "$command" = "list-panes" ]; then',
      '  if [ -n "$sessions_file" ] && [ -f "$sessions_file" ]; then',
      '    while IFS= read -r session; do',
      '      [ -n "$session" ] && printf \'%s:0.0\\tcodex\\tactive\\n\' "$session"',
      '    done < "$sessions_file"',
      '  fi',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  )
  await chmod(tmuxPath, 0o755)

  return {
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_TMUX_LOG: logPath,
      FAKE_TMUX_SESSIONS: sessionsPath,
    },
    logPath,
    sessionsPath,
  }
}

async function seedAssignedTask(root) {
  const stateDir = join(root, 'state')
  const registryPath = join(stateDir, 'registry.json')
  const outputFile = join(stateDir, 'artifacts', 'T-001', 'reviewer.md')
  const completionFile = join(stateDir, 'artifacts', 'T-001', 'reviewer.status')
  const completionMarker = 'STATUS: done'
  const prompt = buildTaskPrompt({
    taskId: 'T-001',
    role: 'reviewer',
    goal: 'Review the current branch for regressions and missing tests',
    workdir: '/tmp',
    outputFile,
    completionFile,
    completionMarker,
    instructions: 'Do not modify files. Write findings only.',
  })

  await writeRegistry(registryPath, {
    version: 1,
    agents: [
      {
        id: 'reviewer',
        sessionName: 'orch-reviewer',
        target: 'orch-reviewer:0.0',
        role: 'reviewer',
        workdir: '/tmp',
        socketPath: '/tmp/unused.sock',
        launchCommand: 'cat',
        status: 'busy',
        currentTaskId: 'T-001',
        createdAt: '2026-04-04T00:00:00.000Z',
        lastSeenAt: '2026-04-04T00:00:00.000Z',
      },
    ],
    tasks: [
      {
        id: 'T-001',
        agentId: 'reviewer',
        goal: 'Review the current branch for regressions and missing tests',
        prompt,
        outputFile,
        completionFile,
        completionMarker,
        status: 'assigned',
        timeoutSeconds: 5,
        assignedAt: '2026-04-04T00:00:00.000Z',
      },
    ],
  })

  return { stateDir, registryPath, outputFile, completionFile, completionMarker }
}

test('buildTaskPrompt preserves raw paths and completion matching is exact', () => {
  const outputFile = '/tmp/task-output.md'
  const completionFile = '/tmp/task-output.status'
  const prompt = buildTaskPrompt({
    taskId: 'T-001',
    role: 'reviewer',
    goal: 'Review the current branch for regressions and missing tests',
    workdir: '/tmp/workdir',
    outputFile,
    completionFile,
    completionMarker: 'STATUS: done',
    instructions: 'Do not modify files. Write findings only.',
  })

  assert.match(prompt, new RegExp(`OUTPUT_FILE: ${escapeRegExp(outputFile)}(?:\\n|$)`))
  assert.match(prompt, new RegExp(`COMPLETION_FILE: ${escapeRegExp(completionFile)}(?:\\n|$)`))
  assert.equal(prompt.includes(`${outputFile}.`), false)
  assert.equal(prompt.includes(`${completionFile}.`), false)
  assert.equal(completionMarkerMatches('STATUS: done\n', 'STATUS: done'), true)
  assert.equal(completionMarkerMatches('STATUS: done?', 'STATUS: done'), false)
  assert.equal(completionMarkerMatches('write STATUS: done here', 'STATUS: done'), false)
})

test('wait -> collect uses exact prompt paths and completion files', async (t) => {
  const root = createShortRoot('to-task')
  const { stateDir, registryPath, outputFile, completionFile, completionMarker } = await seedAssignedTask(root)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  const [task] = registry.tasks

  assert.equal(task.id, 'T-001')
  assert.match(task.prompt, new RegExp(`OUTPUT_FILE: ${escapeRegExp(task.outputFile)}(?:\\n|$)`))
  assert.match(task.prompt, new RegExp(`COMPLETION_FILE: ${escapeRegExp(task.completionFile)}(?:\\n|$)`))

  await mkdir(join(stateDir, 'artifacts', 'T-001'), { recursive: true })
  await writeFile(outputFile, 'review findings\n')
  await writeFile(completionFile, completionMarker)

  const waitResult = await runCli([
    'wait',
    task.id,
    '--timeout-seconds',
    '5',
    '--poll-interval-ms',
    '50',
    '--state-dir',
    stateDir,
  ])
  assert.match(waitResult.stdout, /Task "T-001" completed\./)

  const collectResult = await runCli(['collect', task.id, '--state-dir', stateDir])
  assert.match(collectResult.stdout, /Status: done/)
  assert.match(collectResult.stdout, /review findings/)

  const updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(updatedRegistry.tasks[0].status, 'done')
  assert.equal(updatedRegistry.agents[0].currentTaskId, null)
  assert.ok(updatedRegistry.tasks[0].collectedAt)
  assert.ok(updatedRegistry.tasks[0].eventAcknowledgedAt)

  const eventsResult = await runCli(['events', '--state-dir', stateDir])
  assert.match(eventsResult.stdout, /No new events\./)
})

test(
  'collect does not mark the task done when the completion marker exists but the output file is missing',
  async (t) => {
    const root = createShortRoot('to-task')
    const { stateDir, registryPath, completionFile, completionMarker } = await seedAssignedTask(root)

    t.after(async () => {
      await rm(root, { recursive: true, force: true })
    })

    await mkdir(join(stateDir, 'artifacts', 'T-001'), { recursive: true })
    await writeFile(completionFile, completionMarker)

    await assert.rejects(
      () => runCli(['collect', 'T-001', '--state-dir', stateDir]),
      /reported completion but output file is missing/,
    )

    const updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
    assert.equal(updatedRegistry.tasks[0].status, 'assigned')
  },
)

test('events reports completed tasks once and acknowledges them', async (t) => {
  const root = createShortRoot('to-task')
  const { stateDir, registryPath, outputFile, completionFile, completionMarker } = await seedAssignedTask(root)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await mkdir(join(stateDir, 'artifacts', 'T-001'), { recursive: true })
  await writeFile(outputFile, 'review findings\n')
  await writeFile(completionFile, completionMarker)

  const firstEvents = await runCli(['events', '--state-dir', stateDir])
  assert.match(firstEvents.stdout, /Events:/)
  assert.match(firstEvents.stdout, /task\.completed T-001/)
  assert.match(firstEvents.stdout, /collect: tmux-orchestrator collect T-001/)

  const secondEvents = await runCli(['events', '--state-dir', stateDir])
  assert.match(secondEvents.stdout, /No new events\./)

  const updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(updatedRegistry.tasks[0].status, 'done')
  assert.ok(updatedRegistry.tasks[0].eventAcknowledgedAt)
  assert.equal(updatedRegistry.agents[0].currentTaskId, null)
})

test('events --peek reports completed tasks without acknowledging them, and ack clears them explicitly', async (t) => {
  const root = createShortRoot('to-task')
  const { stateDir, registryPath, outputFile, completionFile, completionMarker } = await seedAssignedTask(root)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await mkdir(join(stateDir, 'artifacts', 'T-001'), { recursive: true })
  await writeFile(outputFile, 'review findings\n')
  await writeFile(completionFile, completionMarker)

  const firstPeek = await runCli(['events', '--peek', '--state-dir', stateDir])
  assert.match(firstPeek.stdout, /task\.completed T-001/)

  const secondPeek = await runCli(['events', '--peek', '--state-dir', stateDir])
  assert.match(secondPeek.stdout, /task\.completed T-001/)

  let updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(updatedRegistry.tasks[0].status, 'done')
  assert.equal(updatedRegistry.tasks[0].eventAcknowledgedAt, undefined)

  const ackResult = await runCli(['events', 'ack', 'T-001', '--state-dir', stateDir])
  assert.match(ackResult.stdout, /Acknowledged event for "T-001"\./)

  const finalPeek = await runCli(['events', '--peek', '--state-dir', stateDir])
  assert.match(finalPeek.stdout, /No new events\./)

  updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.ok(updatedRegistry.tasks[0].eventAcknowledgedAt)
})

test('events quarantines timed-out tasks so follow-up work cannot be injected into the same pane', async (t) => {
  const root = createShortRoot('to-task')
  const { stateDir, registryPath } = await seedAssignedTask(root)
  const fakeTmux = await createFakeTmuxEnv(root)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  registry.tasks[0].assignedAt = '2000-01-01T00:00:00.000Z'
  registry.tasks[0].timeoutSeconds = 1
  await writeRegistry(registryPath, registry)

  const firstEvents = await runCli(['events', '--state-dir', stateDir])
  assert.match(firstEvents.stdout, /task\.timed-out T-001/)

  const secondEvents = await runCli(['events', '--state-dir', stateDir])
  assert.match(secondEvents.stdout, /No new events\./)

  const updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(updatedRegistry.tasks[0].status, 'timed-out')
  assert.ok(updatedRegistry.tasks[0].completedAt)
  assert.ok(updatedRegistry.tasks[0].eventAcknowledgedAt)
  assert.equal(updatedRegistry.agents[0].currentTaskId, 'T-001')
  assert.equal(updatedRegistry.agents[0].status, 'quarantined')

  const psResult = await runCli(['ps', '--state-dir', stateDir], repoRoot, fakeTmux.env)
  assert.match(psResult.stdout, /status: quarantined/)
  assert.match(psResult.stdout, /current task: T-001/)

  await assert.rejects(
    () =>
      runCli(['assign', 'reviewer', '--goal', 'Review the follow-up patch', '--state-dir', stateDir], repoRoot, fakeTmux.env),
    /Agent "reviewer" is quarantined after timed-out task T-001/,
  )

  const finalRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(finalRegistry.tasks.length, 1)
  assert.equal(finalRegistry.agents[0].currentTaskId, 'T-001')
  assert.equal(finalRegistry.agents[0].status, 'quarantined')

  const tmuxLog = await readFile(fakeTmux.logPath, 'utf8')
  assert.doesNotMatch(tmuxLog, /send-keys/)
})

test('wait quarantines timed-out tasks so a still-live pane cannot accept overlapping work', async (t) => {
  const root = createShortRoot('to-task')
  const { stateDir, registryPath } = await seedAssignedTask(root)
  const fakeTmux = await createFakeTmuxEnv(root)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await assert.rejects(
    () =>
      runCli(
        ['wait', 'T-001', '--timeout-seconds', '0.1', '--poll-interval-ms', '10', '--state-dir', stateDir],
        repoRoot,
        fakeTmux.env,
      ),
    /Timed out waiting for task "T-001" after 0\.1 seconds\./,
  )

  const updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(updatedRegistry.tasks[0].status, 'timed-out')
  assert.ok(updatedRegistry.tasks[0].completedAt)
  assert.equal(updatedRegistry.agents[0].currentTaskId, 'T-001')
  assert.equal(updatedRegistry.agents[0].status, 'quarantined')

  await assert.rejects(
    () => runCli(['assign', 'reviewer', '--goal', 'Review a second patch', '--state-dir', stateDir], repoRoot, fakeTmux.env),
    /Agent "reviewer" is quarantined after timed-out task T-001/,
  )

  const tmuxLog = await readFile(fakeTmux.logPath, 'utf8')
  assert.doesNotMatch(tmuxLog, /send-keys/)
})

test('assign rejects agents with a current task even if their status says idle', async (t) => {
  const root = createShortRoot('to-task')
  const { stateDir, registryPath } = await seedAssignedTask(root)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const registry = JSON.parse(await readFile(registryPath, 'utf8'))
  registry.agents[0].status = 'idle'
  await writeRegistry(registryPath, registry)

  await assert.rejects(
    () => runCli(['assign', 'reviewer', '--goal', 'Review another patch', '--state-dir', stateDir]),
    /Agent "reviewer" is already busy with task T-001/,
  )

  const updatedRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(updatedRegistry.tasks.length, 1)
  assert.equal(updatedRegistry.agents[0].status, 'idle')
  assert.equal(updatedRegistry.agents[0].currentTaskId, 'T-001')
})

test('events ack --all acknowledges every pending terminal event', async (t) => {
  const root = createShortRoot('to-task')
  const stateDir = join(root, 'state')
  const registryPath = join(stateDir, 'registry.json')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await writeRegistry(registryPath, {
    version: 1,
    agents: [],
    tasks: [
      {
        id: 'T-001',
        agentId: 'reviewer',
        goal: 'Done task',
        prompt: 'TASK_ID: T-001',
        outputFile: '/tmp/T-001.md',
        completionFile: '/tmp/T-001.status',
        completionMarker: 'STATUS: done',
        status: 'done',
        timeoutSeconds: 5,
        assignedAt: '2026-04-04T00:00:00.000Z',
        completedAt: '2026-04-04T00:05:00.000Z',
      },
      {
        id: 'T-002',
        agentId: 'reviewer',
        goal: 'Failed task',
        prompt: 'TASK_ID: T-002',
        outputFile: '/tmp/T-002.md',
        completionFile: '/tmp/T-002.status',
        completionMarker: 'STATUS: done',
        status: 'failed',
        timeoutSeconds: 5,
        assignedAt: '2026-04-04T00:00:00.000Z',
        completedAt: '2026-04-04T00:06:00.000Z',
      },
    ],
  })

  const peekBeforeAck = await runCli(['events', '--peek', '--state-dir', stateDir])
  assert.match(peekBeforeAck.stdout, /task\.completed T-001/)
  assert.match(peekBeforeAck.stdout, /task\.failed T-002/)

  const ackResult = await runCli(['events', 'ack', '--all', '--state-dir', stateDir])
  assert.match(ackResult.stdout, /Acknowledged 2 event\(s\)\./)

  const peekAfterAck = await runCli(['events', '--peek', '--state-dir', stateDir])
  assert.match(peekAfterAck.stdout, /No new events\./)
})

test('dispatch auto-routes review requests and spawns the configured runtime for the reviewer role', async (t) => {
  const root = createShortRoot('to-dispatch')
  const stateDir = join(root, 'state')
  const configDir = join(root, '.tmux-orchestrator')
  const fakeTmux = await createFakeTmuxEnv(root, { preseedSessions: [] })

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'roles.json'),
    `${JSON.stringify(
      {
        reviewer: {
          command: 'claude-code --print',
          timeoutSeconds: 321,
        },
      },
      null,
      2,
    )}\n`,
  )

  const result = await runCli(
    ['dispatch', 'Review the current branch for regressions and missing tests', '--state-dir', stateDir],
    root,
    fakeTmux.env,
  )

  assert.match(result.stdout, /Dispatch: review -> reviewer/)
  assert.match(result.stdout, /Assigned task "T-001" to "reviewer"/)

  const registry = JSON.parse(await readFile(join(stateDir, 'registry.json'), 'utf8'))
  assert.equal(registry.agents[0].id, 'reviewer')
  assert.equal(registry.agents[0].role, 'reviewer')
  assert.equal(registry.agents[0].launchCommand, 'claude-code --print')
  assert.equal(registry.agents[0].status, 'busy')
  assert.equal(registry.agents[0].currentTaskId, 'T-001')
  assert.equal(registry.tasks[0].goal, 'Review the current branch for regressions and missing tests')
  assert.equal(registry.tasks[0].timeoutSeconds, 321)

  const tmuxLog = await readFile(fakeTmux.logPath, 'utf8')
  assert.match(tmuxLog, /claude-code --print/)
  assert.match(tmuxLog, /TASK_ID: T-001/)
})

test('dispatch auto-routes feature planning requests to the planner role', async (t) => {
  const root = createShortRoot('to-dispatch')
  const stateDir = join(root, 'state')
  const fakeTmux = await createFakeTmuxEnv(root, { preseedSessions: [] })

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const result = await runCli(
    ['dispatch', 'Plan how to add a new pipeline feature for automatic role routing', '--state-dir', stateDir],
    root,
    fakeTmux.env,
  )

  assert.match(result.stdout, /Dispatch: plan -> planner/)
  assert.match(result.stdout, /Assigned task "T-001" to "planner"/)

  const registry = JSON.parse(await readFile(join(stateDir, 'registry.json'), 'utf8'))
  assert.equal(registry.agents[0].id, 'planner')
  assert.equal(registry.agents[0].role, 'planner')
  assert.equal(registry.tasks[0].agentId, 'planner')
  assert.match(registry.tasks[0].prompt, /ROLE: planner/)
})

test('dispatch rejects an existing role agent when the configured runtime changes', async (t) => {
  const root = createShortRoot('to-dispatch')
  const stateDir = join(root, 'state')
  const registryPath = join(stateDir, 'registry.json')
  const configDir = join(root, '.tmux-orchestrator')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await writeRegistry(registryPath, {
    version: 1,
    agents: [
      {
        id: 'reviewer',
        sessionName: 'orch-reviewer',
        target: 'orch-reviewer:0.0',
        role: 'reviewer',
        workdir: root,
        socketPath: '/tmp/unused.sock',
        launchCommand: 'codex',
        status: 'idle',
        currentTaskId: null,
        createdAt: '2026-04-04T00:00:00.000Z',
        lastSeenAt: '2026-04-04T00:00:00.000Z',
      },
    ],
    tasks: [],
  })

  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'roles.json'),
    `${JSON.stringify(
      {
        reviewer: {
          command: 'claude-code',
        },
      },
      null,
      2,
    )}\n`,
  )

  await assert.rejects(
    () => runCli(['dispatch', 'Review the branch', '--state-dir', stateDir], root),
    /already exists with launch command "codex", but dispatch wants "claude-code"/,
  )
})
