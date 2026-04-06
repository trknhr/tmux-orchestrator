#!/usr/bin/env node

import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { classifyDispatchRoute, getConfigPaths, loadDispatchConfig } from './config.js'
import {
  acquireRegistryLock,
  createNextTaskId,
  getDefaultTmuxSocketPath,
  getStatePaths,
  loadRegistry,
  normalizeAgentId,
  writeRegistry,
} from './state.js'
import { buildTaskPrompt, compactText, completionMarkerMatches, taskHasTimedOut } from './task.js'
import { tmuxCreateSession, tmuxListPanes, tmuxSendPrompt, tmuxSessionExists } from './tmux.js'
import type { AgentRecord, AgentStatus, OrchestratorRegistry, TaskRecord, TaskStatus } from './types.js'

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | boolean>
}

interface TaskEvent {
  type: 'task.completed' | 'task.failed' | 'task.timed-out'
  taskId: string
  agentId: string
  status: Exclude<TaskStatus, 'assigned'>
  goal: string
  outputFile: string
  occurredAt: string
  collectCommand?: string
}

function printUsage(): void {
  console.log(`tmux-orchestrator

Usage:
  tmux-orchestrator spawn <agent-id> [--workdir <path>] [--role <role>] [--command <command>] [--session <name>] [--socket <path>]
  tmux-orchestrator assign <agent-id> --goal <text> [--task-id <id>] [--output-file <path>] [--done-marker <marker>] [--instructions <text>] [--instructions-file <path>] [--timeout-seconds <n>]
  tmux-orchestrator dispatch <request...> [--kind <kind>] [--route <name>] [--config-dir <path>] [--command <command>] [--workdir <path>] [--instructions <text>] [--instructions-file <path>] [--timeout-seconds <n>]
  tmux-orchestrator ps
  tmux-orchestrator events [--json] [--peek]
  tmux-orchestrator events ack <task-id>
  tmux-orchestrator events ack --all
  tmux-orchestrator wait <task-id> [--timeout-seconds <n>] [--poll-interval-ms <n>]
  tmux-orchestrator collect <task-id>
`)
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | boolean>()

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') continue
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const key = token.slice(2)
    const next = argv[index + 1]

    if (!next || next.startsWith('--')) {
      flags.set(key, true)
      continue
    }

    flags.set(key, next)
    index += 1
  }

  return { positionals, flags }
}

function getFlagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function getFlagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

function getFlagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = getFlagString(args, name)
  if (!value) return undefined

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Flag --${name} must be a number.`)
  }

  return parsed
}

async function ensureDirectoryExists(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new Error(`${label} must be an existing directory: ${path}`)
  }
}

function findAgentOrThrow(registry: OrchestratorRegistry, agentId: string): AgentRecord {
  const agent = registry.agents.find((candidate) => candidate.id === agentId)
  if (!agent) throw new Error(`Unknown agent: ${agentId}`)
  return agent
}

function findTaskOrThrow(registry: OrchestratorRegistry, taskId: string): TaskRecord {
  const task = registry.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new Error(`Unknown task: ${taskId}`)
  return task
}

function buildAttachCommand(agent: AgentRecord): string {
  return `tmux -S "${agent.socketPath}" attach -t ${agent.sessionName}`
}

function buildCaptureCommand(agent: AgentRecord): string {
  return `tmux -S "${agent.socketPath}" capture-pane -p -J -t ${agent.target} -S -200`
}

function buildCollectCommand(taskId: string): string {
  return `tmux-orchestrator collect ${taskId}`
}

function buildNestedArgs(
  positionals: string[],
  flags: Record<string, string | boolean | undefined>,
): ParsedArgs {
  return {
    positionals,
    flags: new Map(
      Object.entries(flags).filter(([, value]) => value !== undefined) as Array<[string, string | boolean]>,
    ),
  }
}

async function loadInstructions(args: ParsedArgs): Promise<string | undefined> {
  const inlineInstructions = getFlagString(args, 'instructions')
  const instructionsFile = getFlagString(args, 'instructions-file')

  const fileInstructions = instructionsFile ? await readFile(resolve(instructionsFile), 'utf8') : undefined
  const combined = [inlineInstructions, fileInstructions].filter(Boolean).join('\n')
  return combined ? compactText(combined) : undefined
}

async function loadState(args: ParsedArgs): Promise<{
  paths: ReturnType<typeof getStatePaths>
  registry: OrchestratorRegistry
}> {
  const paths = getStatePaths(getFlagString(args, 'state-dir'))
  const registry = await loadRegistry(paths.registryPath)
  return { paths, registry }
}

async function readCompletionText(task: TaskRecord): Promise<string> {
  return readFile(task.completionFile, 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return ''
    }
    throw error
  })
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return false
      }
      throw error
    })
}

function taskStatusToEventType(status: Exclude<TaskStatus, 'assigned'>): TaskEvent['type'] {
  if (status === 'done') return 'task.completed'
  if (status === 'failed') return 'task.failed'
  return 'task.timed-out'
}

function buildTaskEvent(task: TaskRecord): TaskEvent {
  const status = task.status as Exclude<TaskStatus, 'assigned'>
  return {
    type: taskStatusToEventType(status),
    taskId: task.id,
    agentId: task.agentId,
    status,
    goal: task.goal,
    outputFile: task.outputFile,
    occurredAt: task.completedAt ?? task.assignedAt,
    collectCommand: status === 'done' && !task.collectedAt ? buildCollectCommand(task.id) : undefined,
  }
}

function releaseAgentFromTask(agent: AgentRecord | undefined, taskId: string, now: string): void {
  if (!agent || agent.currentTaskId !== taskId) return

  agent.currentTaskId = null
  agent.status = 'idle'
  agent.lastSeenAt = now
}

function quarantineAgentForTimedOutTask(agent: AgentRecord | undefined, taskId: string, now: string): void {
  if (!agent || agent.currentTaskId !== taskId) return

  agent.status = 'quarantined'
  agent.lastSeenAt = now
}

async function refreshTaskStates(registry: OrchestratorRegistry): Promise<boolean> {
  const now = new Date().toISOString()
  const nowMs = Date.now()
  let changed = false

  for (const task of registry.tasks) {
    if (task.status !== 'assigned') continue

    const agent = registry.agents.find((candidate) => candidate.id === task.agentId)
    const completionText = await readCompletionText(task)

    if (completionMarkerMatches(completionText, task.completionMarker) && (await fileExists(task.outputFile))) {
      task.status = 'done'
      task.completedAt = now
      changed = true

      releaseAgentFromTask(agent, task.id, now)
      continue
    }

    if (taskHasTimedOut(task, nowMs)) {
      task.status = 'timed-out'
      task.completedAt = now
      quarantineAgentForTimedOutTask(agent, task.id, now)
      changed = true
      continue
    }

    if (!agent) continue

    const sessionExists = await tmuxSessionExists(agent.socketPath, agent.sessionName)
    if (!sessionExists) {
      task.status = 'failed'
      task.completedAt = now
      agent.status = 'missing'
      changed = true
    }
  }

  return changed
}

function getPendingEvents(registry: OrchestratorRegistry): TaskRecord[] {
  return registry.tasks.filter((task) => task.status !== 'assigned' && !task.eventAcknowledgedAt && !task.collectedAt)
}

async function spawnAgent(args: ParsedArgs): Promise<void> {
  const rawAgentId = args.positionals[1]
  if (!rawAgentId) throw new Error('Missing required agent id for spawn.')

  const paths = getStatePaths(getFlagString(args, 'state-dir'))
  const agentId = normalizeAgentId(rawAgentId)
  const workdir = resolve(getFlagString(args, 'workdir') ?? '.')
  const role = getFlagString(args, 'role') ?? 'worker'
  const sessionName = normalizeAgentId(getFlagString(args, 'session') ?? `orch-${agentId}`)
  const socketPath = resolve(getFlagString(args, 'socket') ?? getDefaultTmuxSocketPath())
  const launchCommand = getFlagString(args, 'command') ?? 'codex'
  let agent: AgentRecord | undefined

  await ensureDirectoryExists(workdir, 'Agent workdir')

  const release = await acquireRegistryLock(paths.registryPath)
  try {
    const registry = await loadRegistry(paths.registryPath)

    if (registry.agents.some((candidate) => candidate.id === agentId)) {
      throw new Error(`Agent "${agentId}" already exists in the registry.`)
    }

    const sessionExists = await tmuxSessionExists(socketPath, sessionName)
    if (sessionExists) {
      throw new Error(`tmux session "${sessionName}" already exists on socket ${socketPath}`)
    }

    await tmuxCreateSession({
      socketPath,
      sessionName,
      workdir,
      launchCommand,
    })

    const now = new Date().toISOString()
    agent = {
      id: agentId,
      sessionName,
      target: `${sessionName}:0.0`,
      role,
      workdir,
      socketPath,
      launchCommand,
      status: 'idle',
      currentTaskId: null,
      createdAt: now,
      lastSeenAt: now,
    }

    registry.agents.push(agent)
    await writeRegistry(paths.registryPath, registry)
  } finally {
    await release()
  }

  if (!agent) {
    throw new Error('Failed to create agent.')
  }

  console.log(`Spawned agent "${agent.id}"`)
  console.log(`- role: ${agent.role}`)
  console.log(`- workdir: ${agent.workdir}`)
  console.log(`- session: ${agent.sessionName}`)
  console.log(`- socket: ${agent.socketPath}`)
  console.log(`- launch command: ${agent.launchCommand}`)
  console.log('')
  console.log('To monitor this session yourself:')
  console.log(`  ${buildAttachCommand(agent)}`)
  console.log('')
  console.log('Or to capture the output once:')
  console.log(`  ${buildCaptureCommand(agent)}`)
}

async function assignTask(args: ParsedArgs): Promise<void> {
  const rawAgentId = args.positionals[1]
  const goal = getFlagString(args, 'goal')

  if (!rawAgentId) throw new Error('Missing required agent id for assign.')
  if (!goal) throw new Error('Missing required --goal for assign.')

  const paths = getStatePaths(getFlagString(args, 'state-dir'))
  const agentId = normalizeAgentId(rawAgentId)
  const completionMarker = getFlagString(args, 'done-marker') ?? 'STATUS: done'
  const timeoutSeconds = getFlagNumber(args, 'timeout-seconds') ?? 600
  const instructions = await loadInstructions(args)
  let assignedAgent: AgentRecord | undefined
  let task: TaskRecord | undefined

  const release = await acquireRegistryLock(paths.registryPath)
  try {
    const registry = await loadRegistry(paths.registryPath)
    const agent = findAgentOrThrow(registry, agentId)

    if (agent.status === 'quarantined') {
      throw new Error(
        `Agent "${agent.id}" is quarantined after timed-out task ${agent.currentTaskId ?? '(unknown)'}. Interrupt or replace the tmux worker before assigning more work.`,
      )
    }

    if (agent.currentTaskId) {
      throw new Error(`Agent "${agent.id}" is already busy with task ${agent.currentTaskId}`)
    }

    const sessionExists = await tmuxSessionExists(agent.socketPath, agent.sessionName)
    if (!sessionExists) {
      agent.status = 'missing'
      await writeRegistry(paths.registryPath, registry)
      throw new Error(`Agent "${agent.id}" is missing. Session ${agent.sessionName} is not available.`)
    }

    const taskId = getFlagString(args, 'task-id') ?? createNextTaskId(registry)
    if (registry.tasks.some((candidate) => candidate.id === taskId)) {
      throw new Error(`Task "${taskId}" already exists in the registry.`)
    }

    const outputFile = resolve(getFlagString(args, 'output-file') ?? `${paths.artifactsDir}/${taskId}/${agent.id}.md`)
    const completionFile = resolve(`${paths.artifactsDir}/${taskId}/${agent.id}.status`)

    await mkdir(dirname(outputFile), { recursive: true })
    await mkdir(dirname(completionFile), { recursive: true })

    const prompt = buildTaskPrompt({
      taskId,
      role: agent.role,
      goal,
      workdir: agent.workdir,
      outputFile,
      completionFile,
      completionMarker,
      instructions,
    })

    await tmuxSendPrompt(agent.socketPath, agent.target, prompt)

    const now = new Date().toISOString()
    task = {
      id: taskId,
      agentId: agent.id,
      goal,
      prompt,
      outputFile,
      completionFile,
      completionMarker,
      status: 'assigned',
      timeoutSeconds,
      assignedAt: now,
    }

    registry.tasks.push(task)
    agent.status = 'busy'
    agent.currentTaskId = task.id
    agent.lastSeenAt = now
    assignedAgent = { ...agent }
    await writeRegistry(paths.registryPath, registry)
  } finally {
    await release()
  }

  if (!task || !assignedAgent) {
    throw new Error('Failed to assign task.')
  }

  console.log(`Assigned task "${task.id}" to "${assignedAgent.id}"`)
  console.log(`- goal: ${task.goal}`)
  console.log(`- output: ${task.outputFile}`)
  console.log(`- completion file: ${task.completionFile}`)
  console.log(`- completion marker: ${task.completionMarker}`)
  console.log(`- wait command: tmux-orchestrator wait ${task.id}`)
  console.log(`- capture: ${buildCaptureCommand(assignedAgent)}`)
}

async function dispatchTask(args: ParsedArgs): Promise<void> {
  const request = (getFlagString(args, 'goal') ?? args.positionals.slice(1).join(' ')).trim()
  if (!request) {
    throw new Error('Missing request text for dispatch.')
  }

  const configDir = getFlagString(args, 'config-dir')
  const configPaths = getConfigPaths(configDir)
  const config = await loadDispatchConfig(configDir)
  const routeName = getFlagString(args, 'route') ?? getFlagString(args, 'kind') ?? classifyDispatchRoute(request)
  const route = config.routes[routeName]

  if (!route) {
    throw new Error(`Unknown dispatch route "${routeName}". Known routes: ${Object.keys(config.routes).sort().join(', ')}`)
  }

  const roleTemplate = config.roles[route.role]
  if (!roleTemplate) {
    throw new Error(`Route "${routeName}" references unknown role "${route.role}".`)
  }

  const agentId = normalizeAgentId(roleTemplate.agentId ?? route.role)
  const desiredRole = roleTemplate.role ?? route.role
  const desiredCommand = getFlagString(args, 'command') ?? roleTemplate.command ?? 'codex'
  const desiredWorkdir = resolve(getFlagString(args, 'workdir') ?? roleTemplate.workdir ?? '.')
  const desiredTimeout = getFlagNumber(args, 'timeout-seconds') ?? route.timeoutSeconds ?? roleTemplate.timeoutSeconds ?? 600
  const userInstructions = await loadInstructions(args)
  const desiredInstructions =
    [roleTemplate.instructions, route.instructions, userInstructions].filter(Boolean).join('\n') || undefined
  const stateArgs = buildNestedArgs([], { 'state-dir': getFlagString(args, 'state-dir') })
  const { registry } = await loadState(stateArgs)
  const existingAgent = registry.agents.find((candidate) => candidate.id === agentId)

  console.log(`Dispatch: ${routeName} -> ${agentId}`)
  console.log(`- config dir: ${configPaths.configDir}`)
  console.log(`- role: ${desiredRole}`)
  console.log(`- command: ${desiredCommand}`)
  console.log(`- workdir: ${desiredWorkdir}`)

  if (!existingAgent) {
    await spawnAgent(
      buildNestedArgs(['spawn', agentId], {
        'state-dir': getFlagString(args, 'state-dir'),
        workdir: desiredWorkdir,
        role: desiredRole,
        command: desiredCommand,
      }),
    )
  } else {
    if (existingAgent.launchCommand !== desiredCommand) {
      throw new Error(
        `Agent "${agentId}" already exists with launch command "${existingAgent.launchCommand}", but dispatch wants "${desiredCommand}". Change the role's agentId or respawn that role.`,
      )
    }

    if (existingAgent.workdir !== desiredWorkdir) {
      throw new Error(
        `Agent "${agentId}" already exists with workdir "${existingAgent.workdir}", but dispatch wants "${desiredWorkdir}". Change the role's agentId or respawn that role.`,
      )
    }

    if (existingAgent.role !== desiredRole) {
      throw new Error(
        `Agent "${agentId}" already exists with role "${existingAgent.role}", but dispatch wants "${desiredRole}". Change the role's agentId or respawn that role.`,
      )
    }
  }

  await assignTask(
    buildNestedArgs(['assign', agentId], {
      'state-dir': getFlagString(args, 'state-dir'),
      goal: request,
      'task-id': getFlagString(args, 'task-id'),
      'output-file': getFlagString(args, 'output-file'),
      'done-marker': getFlagString(args, 'done-marker'),
      instructions: desiredInstructions,
      'timeout-seconds': String(desiredTimeout),
    }),
  )
}

