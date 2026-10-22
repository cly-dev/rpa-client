import type { SwitchConfig, WorkflowEdge } from './types.ts'

export type SwitchCaseType = NonNullable<SwitchConfig['caseTypes']>[number]

export function switchCaseType(config: SwitchConfig, index: number): SwitchCaseType {
  return config.caseTypes?.[index] ?? 'string'
}

export function switchCaseId(config: SwitchConfig, index: number): string {
  return config.caseIds?.[index] || `legacy-${index}`
}

export function switchCaseValue(config: SwitchConfig, index: number): string | number | boolean | null | undefined {
  const raw = config.cases[index]
  if (raw === undefined) return undefined
  switch (switchCaseType(config, index)) {
    case 'string': return raw
    case 'number': {
      if (raw.trim() === '') return undefined
      const value = Number(raw)
      return Number.isFinite(value) ? value : undefined
    }
    case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : undefined
    case 'null': return null
  }
}

export function findSwitchCaseIndex(config: SwitchConfig, actual: unknown): number {
  return config.cases.findIndex((_, index) => {
    const expected = switchCaseValue(config, index)
    return expected !== undefined && expected === actual
  })
}

export function switchCaseLabel(config: SwitchConfig, index: number): string {
  const raw = config.cases[index] ?? ''
  switch (switchCaseType(config, index)) {
    case 'string': return raw === '' ? '空文本 ""' : raw
    case 'number': return raw.trim() === '' ? '数字 · 未填写' : `数字 · ${raw}`
    case 'boolean': return `布尔 · ${raw}`
    case 'null': return '空值 null'
  }
}

/** Move one branch while keeping its prompt and stable identity together. */
export function reorderSwitchCase(config: SwitchConfig, from: number, to: number): SwitchConfig {
  if (from < 0 || to < 0 || from >= config.cases.length || to >= config.cases.length || from === to) return config
  const move = <T>(items: readonly T[]): T[] => {
    const result = [...items]
    const [item] = result.splice(from, 1)
    if (item !== undefined) result.splice(to, 0, item)
    return result
  }
  return {
    ...config,
    cases: move(config.cases),
    caseIds: move(config.cases.map((_, index) => switchCaseId(config, index))),
    casePrompts: config.casePrompts === undefined ? undefined : move(config.cases.map((_, index) => config.casePrompts?.[index] ?? '')),
    caseTypes: config.caseTypes === undefined ? undefined : move(config.cases.map((_, index) => switchCaseType(config, index))),
  }
}

/** Preserve downstream wiring when an indexed branch is removed. */
export function remapSwitchEdges(edges: readonly WorkflowEdge[], nodeId: string, previous: SwitchConfig, next: SwitchConfig): WorkflowEdge[] {
  const newIndexById = new Map(next.cases.map((_, index) => [switchCaseId(next, index), index]))
  return edges.flatMap(edge => {
    if (edge.sourceNodeId !== nodeId || !edge.sourcePort.startsWith('case-')) return [edge]
    const previousIndex = Number(edge.sourcePort.slice('case-'.length))
    if (!Number.isInteger(previousIndex) || previousIndex < 0 || previousIndex >= previous.cases.length) return [edge]
    const nextIndex = newIndexById.get(switchCaseId(previous, previousIndex))
    return nextIndex === undefined ? [] : [{ ...edge, sourcePort: `case-${nextIndex}` }]
  })
}
