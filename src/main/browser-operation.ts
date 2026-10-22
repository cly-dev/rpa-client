/** A single Playwright session must not be closed or reused by overlapping IPC calls. */
export class BrowserOperationGate {
  private active: string | undefined

  begin(label: string): () => void {
    if (this.active !== undefined) throw new Error(`浏览器正在${this.active}，请等待当前操作完成后重试`)
    this.active = label
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = undefined
    }
  }
}
