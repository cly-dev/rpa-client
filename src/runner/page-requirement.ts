import type { WorkflowGraph } from '@graph/types.ts'

function hasSelector(selector: string | { readonly value: string } | undefined): boolean {
  return (typeof selector === 'string' ? selector : selector?.value ?? '').trim() !== ''
}

export function workflowNeedsBrowser(graphs: readonly WorkflowGraph[]): boolean {
  return graphs.some(graph => graph.nodes.some(node => {
    const type = node.config.type
    if (type === 'start' && node.config.url.trim() !== '') return true
    if (type === 'page-action') return node.config.steps.some(step => step.type !== 'wait' || hasSelector(step.selector))
    if (type === 'list-row-action') return true
    if (type === 'wait') return hasSelector(node.config.selector)
    if (type === 'open-page' || type === 'click' || type === 'type' || type === 'extract' || type === 'api-listen') return true
    return type === 'condition' && (node.config.mode === 'url' || node.config.mode === 'element')
  }))
}

export function workflowHasNavigation(graphs: readonly WorkflowGraph[]): boolean {
  return graphs.some(graph => graph.nodes.some(node => {
    if (node.config.type === 'start' || node.config.type === 'open-page') return node.config.url.trim() !== ''
    if (node.config.type === 'page-action') return node.config.steps.some(step => step.type === 'open' && step.url.trim() !== '')
    return false
  }))
}

export function workflowNeedsExistingPage(graphs: readonly WorkflowGraph[]): boolean {
  return workflowNeedsBrowser(graphs) && !workflowHasNavigation(graphs)
}

export function usablePageUrl(url: string | undefined): boolean {
  const clean = url?.trim() ?? ''
  return clean !== '' && !/^about:blank(?:$|[?#])/i.test(clean)
}