async function listState(args: ParsedArgs): Promise<void> {
  const paths = getStatePaths(getFlagString(args, 'state-dir'))
  const registry = await loadRegistry(paths.registryPath)
  const panesBySocket = new Map<string, Map<string, { currentCommand: string; title: string }>>()
  const statusUpdates: Array<{ id: string; status: AgentStatus }> = []

  for (const socketPath of new Set(registry.agents.map((agent) => agent.socketPath))) {
    const panes = await tmuxListPanes(socketPath)
    panesBySocket.set(
      socketPath,
      new Map(panes.map((pane) => [pane.target, { currentCommand: pane.currentCommand, title: pane.title }])),
    )
  }

  console.log(`Registry: ${paths.registryPath}`)
  console.log('')
  console.log('Agents:')

  if (registry.agents.length === 0) {
    console.log('- none')
  }

  for (const agent of registry.agents) {
    const pane = panesBySocket.get(agent.socketPath)?.get(agent.target)
    const runtimeStatus = !pane ? 'missing' : agent.status === 'quarantined' ? 'quarantined' : agent.currentTaskId ? 'busy' : 'idle'

    if (agent.status !== runtimeStatus) {
      statusUpdates.push({ id: agent.id, status: runtimeStatus })
    }

    console.log(`- ${agent.id}`)
    console.log(`  role: ${agent.role}`)
    console.log(`  status: ${runtimeStatus}`)
    console.log(`  session: ${agent.sessionName}`)
    console.log(`  target: ${agent.target}`)
    console.log(`  socket: ${agent.socketPath}`)
    console.log(`  workdir: ${agent.workdir}`)
    console.log(`  current task: ${agent.currentTaskId ?? 'none'}`)
    if (pane) {
      console.log(`  pane command: ${pane.currentCommand}`)
      console.log(`  pane title: ${pane.title || '(none)'}`)
    }
  }

  console.log('')
  console.log('Tasks:')

  if (registry.tasks.length === 0) {
    console.log('- none')
  }

  for (const task of registry.tasks) {
    console.log(`- ${task.id}`)
    console.log(`  agent: ${task.agentId}`)
    console.log(`  status: ${task.status}`)
    console.log(`  goal: ${task.goal}`)
    console.log(`  output: ${task.outputFile}`)
  }

  if (statusUpdates.length > 0) {
    const release = await acquireRegistryLock(paths.registryPath)
    try {
      const freshRegistry = await loadRegistry(paths.registryPath)
      let changed = false

      for (const update of statusUpdates) {
        const agent = freshRegistry.agents.find((candidate) => candidate.id === update.id)
        if (!agent || agent.status === update.status) continue
        agent.status = update.status
        changed = true
      }

      if (changed) {
        await writeRegistry(paths.registryPath, freshRegistry)
      }
    } finally {
      await release()
    }
  }
}

