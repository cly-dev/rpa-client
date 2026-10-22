import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const graph = resolve('src/graph')
const runner = resolve('src/runner')

export default defineConfig(({ mode }) => {
  const envFile = { development: '.dev', test: '.dev.test', production: '.dev.prod' }[mode]
  if (!envFile) throw new Error(`不支持的构建环境：${mode}；请使用 development、test 或 production`)
  const filePath = resolve(envFile)
  let fileEnv: Record<string, string>
  try { fileEnv = parseEnv(readFileSync(filePath, 'utf8')) }
  catch { throw new Error(`无法读取 ${envFile}，请先创建对应环境文件`) }
  const serviceUrl = (process.env.VITE_RPA_SERVICE_URL || fileEnv.VITE_RPA_SERVICE_URL)?.trim()
  if (!serviceUrl) throw new Error(`缺少 ${envFile} 中的 VITE_RPA_SERVICE_URL，请填写服务端地址`)
  let parsed: URL
  try { parsed = new URL(serviceUrl) }
  catch { throw new Error(`VITE_RPA_SERVICE_URL 不是有效 URL：${serviceUrl}`) }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname.replace(/\/+$/, '') !== '/api/v1' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('VITE_RPA_SERVICE_URL 必须是以 /api/v1 结尾的 HTTP(S) 地址，且不能包含查询、片段或账号密码')
  }
  if (mode === 'production' && (
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    /(^|\.)example\.(com|net|org)$|\.invalid$/i.test(parsed.hostname)
  )) {
    throw new Error('生产环境不能使用本机或示例地址，请设置其他电脑可访问的真实 RPA 服务地址')
  }
  process.env.VITE_RPA_SERVICE_URL = serviceUrl.replace(/\/+$/, '')
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: { '@graph': graph, '@runner': runner },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
    },
    renderer: {
      resolve: {
        alias: { '@graph': graph, '@runner': runner },
      },
      server: {
        fs: {
          allow: [resolve('.')],
        },
      },
      plugins: [react()],
    },
  }
})
