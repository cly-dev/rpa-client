import { beforeEach, expect, it, vi } from 'vitest'

const accessMock = vi.hoisted(() => vi.fn())
const executablePathMock = vi.hoisted(() => vi.fn(() => '/test/chromium'))
vi.mock('node:fs/promises', () => ({ access: accessMock }))
vi.mock('playwright', () => ({ chromium: { executablePath: executablePathMock } }))

import { browserExecutablePath, checkBrowserReadiness } from './browser-readiness.ts'

beforeEach(() => { accessMock.mockReset(); executablePathMock.mockReset().mockReturnValue('/test/chromium') })

it('reports Chromium ready when the browser executable exists', async () => {
  accessMock.mockResolvedValue(undefined)
  expect(await checkBrowserReadiness()).toEqual({ available: true, message: 'Chromium 浏览器已就绪' })
})

it('offers a user-facing remedy without disclosing filesystem paths', async () => {
  accessMock.mockRejectedValue(new Error('ENOENT /test/chromium'))
  const status = await checkBrowserReadiness()
  expect(status.available).toBe(false)
  expect(status.message).toContain('请联系管理员')
  expect(status.message).not.toContain('/test/chromium')
})

it('uses the bundled Chromium path in packaged builds rather than the user cache', async () => {
  executablePathMock.mockReturnValue('/cache/ms-playwright/chromium-1243/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium')
  const expected = '/test/resources/playwright-browsers/chromium-1243/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'
  expect(browserExecutablePath(true, '/test/resources')).toBe(expected)
  accessMock.mockResolvedValue(undefined)
  await checkBrowserReadiness(true, '/test/resources')
  expect(accessMock).toHaveBeenCalledWith('/test/resources/playwright-browsers/chromium-1243/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', expect.any(Number))
})

it('recognizes the Windows Playwright browser layout', () => {
  executablePathMock.mockReturnValue('C:\\cache\\chromium-1243\\chrome-win64\\chrome.exe')
  expect(browserExecutablePath(true, '/test/resources')).toBe('/test/resources/playwright-browsers/chromium-1243/chrome-win64/chrome.exe')
})
