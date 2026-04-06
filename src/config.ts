import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DispatchConfig, RoleTemplate, RouteTemplate } from './types.js'

const DEFAULT_CONFIG_DIR = '.tmux-orchestrator'

const DEFAULT_ROLES: Record<string, RoleTemplate> = {
  planner: {
    role: 'planner',
    command: 'codex',
    instructions: 'Produce a concrete implementation plan with ordered execution steps. Do not modify files unless explicitly asked.',
    timeoutSeconds: 900,
  },
  reviewer: {
    role: 'reviewer',
    command: 'codex',
    instructions: 'Do not modify files. Write findings only, ordered by severity with concrete file references.',
    timeoutSeconds: 900,
  },
  investigator: {
    role: 'investigator',
    command: 'codex',
    instructions: 'Do not modify files unless explicitly told. Return evidence, hypotheses, and next steps.',
    timeoutSeconds: 900,
  },
  implementer: {
    role: 'implementer',
    command: 'codex',
    instructions: 'Make the smallest correct change, run focused verification, and summarize changed files and results.',
    timeoutSeconds: 1800,
  },
  docs: {
    role: 'docs',
    command: 'codex',
    instructions: 'Update documentation only and summarize the doc changes clearly.',
    timeoutSeconds: 900,
  },
}

const DEFAULT_ROUTES: Record<string, RouteTemplate> = {
  review: { role: 'reviewer' },
  investigate: { role: 'investigator' },
  implement: { role: 'implementer' },
  docs: { role: 'docs' },
  plan: { role: 'planner' },
  feature: {
    role: 'planner',
    instructions: 'Treat this as a feature request. Produce a plan and execution slices first instead of editing code directly unless the user explicitly asks for implementation now.',
  },
}

interface DispatchConfigFile {
  roles?: Record<string, RoleTemplate>
  routes?: Record<string, RouteTemplate>
}

function mergeTemplates<T extends Record<string, object>>(defaults: T, overrides: T | undefined): T {
  if (!overrides) return { ...defaults }

  const merged: Record<string, object> = { ...defaults }
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = { ...(defaults[key] ?? {}), ...value }
  }

  return merged as T
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export function getDefaultConfigDir(): string {
  return resolve(process.env.TMUX_ORCHESTRATOR_CONFIG_DIR ?? DEFAULT_CONFIG_DIR)
}

export function getConfigPaths(configDir = getDefaultConfigDir()) {
  const resolvedConfigDir = resolve(configDir)
  return {
    configDir: resolvedConfigDir,
    configFilePath: resolve(resolvedConfigDir, 'dispatch.json'),
    rolesPath: resolve(resolvedConfigDir, 'roles.json'),
    routesPath: resolve(resolvedConfigDir, 'routes.json'),
  }
}

export async function loadDispatchConfig(configDir?: string): Promise<DispatchConfig> {
  const paths = getConfigPaths(configDir)
  const combined = await readJsonFile<DispatchConfigFile>(paths.configFilePath)
  const roles = await readJsonFile<Record<string, RoleTemplate>>(paths.rolesPath)
  const routes = await readJsonFile<Record<string, RouteTemplate>>(paths.routesPath)

  return {
    roles: mergeTemplates(DEFAULT_ROLES, { ...(combined?.roles ?? {}), ...(roles ?? {}) }),
    routes: mergeTemplates(DEFAULT_ROUTES, { ...(combined?.routes ?? {}), ...(routes ?? {}) }),
  }
}

export function classifyDispatchRoute(request: string): string {
  const normalized = request.toLowerCase()

  if (/\b(review|audit|findings?|regressions?|missing tests?)\b/u.test(normalized)) {
    return 'review'
  }

  if (/\b(readme|docs?|documentation|changelog|write-?up)\b/u.test(normalized)) {
    return 'docs'
  }

  if (/\b(investigat|debug|repro(duce|duction)?|triage|root cause)\b/u.test(normalized)) {
    return 'investigate'
  }

  if (/\b(plan|design|roadmap|break down|spec)\b/u.test(normalized)) {
    return 'plan'
  }

  if (/\b(feature|workflow|pipeline|support)\b/u.test(normalized) && /\b(add|build|create|ship|prototype)\b/u.test(normalized)) {
    return 'feature'
  }

  return 'implement'
}
