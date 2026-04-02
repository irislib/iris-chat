import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const appDir = path.resolve(__dirname, '..')

/**
 * @param {Array<string | null | undefined>} candidates
 * @param {(candidate: string) => boolean} [predicate]
 * @returns {string | null}
 */
function firstExistingPath(candidates, predicate = existsSync) {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (predicate(candidate)) return candidate
  }
  return null
}

export function resolveHashtreeRepoRoot() {
  return firstExistingPath(
    [
      process.env.HASHTREE_REPO_ROOT,
      path.join(appDir, 'hashtree'),
    ],
    (candidate) => existsSync(path.join(candidate, 'rust', 'Cargo.toml')),
  )
}

export function resolveHashtreeRustDir() {
  const hashtreeRepoRoot = resolveHashtreeRepoRoot()
  return firstExistingPath(
    [
      process.env.HASHTREE_RUST_DIR,
      hashtreeRepoRoot ? path.join(hashtreeRepoRoot, 'rust') : null,
      path.join(appDir, 'rust'),
    ],
    (candidate) => existsSync(path.join(candidate, 'Cargo.toml')),
  )
}

/**
 * @param {...string} args
 * @returns {string[]}
 */
export function resolveHtreeCommand(...args) {
  if (process.env.HTREE_BIN) {
    return [process.env.HTREE_BIN, ...args]
  }

  const rustDir = resolveHashtreeRustDir()
  if (rustDir) {
    return [
      'cargo',
      'run',
      '--manifest-path',
      path.join(rustDir, 'Cargo.toml'),
      '-p',
      'hashtree-cli',
      '--bin',
      'htree',
      '--',
      ...args,
    ]
  }

  return ['htree', ...args]
}
