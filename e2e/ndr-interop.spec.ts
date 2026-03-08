import { test, expect } from './fixtures'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const NDR_CWD = path.resolve(__dirname, '../../nostr-double-ratchet/rust')
const NDR_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function createNdrDataDir(relayUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndr-interop-'))
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ relays: [relayUrl] })
  )
  return dir
}

async function runNdr(args: string[], dataDir: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cargo',
      [
        'run',
        '-q',
        '-p',
        'ndr',
        '--',
        '--json',
        '--data-dir',
        dataDir,
        ...args,
      ],
      {
        cwd: NDR_CWD,
        env: { ...process.env, NOSTR_PREFER_LOCAL: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ndr failed: code=${code} stdout=${stdout} stderr=${stderr}`))
        return
      }

      const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          resolve(JSON.parse(lines[i]))
          return
        } catch {
          // ignore non-json lines
        }
      }

      reject(new Error(`ndr produced no json output: stdout=${stdout} stderr=${stderr}`))
    })
  })
}

async function runNdrRetry(
  args: string[],
  dataDir: string,
  timeoutMs: number,
  intervalMs: number
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  // NDR may race against Iris publishing its public invite on fresh logins.
  // Retry for a bit to avoid flakes.
  while (true) {
    try {
      return await runNdr(args, dataDir)
    } catch (e) {
      if (Date.now() >= deadline) throw e
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
}

function startNdrListen(dataDir: string) {
  const child = spawn(
    'cargo',
    ['run', '-q', '-p', 'ndr', '--', '--json', '--data-dir', dataDir, 'listen'],
    {
      cwd: NDR_CWD,
      env: { ...process.env, NOSTR_PREFER_LOCAL: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  const reader = readline.createInterface({ input: child.stdout })
  return { child, reader }
}

async function waitForNdrJson(
  reader: readline.Interface,
  predicate: (value: any) => boolean,
  timeoutMs: number
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for ndr output'))
    }, timeoutMs)

    const onLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: any
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return
      }
      if (predicate(parsed)) {
        cleanup()
        resolve(parsed)
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      reader.off('line', onLine)
    }

    reader.on('line', onLine)
  })
}

async function stopNdrListen(child: ReturnType<typeof startNdrListen>['child']) {
  child.kill('SIGINT')
  await new Promise((resolve) => {
    child.on('close', resolve)
  })
}

test('iris-chat <-> ndr interop', async ({ page, testRelayUrl }) => {
  test.setTimeout(240000)

  const dataDir = createNdrDataDir(testRelayUrl)
  let listener: ReturnType<typeof startNdrListen> | null = null

  try {
    const login = await runNdr(['login', NDR_SECRET], dataDir)
    expect(login.status).toBe('ok')

    const created = await runNdr(['invite', 'create'], dataDir)
    expect(created.status).toBe('ok')
    const inviteUrl: string | undefined = created.data?.url
    expect(inviteUrl).toBeTruthy()

    await page.goto('/')
    await page.getByRole('button', { name: 'Go' }).click()

    await page.getByRole('button', { name: 'New Chat' }).click()

    listener = startNdrListen(dataDir)
    await waitForNdrJson(
      listener.reader,
      (json) => json.command === 'listen' && json.status === 'ok',
      10000
    )

    await page.getByPlaceholder('Paste invite link').fill(inviteUrl!)

    const createdSession = await waitForNdrJson(
      listener.reader,
      (json) => json.event === 'session_created' && typeof json.chat_id === 'string',
      60000
    )

    const irisMessage = 'hello from iris'
    await page.getByPlaceholder('Type a message...').fill(irisMessage)
    await page.getByRole('button', { name: 'Send' }).click()

    await waitForNdrJson(
      listener.reader,
      (json) => json.event === 'message' && json.content === irisMessage,
      30000
    )

    const ndrMessage = 'hello from ndr'
    await runNdrRetry(['send', createdSession.chat_id, ndrMessage], dataDir, 30000, 500)

    await expect(
      page.locator('.max-w-\\[85\\%\\]').filter({ hasText: ndrMessage })
    ).toBeVisible({ timeout: 30000 })
  } finally {
    if (listener) {
      await stopNdrListen(listener.child)
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