async function renderEvents(events: TaskEvent[], asJson: boolean): Promise<void> {
  if (asJson) {
    console.log(JSON.stringify(events, null, 2))
    return
  }

  if (events.length === 0) {
    console.log('No new events.')
    return
  }

  console.log('Events:')
  for (const event of events) {
    console.log(`- ${event.type} ${event.taskId}`)
    console.log(`  agent: ${event.agentId}`)
    console.log(`  goal: ${event.goal}`)
    console.log(`  output: ${event.outputFile}`)
    console.log(`  occurred at: ${event.occurredAt}`)
    if (event.collectCommand) {
      console.log(`  collect: ${event.collectCommand}`)
    }
  }
}

async function listEvents(args: ParsedArgs): Promise<void> {
  const paths = getStatePaths(getFlagString(args, 'state-dir'))
  const asJson = getFlagBoolean(args, 'json')
  const peek = getFlagBoolean(args, 'peek')
  const release = await acquireRegistryLock(paths.registryPath)
  const events: TaskEvent[] = []

  try {
    const registry = await loadRegistry(paths.registryPath)
    const changed = await refreshTaskStates(registry)

    for (const task of getPendingEvents(registry)) {
      events.push(buildTaskEvent(task))
    }

    if (!peek) {
      const acknowledgedAt = new Date().toISOString()
      for (const task of getPendingEvents(registry)) {
        task.eventAcknowledgedAt = acknowledgedAt
      }
    }

    if (changed || (!peek && events.length > 0)) {
      await writeRegistry(paths.registryPath, registry)
    }
  } finally {
    await release()
  }

  await renderEvents(events, asJson)
}

