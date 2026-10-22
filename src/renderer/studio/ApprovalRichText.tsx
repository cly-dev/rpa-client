import { createElement, useMemo, type ReactNode } from 'react'

const richTags = new Set([
  'p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'a',
])
const discardedTags = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input',
  'button', 'textarea', 'select', 'template', 'link', 'meta', 'img', 'video', 'audio',
])
const richTagPattern = /<\/?(?:p|div|br|strong|b|em|i|u|s|h[1-4]|ul|ol|li|blockquote|pre|code|hr|table|thead|tbody|tr|th|td|a)(?:\s|\/?>)/i

export function safeApprovalLink(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function renderNode(node: ChildNode, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const element = node as Element
  const tag = element.tagName.toLowerCase()
  if (discardedTags.has(tag)) return null
  const children = Array.from(element.childNodes, (child, index) => renderNode(child, index))
  if (!richTags.has(tag)) return children
  if (tag === 'a') {
    const href = safeApprovalLink(element.getAttribute('href') ?? '')
    return href ? createElement('a', { key, href, target: '_blank', rel: 'noopener noreferrer' }, ...children) : children
  }
  return createElement(tag, { key }, ...children)
}

export function ApprovalRichText({ value, className = '' }: { readonly value: string; readonly className?: string }): ReactNode {
  const content = useMemo(() => {
    if (!richTagPattern.test(value) || typeof DOMParser === 'undefined') return value
    const document = new DOMParser().parseFromString(value, 'text/html')
    return Array.from(document.body.childNodes, (node, index) => renderNode(node, index))
  }, [value])
  return <div className={`approval-rich-text ${className}`.trim()}>{content}</div>
}
