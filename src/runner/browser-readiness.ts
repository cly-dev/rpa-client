import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

export interface BrowserReadiness {
  readonly available: boolean
  readonly message: string
}

export function browserExecutablePath(packaged = false, resourcesPath = process.resourcesPath): string {
  const defaultPath = chromium.executablePath()
  if (!packaged) return defaultPath
  const browser = defaultPath.match(/(?:^|[\\/])(chromium-\d+)[\\/](.+)$/)
  if (!browser || !resourcesPath) throw new Error('无法定位随安装包提供的 Chromium 浏览器')
  return join(resourcesPath, 'playwright-browsers', browser[1], ...browser[2].split(/[\\/]/))
}

export async function checkBrowserReadiness(packaged = false, resourcesPath = process.resourcesPath): Promise<BrowserReadiness> {
  try {
    await access(browserExecutablePath(packaged, resourcesPath), constants.F_OK)
    return { available: true, message: 'Chromium 浏览器已就绪' }
  } catch {
    return { available: false, message: '未检测到运行流程所需的 Chromium 浏览器，请联系管理员安装浏览器组件' }
  }
}
