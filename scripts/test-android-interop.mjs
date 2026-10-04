import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(script), '..')
const args = process.argv.slice(2)
let result
if (args[0] === '--reserved') {
  if (!process.env.IRIS_CHAT_RS_ANDROID_SERIAL) throw new Error('Android allocation is missing')
  result = spawnSync('pnpm', ['exec', 'playwright', 'test', 'e2e/iris-chat-rs-android-interop.spec.ts',
    '--project=chromium', '--workers=1', '--retries=0', ...args.slice(1)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, IRIS_CHAT_RS_ANDROID_INTEROP: 'reserved' },
  })
} else {
  const lab = process.env.IRIS_NATIVE_LAB_SCRIPT ?? path.resolve(root, '../iris-chat-rs/scripts/native_lab.py')
  if (!existsSync(lab)) throw new Error('Set IRIS_NATIVE_LAB_SCRIPT to the native test resource coordinator')
  result = spawnSync('python3', [lab, 'run', '--resource', 'iris-chat-web-android-interop',
    '--health', `android:${process.env.IRIS_CHAT_RS_ANDROID_SERIAL || 'auto'}`,
    '--allocation-env', 'android=IRIS_CHAT_RS_ANDROID_SERIAL', '--timeout', '900',
    '--result', path.join(root, 'work/android-interop/lab-result.json'),
    '--', process.execPath, script, '--reserved', ...args], { cwd: root, stdio: 'inherit' })
}
if (result.error) throw result.error
process.exitCode = result.status ?? 1
