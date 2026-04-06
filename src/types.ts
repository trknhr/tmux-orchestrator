export type AgentStatus = 'idle' | 'busy' | 'missing' | 'quarantined'
export type TaskStatus = 'assigned' | 'done' | 'timed-out' | 'failed'

export interface AgentRecord {
  id: string
  sessionName: string
  target: string
  role: string
  workdir: string
  socketPath: string
  launchCommand: string
  status: AgentStatus
  currentTaskId: string | null
  createdAt: string
  lastSeenAt: string
}

export interface TaskRecord {
  id: string
  agentId: string
  goal: string
  prompt: string
  outputFile: string
  completionFile: string
  completionMarker: string
  status: TaskStatus
  timeoutSeconds: number
  assignedAt: string
  completedAt?: string
  eventAcknowledgedAt?: string
  collectedAt?: string
}

export interface OrchestratorRegistry {
  version: 1
  agents: AgentRecord[]
  tasks: TaskRecord[]
}

export interface RoleTemplate {
  agentId?: string
  role?: string
  command?: string
  workdir?: string
  instructions?: string
  timeoutSeconds?: number
}

export interface RouteTemplate {
  role: string
  instructions?: string
  timeoutSeconds?: number
}

export interface DispatchConfig {
  roles: Record<string, RoleTemplate>
  routes: Record<string, RouteTemplate>
}
