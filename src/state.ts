import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { OrchestratorRegistry } from './types.js'

const REGISTRY_VERSION = 1
const AGENT_ID_PATTERN = /[^a-z0-9-]+/g
const DEFAULT_REGISTRY_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_REGISTRY_LOCK_POLL_INTERVAL_MS = 50

export function normalizeAgentId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(AGENT_ID_PATTERN, '-')
    .replace(/^-+|-+$/g, '') || 'agent'
}

export function getDefaultTmuxSocketPath(): string {
  if (process.env.TMUX_ORCHESTRATOR_SOCKET) {
    return resolve(process.env.TMUX_ORCHESTRATOR_SOCKET)
  }

  const baseDir = process.env.TMUX_ORCHESTRATOR_SOCKET_DIR ?? `${process.env.TMPDIR ?? '/tmp'}/tmux-orchestrator-sockets`

  return resolve(baseDir, 'orchestrator.sock')
}

export function getDefaultStateDir(): string {
  if (process.env.TMUX_ORCHESTRATOR_STATE_DIR) {
    return resolve(process.env.TMUX_ORCHESTRATOR_STATE_DIR)
  }

  if (process.env.XDG_STATE_HOME) {
    return resolve(process.env.XDG_STATE_HOME, 'tmux-orchestrator')
  }

  return resolve(homedir(), '.local', 'state', 'tmux-orchestrator')
}

export function getStatePaths(stateDir = getDefaultStateDir()) {
  const resolvedStateDir = resolve(stateDir)

  return {
    stateDir: resolvedStateDir,
    registryPath: resolve(resolvedStateDir, 'registry.json'),
    artifactsDir: resolve(resolvedStateDir, 'artifacts'),
  }
}

export function createEmptyRegistry(): OrchestratorRegistry {
  return {
    version: REGISTRY_VERSION,
    agents: [],
    tasks: [],
  }
}

export async function readRegistry(path: string): Promise<OrchestratorRegistry | null> {
  try {
    const content = await readFile(path, 'utf8')
    const parsed = JSON.parse(content) as OrchestratorRegistry
    if (parsed.version !== REGISTRY_VERSION) {
      throw new Error(`Unsupported registry version: ${parsed.version}`)
    }
    return parsed
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function loadRegistry(path: string): Promise<OrchestratorRegistry> {
  return (await readRegistry(path)) ?? createEmptyRegistry()
}

export async function writeRegistry(path: string, registry: OrchestratorRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`)
}

function isLockHeldError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

export async function acquireRegistryLock(
  registryPath: string,
  opts: {
    timeoutMs?: number
    pollIntervalMs?: number
  } = {},
): Promise<() => Promise<void>> {
  const lockPath = `${registryPath}.lock`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REGISTRY_LOCK_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_REGISTRY_LOCK_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  await mkdir(dirname(lockPath), { recursive: true })

  while (true) {
    try {
      await mkdir(lockPath)
      return async () => {
        await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if (!isLockHeldError(error)) throw error
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring registry lock: ${lockPath}`)
      }

      await sleep(pollIntervalMs)
    }
  }
}

export function createNextTaskId(registry: OrchestratorRegistry): string {
  const nextTaskNumber =
    registry.tasks.reduce((max, task) => {
      const match = /^T-(\d+)$/u.exec(task.id)
      if (!match) return max
      return Math.max(max, Number(match[1]))
    }, 0) + 1

  return `T-${String(nextTaskNumber).padStart(3, '0')}`
}
