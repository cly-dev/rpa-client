import DOMPurify from 'dompurify'

const tags = ['p', 'div', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a']
export function sanitizeReviewHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS: tags, ALLOWED_ATTR: ['href', 'style', 'colspan', 'rowspan'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  for (const element of doc.body.querySelectorAll<HTMLElement>('*')) {
    const style = element.style
    const kept: [string, string][] = []
    for (const name of ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-align', 'font-size']) {
      const value = style.getPropertyValue(name)
      if (value && !/url\s*\(|expression|var\s*\(/i.test(value)) kept.push([name, value])
    }
    element.removeAttribute('style')
    for (const [name, value] of kept) style.setProperty(name, value)
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') ?? ''
      if (!/^https?:\/\//i.test(href)) element.removeAttribute('href')
      else { element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer') }
    }
  }
  return doc.body.innerHTML
}
export function reviewPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeReviewHtml(html), 'text/html')
  for (const br of doc.querySelectorAll('br')) br.replaceWith('\n')
  for (const block of doc.querySelectorAll('p,div,h1,h2,h3,h4,li,tr,blockquote,pre')) block.append('\n')
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trimEnd()
}
export function initialReviewHtml(value: string): string {
  if (/<\/?[a-z][^>]*>/i.test(value)) return sanitizeReviewHtml(value)
  const div = document.createElement('div')
  div.textContent = value
  return div.innerHTML.replace(/\r?\n/g, '<br>')
}
