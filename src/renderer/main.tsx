import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

class MountErrorBoundary extends Component<{ readonly children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {}

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error.stack ?? error.message }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== undefined) {
      return <pre className="mount-error">{this.state.error}</pre>
    }
    return this.props.children
  }
}

const root = document.getElementById('root')
if (root === null) throw new Error('root 节点不存在')

try {
  createRoot(root).render(
    <StrictMode>
      <MountErrorBoundary>
        <App />
      </MountErrorBoundary>
    </StrictMode>,
  )
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  root.textContent = `createRoot 失败：\n${message}`
  root.style.cssText = 'padding:16px;color:#b42318;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace'
}
