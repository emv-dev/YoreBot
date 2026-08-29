import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageNames = [
  '@janhq/assistant-extension',
  '@janhq/conversational-extension',
  '@janhq/download-extension',
  '@janhq/llamacpp-upstream-extension',
  '@janhq/rag-extension',
  '@janhq/vector-db-extension',
]

const expected = packageNames
  .map((name) => {
    const directory = name.slice(name.indexOf('/') + 1)
    const manifestPath = resolve(root, 'extensions', directory, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const archiveName = `${name.slice(1).replace('/', '-')}-${manifest.version}.tgz`
    return archiveName
  })
  .sort()

const bundleDirectory = resolve(root, 'pre-install')
const actual = existsSync(bundleDirectory)
  ? readdirSync(bundleDirectory)
      .filter((name) => name.endsWith('.tgz'))
      .sort()
  : []

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error('Unexpected Windows extension bundle inventory')
  console.error(`Expected: ${expected.join(', ')}`)
  console.error(`Actual: ${actual.join(', ') || '(empty)'}`)
  process.exitCode = 1
} else {
  console.log(`Verified Windows extension bundle: ${actual.join(', ')}`)
}