async function acknowledgeEvents(args: ParsedArgs): Promise<void> {
  const paths = getStatePaths(getFlagString(args, 'state-dir'))
  const taskId = args.positionals[2]
  const acknowledgeAll = getFlagBoolean(args, 'all')

  if (!acknowledgeAll && !taskId) {
    throw new Error('Missing required task id for events ack.')
  }

  const release = await acquireRegistryLock(paths.registryPath)
  try {
    const registry = await loadRegistry(paths.registryPath)
    const changedByRefresh = await refreshTaskStates(registry)
    const pendingEvents = getPendingEvents(registry)
    const tasksToAcknowledge = acknowledgeAll
      ? pendingEvents
      : pendingEvents.filter((task) => task.id === taskId)

    if (!acknowledgeAll && tasksToAcknowledge.length === 0) {
      const knownTask = registry.tasks.find((task) => task.id === taskId)
      if (!knownTask) {
        throw new Error(`Unknown task: ${taskId}`)
      }
      if (knownTask.status === 'assigned') {
        throw new Error(`Task "${taskId}" has no terminal event to acknowledge yet.`)
      }

      console.log(`Task "${taskId}" is already acknowledged.`)
      if (changedByRefresh) {
        await writeRegistry(paths.registryPath, registry)
      }
      return
    }

    const acknowledgedAt = new Date().toISOString()
    for (const task of tasksToAcknowledge) {
      task.eventAcknowledgedAt = acknowledgedAt
    }

    if (changedByRefresh || tasksToAcknowledge.length > 0) {
      await writeRegistry(paths.registryPath, registry)
    }

    if (acknowledgeAll) {
      console.log(`Acknowledged ${tasksToAcknowledge.length} event(s).`)
      return
    }

    console.log(`Acknowledged event for "${taskId}".`)
  } finally {
    await release()
  }
}

