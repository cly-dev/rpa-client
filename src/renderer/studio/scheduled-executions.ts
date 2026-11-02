const activeScheduledExecutions = new Set<string>()

export function registerScheduledExecution(id: string): void {
  activeScheduledExecutions.add(id)
}

export function unregisterScheduledExecution(id: string): void {
  activeScheduledExecutions.delete(id)
}

export function isScheduledExecutionActive(id: string): boolean {
  return activeScheduledExecutions.has(id)
}
