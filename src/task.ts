export interface TaskPromptOptions {
  taskId: string
  role: string
  goal: string
  workdir: string
  outputFile: string
  completionFile: string
  completionMarker: string
  instructions?: string
}

export interface TimedTask {
  assignedAt: string
  timeoutSeconds: number
}

export function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function buildTaskPrompt(opts: TaskPromptOptions): string {
  const lines = [
    `TASK_ID: ${opts.taskId}`,
    `ROLE: ${opts.role}`,
    `GOAL: ${compactText(opts.goal)}`,
    `WORKDIR: ${opts.workdir}`,
    `OUTPUT_FILE: ${opts.outputFile}`,
    `COMPLETION_FILE: ${opts.completionFile}`,
    `DONE_WHEN: write your final result to OUTPUT_FILE and then write exactly "${opts.completionMarker}" to COMPLETION_FILE`,
  ]

  if (opts.instructions) {
    lines.push(`ADDITIONAL_INSTRUCTIONS: ${compactText(opts.instructions)}`)
  }

  return lines.join('\n')
}

export function completionMarkerMatches(text: string, marker: string): boolean {
  return text.trim() === marker
}

export function taskHasTimedOut(task: TimedTask, now = Date.now()): boolean {
  return Date.parse(task.assignedAt) + task.timeoutSeconds * 1000 <= now
}
