import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDir = resolve(import.meta.dirname, '..')
const buildDir = join(projectDir, 'build')
const source = join(buildDir, 'source-favicon.ico')
const temporary = await mkdtemp(join(tmpdir(), 'rpa-app-icons-'))
const iconset = join(temporary, 'App.iconset')

async function resize(input, size, output) {
  await run('sips', ['-z', String(size), String(size), input, '--out', output])
}

function encodeIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    directory.writeUInt8(size === 256 ? 0 : size, entry)
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([directory, ...images.map(({ png }) => png)])
}

try {
  await mkdir(iconset, { recursive: true })
  const base = join(temporary, 'source.png')
  await run('sips', ['-s', 'format', 'png', source, '--out', base])
  const iconsetSizes = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ]
  for (const [size, name] of iconsetSizes) await resize(base, size, join(iconset, name))
  await run('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])

  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const images = []
  for (const size of icoSizes) {
    const file = join(temporary, `windows-${size}.png`)
    await resize(base, size, file)
    images.push({ size, png: await readFile(file) })
  }
  await writeFile(join(buildDir, 'icon.ico'), encodeIco(images))
  await resize(base, 256, join(buildDir, 'icon-preview.png'))
  console.log(`Generated ${join(buildDir, 'icon.icns')} and ${join(buildDir, 'icon.ico')}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
