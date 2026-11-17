import { useEffect, useRef, useState, type ReactNode } from 'react'
import Squire from 'squire-rte'
import type { ApprovalReview, ApprovalReviewResult } from '../../graph/approval-review.ts'
import type { JsonValue } from '../../graph/types.ts'
import { initialReviewHtml, reviewPlainText, sanitizeReviewHtml } from './review-html.ts'

type ReviewIcon = 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'strike' | 'bullets' | 'numbers' | 'link' | 'table' | 'clear' | 'left' | 'center' | 'edit' | 'restore'
function EditorIcon({ name }: { name: ReviewIcon }): ReactNode {
  const paths: Record<ReviewIcon, ReactNode> = {
    undo: <><path d="M9 5 4 10l5 5"/><path d="M4 10h10a6 6 0 0 1 0 12" transform="translate(0 -3)"/></>,
    redo: <><path d="m15 5 5 5-5 5"/><path d="M20 10H10a6 6 0 0 0 0 12" transform="translate(0 -3)"/></>,
    bold: <><path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z"/></>,
    italic: <><path d="M10 4h9M5 20h9M15 4 9 20"/></>,
    underline: <><path d="M6 4v7a6 6 0 0 0 12 0V4M4 21h16"/></>,
    strike: <><path d="M17 5c-4-3-11-1-10 3 .5 2 3 3 5 4M7 19c4 3 11 1 10-3M3 12h18"/></>,
    bullets: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></>,
    numbers: <><path d="M10 6h11M10 12h11M10 18h11M3 4h2v5M3 9h4M3 14c3-2 5 0 2 2l-2 3h4"/></>,
    link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M12 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 1)"/></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/></>,
    clear: <><path d="m4 4 16 16M10 4h9M14 4l-5 16M5 20h9"/></>,
    left: <><path d="M4 5h16M4 10h10M4 15h16M4 20h10"/></>,
    center: <><path d="M4 5h16M7 10h10M4 15h16M7 20h10"/></>,
    edit: <><path d="m15 4 5 5M4 20l1-6L16 3a2 2 0 0 1 5 5L10 19z"/></>,
    restore: <><path d="M4 4v6h6M4 10a8 8 0 1 1 0 6"/></>,
  }
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
function RichEditor({ initial, onChange, disabled }: { initial: string; onChange: (html: string) => void; disabled: boolean }): ReactNode {
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<Squire>()
  const interacted = useRef(false)
  const [link, setLink] = useState<string>()
  const [color, setColor] = useState('#334155')
  const [formats, setFormats] = useState<Record<string, boolean>>({})
  const linkRange = useRef<Range>()
  const changed = useRef(onChange)
  changed.current = onChange
  useEffect(() => {
    if (!root.current) return
    const instance = new Squire(root.current, { blockTag: 'P', sanitizeToDOMFragment: html => {
      const template = document.createElement('template')
      template.innerHTML = sanitizeReviewHtml(html)
      return template.content
    } })
    editor.current = instance
    instance.setHTML(initialReviewHtml(initial))
    const sync = (): void => setFormats(Object.fromEntries(['B', 'I', 'U', 'S', 'UL', 'OL'].map(tag => [tag, instance.hasFormat(tag)])))
    interacted.current = false
    const markInteraction = (): void => { interacted.current = true }
    const element = root.current
    element.addEventListener('beforeinput', markInteraction)
    element.addEventListener('keydown', markInteraction)
    instance.addEventListener('input', () => { if (!interacted.current) return; changed.current(sanitizeReviewHtml(instance.getHTML())); sync() })
    instance.addEventListener('pathChange', sync)
    instance.addEventListener('select', sync)
    return () => { element.removeEventListener('beforeinput', markInteraction); element.removeEventListener('keydown', markInteraction); instance.destroy(); editor.current = undefined }
  }, [initial])
  useEffect(() => { root.current?.setAttribute('contenteditable', disabled ? 'false' : 'true') }, [disabled])
  const action = (command: (instance: Squire) => void): void => { if (editor.current && !disabled) { interacted.current = true; command(editor.current); editor.current.focus() } }
  const button = (icon: ReviewIcon, label: string, command: (instance: Squire) => void, pressed?: boolean): ReactNode => <button type="button" className="review-tool" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => action(command)}><EditorIcon name={icon}/></button>
  return <div className={`review-rich-editor${disabled ? ' is-readonly' : ''}`}>
    <div className="review-rich-toolbar" role="toolbar" aria-label="富文本格式">
      <div className="review-tool-group"><select aria-label="段落样式" title="段落样式" disabled={disabled} defaultValue="p" onChange={event => { const tag = event.target.value; action(e => { e.modifyBlocks(fragment => { for (const block of fragment.querySelectorAll('p,div,h1,h2,h3,h4')) { const next = document.createElement(tag); next.append(...Array.from(block.childNodes)); block.replaceWith(next) } return fragment }) }); event.target.value = 'p' }}><option value="p">正文</option><option value="h2">标题</option><option value="h3">小标题</option></select></div>
      <span className="review-tool-divider"/>
      <div className="review-tool-group">
        {button('bold', '加粗', e => { e.hasFormat('B') ? e.removeBold() : e.bold() }, formats.B)}
        {button('italic', '斜体', e => { e.hasFormat('I') ? e.removeItalic() : e.italic() }, formats.I)}
        {button('underline', '下划线', e => { e.hasFormat('U') ? e.removeUnderline() : e.underline() }, formats.U)}
        {button('strike', '删除线', e => { e.hasFormat('S') ? e.removeStrikethrough() : e.strikethrough() }, formats.S)}
        <label className="review-color-tool" title="文字颜色"><span aria-hidden="true">A<i style={{ background: color }}/></span><input aria-label="文字颜色" type="color" disabled={disabled} value={color} onPointerDown={() => { linkRange.current = editor.current?.getSelection().cloneRange() }} onChange={event => { const next = event.target.value; setColor(next); action(e => { if (linkRange.current) e.setSelection(linkRange.current); e.setTextColor(next) }) }}/></label>
      </div>
      <span className="review-tool-divider"/>
      <div className="review-tool-group">
        {button('bullets', '无序列表', e => { e.hasFormat('UL') ? e.removeList() : e.makeUnorderedList() }, formats.UL)}
        {button('numbers', '有序列表', e => { e.hasFormat('OL') ? e.removeList() : e.makeOrderedList() }, formats.OL)}
        {button('left', '左对齐', e => { e.setTextAlignment('left') })}
        {button('center', '居中对齐', e => { e.setTextAlignment('center') })}
      </div>
      <span className="review-tool-divider"/>
      <div className="review-tool-group">
        {button('link', '链接', e => { linkRange.current = e.getSelection().cloneRange(); setLink('') })}
        {button('table', '插入表格', e => { e.insertHTML('<table><tbody><tr><td>内容</td><td>内容</td></tr><tr><td>内容</td><td>内容</td></tr></tbody></table><p><br></p>') })}
        {button('clear', '清除格式', e => { e.removeAllFormatting() })}
      </div>
      <div className="review-tool-group review-history-tools">{button('undo', '撤销', e => { e.undo() })}{button('redo', '重做', e => { e.redo() })}</div>
    </div>
    {link !== undefined ? <div className="review-link-entry"><span>链接地址</span><div><input aria-label="链接地址" autoFocus value={link} onKeyDown={event => { if (event.key === 'Escape') setLink(undefined) }} onChange={event => setLink(event.target.value)} placeholder="https://example.com" /><button type="button" disabled={!/^https?:\/\//i.test(link)} onClick={() => { action(e => { if (linkRange.current) e.setSelection(linkRange.current); e.makeLink(link) }); setLink(undefined) }}>插入链接</button><button type="button" className="review-link-cancel" onClick={() => setLink(undefined)}>取消</button></div></div> : null}
    <div ref={root} className="review-rich-body" role="textbox" aria-label="审核内容" aria-multiline="true" data-placeholder="输入或粘贴需要审核的内容…" />
  </div>
}

export function ApprovalContentEditor({ review, onChange, disabled = false, result }: { review: ApprovalReview; onChange?: (result: ApprovalReviewResult | undefined) => void; disabled?: boolean; result?: ApprovalReviewResult }): ReactNode {
  const [draft, setDraft] = useState<string>(() => review.format !== 'json' && typeof (result?.content ?? review.content) === 'string' ? String(result?.content ?? review.content) : JSON.stringify(result?.content ?? review.content, null, 2))
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState('')
  const [modified, setModified] = useState(result?.modified ?? false)
  const [textLength, setTextLength] = useState(0)
  const changed = useRef(onChange)
  changed.current = onChange
  const structured = review.format === 'json' || typeof review.content !== 'string'
  const rich = review.format === 'rich-text' && !structured
  const readOnly = disabled || !review.editable
  const original = structured ? JSON.stringify(review.content, null, 2) : String(review.content)
  useEffect(() => {
    try {
      const content: JsonValue = structured ? JSON.parse(draft) : rich ? sanitizeReviewHtml(draft === original ? initialReviewHtml(original) : draft) : draft
      const kind = (v: JsonValue): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
      if (kind(content) !== kind(review.content)) throw new Error('请保持原内容的数据类型')
      if (JSON.stringify(content).length > 190000) throw new Error('内容过长，请控制在 19 万字符以内')
      setError('')
      setModified(JSON.stringify(content) !== JSON.stringify(review.content))
      setTextLength((rich ? reviewPlainText(String(content)) : typeof content === 'string' ? content : JSON.stringify(content)).length)
      changed.current?.({ content, plainText: rich ? reviewPlainText(String(content)) : typeof content === 'string' ? content : JSON.stringify(content, null, 2), modified: JSON.stringify(content) !== JSON.stringify(review.content), comment: '' })
    } catch (e) { setError(e instanceof Error ? e.message : '内容无效'); changed.current?.(undefined) }
  }, [draft, original, review, structured, rich])
  return <section className="approval-content-editor">
    <div className="approval-content-title"><div className="review-content-heading"><strong>审核内容</strong><span className={`review-edit-badge${readOnly ? ' is-readonly' : ''}`}>{readOnly ? '只读' : '可编辑'}</span>{review.label ? <small>{review.label}</small> : null}</div>{!readOnly ? <div className="review-content-actions"><button type="button" className="review-restore" aria-label="恢复原内容" title="恢复原内容" onClick={() => { setDraft(original); setGeneration(n => n + 1) }}><EditorIcon name="restore"/>恢复原文</button><button type="button" className="review-start-edit" onClick={event => { (event.currentTarget.closest('section')?.querySelector('[role="textbox"],textarea') as HTMLElement | null)?.focus() }}><EditorIcon name="edit"/>编辑内容</button></div> : null}</div>
    {rich ? <RichEditor key={generation} initial={result ? String(result.content) : original} disabled={readOnly} onChange={setDraft} /> : <textarea aria-label="审核内容" rows={8} value={draft} readOnly={readOnly} onChange={event => setDraft(event.target.value)} />}
    {error ? <p className="execution-error" role="alert">{error}</p> : <div className="review-content-status"><span className={modified ? 'is-modified' : ''}><i/>{readOnly ? review.editable ? '内容仅供查看' : '此节点未开启编辑' : modified ? '已修改 · 审核通过后生效' : '可直接编辑正文，原始内容会保留'}</span><span>{textLength.toLocaleString()} 字</span></div>}
    {result?.modified ? <details><summary>查看原内容</summary><pre>{original}</pre></details> : null}
  </section>
}
