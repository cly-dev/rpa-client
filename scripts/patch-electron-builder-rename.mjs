import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const electronBuilderRoot = dirname(require.resolve('electron-builder/package.json'))
const target = require.resolve('app-builder-lib/out/util/electronGet.js', { paths: [electronBuilderRoot] })
const source = await readFile(target, 'utf8')
const marker = 'RPA_WINDOWS_RENAME_RETRY'

if (source.includes(marker)) {
  console.log('electron-builder Windows 重命名重试补丁已存在')
  process.exit(0)
}

const needle = '        await fs.rename(tmpDir, dir);'
if (!source.includes(needle)) {
  throw new Error(`无法应用 electron-builder 重命名补丁：未找到目标代码。依赖版本可能已变化：${target}`)
}

const replacement = `        // ${marker}: antivirus and editor watchers can briefly lock freshly extracted files on Windows.
        let renameError;
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                await fs.rename(tmpDir, dir);
                renameError = undefined;
                break;
            }
            catch (error) {
                const code = error == null ? undefined : error.code;
                if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(code)) {
                    throw error;
                }
                renameError = error;
                const delay = 500 * (attempt + 1);
                builder_util_1.log.warn({ attempt: attempt + 1, delay, code }, "Windows temporarily locked the Electron staging directory; retrying rename");
                await new Promise(resolve => setTimeout(resolve, delay));
                await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }).catch(() => undefined);
            }
        }
        if (renameError != null) {
            throw renameError;
        }`

await writeFile(target, source.replace(needle, replacement))
console.log('已为 electron-builder 启用 Windows 重命名重试')
