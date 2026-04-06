import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TmuxPaneSummary {
  target: string
  currentCommand: string
  title: string
}

function getExecErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    return error.stderr.trim()
  }

  if (error instanceof Error) return error.message
  return String(error)
}

function isMissingSessionMessage(message: string): boolean {
  return (
    message.includes("can't find session") ||
    message.includes("can't find pane") ||
    message.includes('no server running on') ||
    message.includes('no such file or directory') ||
    message.includes('error connecting to')
  )
}

async function runTmux(socketPath: string, args: string[]): Promise<string> {
  await mkdir(dirname(socketPath), { recursive: true })

  try {
    const { stdout } = await execFileAsync('tmux', ['-S', socketPath, ...args])
    return stdout.trimEnd()
  } catch (error) {
    const message = getExecErrorMessage(error)
    throw new Error(message || `tmux ${args[0]} failed`)
  }
}

export async function tmuxSessionExists(socketPath: string, sessionName: string): Promise<boolean> {
  try {
    await runTmux(socketPath, ['has-session', '-t', sessionName])
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (isMissingSessionMessage(message)) return false
    throw error
  }
}

export async function tmuxCreateSession(opts: {
  socketPath: string
  sessionName: string
  workdir: string
  launchCommand: string
}): Promise<void> {
  await runTmux(opts.socketPath, ['new-session', '-d', '-s', opts.sessionName, '-n', 'agent', '-c', opts.workdir])

  if (!opts.launchCommand.trim()) return

  const target = `${opts.sessionName}:0.0`
  await runTmux(opts.socketPath, ['send-keys', '-t', target, 'C-u'])
  await runTmux(opts.socketPath, ['send-keys', '-t', target, '-l', opts.launchCommand])
  await runTmux(opts.socketPath, ['send-keys', '-t', target, 'Enter'])
}

export async function tmuxSendPrompt(socketPath: string, target: string, prompt: string): Promise<void> {
  await runTmux(socketPath, ['send-keys', '-t', target, 'C-u'])
  await runTmux(socketPath, ['send-keys', '-t', target, '-l', prompt])
  await runTmux(socketPath, ['send-keys', '-t', target, 'Enter'])
}

export async function tmuxListPanes(socketPath: string): Promise<TmuxPaneSummary[]> {
  try {
    const output = await runTmux(socketPath, [
      'list-panes',
      '-a',
      '-F',
      '#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_title}',
    ])

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [target = '', currentCommand = '', title = ''] = line.split('\t')
        return { target, currentCommand, title }
      })
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (isMissingSessionMessage(message)) return []
    throw error
  }
}
