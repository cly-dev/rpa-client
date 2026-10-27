import type { ReactNode } from 'react'

export function BrowserModePicker({ headless, onChange, name }: { headless: boolean; onChange: (headless: boolean) => void; name: string }): ReactNode {
  return (
    <div className="browser-mode-picker">
      <strong className="browser-mode-picker-title">浏览器窗口</strong>
      <div className="node-run-modes" role="radiogroup" aria-label="浏览器窗口">
        <label className={headless ? 'is-selected' : ''}>
          <input type="radio" name={name} checked={headless} onChange={() => { onChange(true) }} />
          <span><strong>无头运行</strong><small>后台执行，不弹出浏览器窗口。</small></span>
        </label>
        <label className={!headless ? 'is-selected' : ''}>
          <input type="radio" name={name} checked={!headless} onChange={() => { onChange(false) }} />
          <span><strong>显示浏览器</strong><small>打开可见窗口，便于查看页面操作。</small></span>
        </label>
      </div>
    </div>
  )
}