async function waitForTask(args: ParsedArgs): Promise<void> {
  const taskId = args.positionals[1]
  if (!taskId) throw new Error('Missing required task id for wait.')

  const { paths, registry } = await loadState(args)
  const task = findTaskOrThrow(registry, taskId)
  const agent = findAgentOrThrow(registry, task.agentId)

  if (task.status === 'done') {
    console.log(`Task "${task.id}" is already done.`)
    console.log(`- output: ${task.outputFile}`)
    return
  }

  const timeoutSeconds = getFlagNumber(args, 'timeout-seconds') ?? task.timeoutSeconds
  const pollIntervalMs = getFlagNumber(args, 'poll-interval-ms') ?? 1000
  const deadline = Date.now() + timeoutSeconds * 1000

  while (Date.now() <= deadline) {
    const completionText = await readCompletionText(task)

    if (completionMarkerMatches(completionText, task.completionMarker) && (await fileExists(task.outputFile))) {
      const now = new Date().toISOString()
      const release = await acquireRegistryLock(paths.registryPath)
      try {
        const freshRegistry = await loadRegistry(paths.registryPath)
        const freshTask = findTaskOrThrow(freshRegistry, task.id)
        const freshAgent = findAgentOrThrow(freshRegistry, freshTask.agentId)

        freshTask.status = 'done'
        freshTask.completedAt = now
        releaseAgentFromTask(freshAgent, freshTask.id, now)
        await writeRegistry(paths.registryPath, freshRegistry)
      } finally {
        await release()
      }

      console.log(`Task "${task.id}" completed.`)
      console.log(`- output: ${task.outputFile}`)
      console.log(`- collect: tmux-orchestrator collect ${task.id}`)
      return
    }

    const sessionExists = await tmuxSessionExists(agent.socketPath, agent.sessionName)
    if (!sessionExists) {
      const now = new Date().toISOString()
      const release = await acquireRegistryLock(paths.registryPath)
      try {
        const freshRegistry = await loadRegistry(paths.registryPath)
        const freshTask = findTaskOrThrow(freshRegistry, task.id)
        const freshAgent = findAgentOrThrow(freshRegistry, freshTask.agentId)

        freshTask.status = 'failed'
        freshTask.completedAt = now
        freshAgent.status = 'missing'
        await writeRegistry(paths.registryPath, freshRegistry)
      } finally {
        await release()
      }
      throw new Error(`Agent "${agent.id}" disappeared before task "${task.id}" completed.`)
    }

    await sleep(pollIntervalMs)
  }

  const release = await acquireRegistryLock(paths.registryPath)
  try {
    const now = new Date().toISOString()
    const freshRegistry = await loadRegistry(paths.registryPath)
    const freshTask = findTaskOrThrow(freshRegistry, task.id)
    const freshAgent = findAgentOrThrow(freshRegistry, freshTask.agentId)

    freshTask.status = 'timed-out'
    freshTask.completedAt = now
    quarantineAgentForTimedOutTask(freshAgent, freshTask.id, now)
    await writeRegistry(paths.registryPath, freshRegistry)
  } finally {
    await release()
  }
  throw new Error(`Timed out waiting for task "${task.id}" after ${timeoutSeconds} seconds.`)
}

