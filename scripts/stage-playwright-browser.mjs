import { access, cp, mkdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { chromium } from 'playwright'

const targetPlatform = process.argv[2]
if (targetPlatform && targetPlatform !== process.platform) {
  throw new Error(`当前系统为 ${process.platform}，无法把本机 Chromium 打进 ${targetPlatform} 安装包；请在目标系统上打包。`)
}

const executablePath = chromium.executablePath()
await access(executablePath, constants.F_OK).catch(() => {
  throw new Error('未安装与当前 Playwright 版本匹配的 Chromium。请先运行 npx playwright install chromium。')
})

let sourceRoot = dirname(executablePath)
while (!/^chromium-\d+$/.test(basename(sourceRoot))) {
  const parent = dirname(sourceRoot)
  if (parent === sourceRoot) throw new Error('无法识别 Playwright Chromium 的安装目录')
  sourceRoot = parent
}

const stagingRoot = resolve('.bundled-browsers')
await rm(stagingRoot, { recursive: true, force: true })
await mkdir(stagingRoot, { recursive: true })
await cp(sourceRoot, join(stagingRoot, basename(sourceRoot)), { recursive: true })
console.log(`已准备随包 Chromium：${basename(sourceRoot)}（${process.platform}/${process.arch}）`)
