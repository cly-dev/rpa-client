import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const targetPlatform = process.argv[2]
const outputNames = targetPlatform === 'win32'
  ? ['win-unpacked.tmp', 'win-unpacked']
  : targetPlatform === 'darwin'
    ? ['mac.tmp', 'mac-arm64.tmp', 'mac', 'mac-arm64']
    : []

for (const name of outputNames) {
  const target = resolve('release', name)
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (targetPlatform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
      throw new Error(
        `无法清理 Windows 打包目录：${target}\n` +
        '请关闭正在运行的 RPA 工作室、Electron、Chromium，以及打开该目录的资源管理器窗口后重试。' +
        '如果仍然失败，请检查 Windows Defender 是否正在扫描 release 目录。',
        { cause: error },
      )
    }
    throw error
  }
}

if (outputNames.length > 0) console.log(`已清理 ${targetPlatform} 打包暂存目录`)