async function collectTaskOutput(args: ParsedArgs): Promise<void> {
  const taskId = args.positionals[1]
  if (!taskId) throw new Error('Missing required task id for collect.')

  const { paths, registry } = await loadState(args)
  const task = findTaskOrThrow(registry, taskId)
  const agent = findAgentOrThrow(registry, task.agentId)
  const completionText = await readCompletionText(task)
  const isCompleted = completionMarkerMatches(completionText, task.completionMarker)
  const content = await readFile(task.outputFile, 'utf8').catch((error: unknown) => {
    if (isCompleted && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Task "${task.id}" reported completion but output file is missing: ${task.outputFile}`)
    }
    throw error
  })

  if (isCompleted && task.status !== 'done') {
    const now = new Date().toISOString()
    const release = await acquireRegistryLock(paths.registryPath)
    try {
      const freshRegistry = await loadRegistry(paths.registryPath)
      const freshTask = findTaskOrThrow(freshRegistry, task.id)
      const freshAgent = findAgentOrThrow(freshRegistry, task.agentId)

      freshTask.status = 'done'
      freshTask.completedAt = now
      freshTask.eventAcknowledgedAt ??= now
      freshTask.collectedAt = now
      releaseAgentFromTask(freshAgent, freshTask.id, now)
      await writeRegistry(paths.registryPath, freshRegistry)
      task.status = 'done'
      task.collectedAt = now
    } finally {
      await release()
    }
  } else if (task.status === 'done') {
    const now = new Date().toISOString()
    const release = await acquireRegistryLock(paths.registryPath)
    try {
      const freshRegistry = await loadRegistry(paths.registryPath)
      const freshTask = findTaskOrThrow(freshRegistry, task.id)
      if (!freshTask.collectedAt || !freshTask.eventAcknowledgedAt) {
        freshTask.collectedAt = now
        freshTask.eventAcknowledgedAt ??= now
        await writeRegistry(paths.registryPath, freshRegistry)
      }
      task.collectedAt = now
    } finally {
      await release()
    }
  }

  console.log(`Task: ${task.id}`)
  console.log(`Agent: ${task.agentId}`)
  console.log(`Status: ${task.status}`)
  console.log(`Output: ${task.outputFile}`)
  console.log('')
  console.log(content.trimEnd())
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.positionals.length === 0 || getFlagBoolean(args, 'help')) {
    printUsage()
    return
  }

  const [command] = args.positionals

  if (command === 'spawn') {
    await spawnAgent(args)
    return
  }

  if (command === 'assign') {
    await assignTask(args)
    return
  }

  if (command === 'dispatch') {
    await dispatchTask(args)
    return
  }

  if (command === 'ps') {
    await listState(args)
    return
  }

  if (command === 'events') {
    const subcommand = args.positionals[1]
    if (subcommand === 'ack') {
      await acknowledgeEvents(args)
      return
    }

    await listEvents(args)
    return
  }

  if (command === 'wait') {
    await waitForTask(args)
    return
  }

  if (command === 'collect') {
    await collectTaskOutput(args)
    return
  }

  printUsage()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
