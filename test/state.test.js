import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

import {
  acquireRegistryLock,
  getDefaultStateDir,
  getDefaultTmuxSocketPath,
  getStatePaths,
  loadRegistry,
  writeRegistry,
} from '../dist/src/state.js'

function createTask(id) {
  return {
    id,
    agentId: 'reviewer',
    goal: 'Review the current branch',
    prompt: `TASK_ID: ${id}`,
    outputFile: `/tmp/${id}.md`,
    completionFile: `/tmp/${id}.status`,
    completionMarker: 'STATUS: done',
    status: 'assigned',
    timeoutSeconds: 60,
    assignedAt: '2026-04-04T00:00:00.000Z',
  }
}

test('acquireRegistryLock serializes concurrent registry updates', async (t) => {
  const root = await mkdtemp(join('/tmp', 'tmux-orchestrator-state-'))
  const registryPath = join(root, 'registry.json')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  await writeRegistry(registryPath, {
    version: 1,
    agents: [],
    tasks: [],
  })

  await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const release = await acquireRegistryLock(registryPath)
      try {
        const registry = await loadRegistry(registryPath)
        await sleep(10)
        const nextTaskId = `T-${String(registry.tasks.length + 1).padStart(3, '0')}`
        registry.tasks.push(createTask(nextTaskId))
        await writeRegistry(registryPath, registry)
      } finally {
        await release()
      }
    }),
  )

  const finalRegistry = JSON.parse(await readFile(registryPath, 'utf8'))
  assert.equal(finalRegistry.tasks.length, 10)
  assert.deepEqual(
    finalRegistry.tasks.map((task) => task.id),
    ['T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007', 'T-008', 'T-009', 'T-010'],
  )
})

test('getDefaultStateDir prefers TMUX_ORCHESTRATOR_STATE_DIR, then XDG_STATE_HOME, then home state dir', () => {
  const originalStateDir = process.env.TMUX_ORCHESTRATOR_STATE_DIR
  const originalXdgStateHome = process.env.XDG_STATE_HOME

  try {
    process.env.TMUX_ORCHESTRATOR_STATE_DIR = '/tmp/custom-orchestrator-state'
    process.env.XDG_STATE_HOME = '/tmp/xdg-state-home'
    assert.equal(getDefaultStateDir(), '/tmp/custom-orchestrator-state')

    delete process.env.TMUX_ORCHESTRATOR_STATE_DIR
    assert.equal(getDefaultStateDir(), '/tmp/xdg-state-home/tmux-orchestrator')

    delete process.env.XDG_STATE_HOME
    assert.equal(getDefaultStateDir(), join(homedir(), '.local', 'state', 'tmux-orchestrator'))
  } finally {
    if (originalStateDir === undefined) {
      delete process.env.TMUX_ORCHESTRATOR_STATE_DIR
    } else {
      process.env.TMUX_ORCHESTRATOR_STATE_DIR = originalStateDir
    }

    if (originalXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = originalXdgStateHome
    }
  }
})

test('getStatePaths uses the XDG-based default state dir', () => {
  const originalStateDir = process.env.TMUX_ORCHESTRATOR_STATE_DIR
  const originalXdgStateHome = process.env.XDG_STATE_HOME

  try {
    delete process.env.TMUX_ORCHESTRATOR_STATE_DIR
    process.env.XDG_STATE_HOME = '/tmp/xdg-state-home'

    const paths = getStatePaths()
    assert.equal(paths.stateDir, '/tmp/xdg-state-home/tmux-orchestrator')
    assert.equal(paths.registryPath, '/tmp/xdg-state-home/tmux-orchestrator/registry.json')
    assert.equal(paths.artifactsDir, '/tmp/xdg-state-home/tmux-orchestrator/artifacts')
  } finally {
    if (originalStateDir === undefined) {
      delete process.env.TMUX_ORCHESTRATOR_STATE_DIR
    } else {
      process.env.TMUX_ORCHESTRATOR_STATE_DIR = originalStateDir
    }

    if (originalXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME
    } else {
      process.env.XDG_STATE_HOME = originalXdgStateHome
    }
  }
})

test('getDefaultTmuxSocketPath prefers TMUX_ORCHESTRATOR_SOCKET, then socket dir, then tmp fallback', () => {
  const originalSocket = process.env.TMUX_ORCHESTRATOR_SOCKET
  const originalSocketDir = process.env.TMUX_ORCHESTRATOR_SOCKET_DIR
  const originalTmpdir = process.env.TMPDIR

  try {
    process.env.TMUX_ORCHESTRATOR_SOCKET = '/tmp/custom.sock'
    process.env.TMUX_ORCHESTRATOR_SOCKET_DIR = '/tmp/custom-socket-dir'
    process.env.TMPDIR = '/tmp/custom-tmp'
    assert.equal(getDefaultTmuxSocketPath(), '/tmp/custom.sock')

    delete process.env.TMUX_ORCHESTRATOR_SOCKET
    assert.equal(getDefaultTmuxSocketPath(), '/tmp/custom-socket-dir/orchestrator.sock')

    delete process.env.TMUX_ORCHESTRATOR_SOCKET_DIR
    assert.equal(getDefaultTmuxSocketPath(), '/tmp/custom-tmp/tmux-orchestrator-sockets/orchestrator.sock')
  } finally {
    if (originalSocket === undefined) {
      delete process.env.TMUX_ORCHESTRATOR_SOCKET
    } else {
      process.env.TMUX_ORCHESTRATOR_SOCKET = originalSocket
    }

    if (originalSocketDir === undefined) {
      delete process.env.TMUX_ORCHESTRATOR_SOCKET_DIR
    } else {
      process.env.TMUX_ORCHESTRATOR_SOCKET_DIR = originalSocketDir
    }

    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR
    } else {
      process.env.TMPDIR = originalTmpdir
    }
  }
})
