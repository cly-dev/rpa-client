export interface OutputReferenceSource {
  readonly nodeId: string
  readonly port: string
}

export interface OutputReferenceAlias {
  readonly path: string
  readonly label: string
}

/** Keep stable node IDs in saved expressions while showing only field names in the editor. */
export function outputReferenceAliases(sources: readonly OutputReferenceSource[]): OutputReferenceAlias[] {
  return sources.map(source => ({
    path: `outputs.${source.nodeId}.${source.port}`,
    label: source.port.replace(/[{}]/g, '').trim() || '未命名字段',
  }))
}

export function displaySubflowReferences(expression: string, aliases: readonly OutputReferenceAlias[]): string {
  const labels = new Map(aliases.map(alias => [alias.path, alias.label]))
  return expression.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, path: string) => {
    const label = labels.get(path.trim())
    return label === undefined ? match : `{{${label}}}`
  })
}

export function storeSubflowReferences(expression: string, aliases: readonly OutputReferenceAlias[], previousStored: string): string {
  const labels = new Map(aliases.map(alias => [alias.path, alias.label]))
  const previousByLabel = new Map<string, (string | undefined)[]>()
  previousStored.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const clean = path.trim()
    const label = labels.get(clean) ?? clean
    previousByLabel.set(label, [...(previousByLabel.get(label) ?? []), labels.has(clean) ? clean : undefined])
    return ''
  })
  const seen = new Map<string, number>()
  return expression.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, label: string) => {
    const clean = label.trim()
    const index = seen.get(clean) ?? 0
    seen.set(clean, index + 1)
    const path = previousByLabel.get(clean)?.[index]
    return path === undefined ? match : `{{${path}}}`
  })
}
