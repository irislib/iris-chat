import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

export type NativeEvent = { type: string; id?: string; peer?: string; device?: string;
  transferredBytes?: number; files?: { bytes: string; sha256: string; path: string }[];
  requestId?: number; value?: any; error?: string }

let build: Promise<string> | undefined
export function buildNativeDirectFiles(): Promise<string> {
  return build ??= (async () => {
    const core = process.env.IRIS_CHAT_RS_CORE_DIR
    if (!core || !existsSync(path.join(core, 'src/core/direct_file_tcp.rs'))) {
      throw new Error('IRIS_CHAT_RS_CORE_DIR must select the native direct-file implementation')
    }
    const target = process.env.IRIS_DIRECT_FILES_TARGET_DIR ?? path.join(core, 'target')
    const args = ['build', '--quiet', '--locked', '--manifest-path', 'test-fixtures/direct-files-rust/Cargo.toml', '--target-dir', target]
    await new Promise<void>((resolve, reject) => {
      const process = spawn('cargo', args, { env: { ...globalThis.process.env,
        IRIS_CHAT_RS_CORE_DIR: path.resolve(core), CARGO_INCREMENTAL: '0', CARGO_BUILD_JOBS: globalThis.process.env.CARGO_BUILD_JOBS ?? '2' } })
      let output = ''
      process.stdout.on('data', data => { output = (output + data).slice(-16000) })
      process.stderr.on('data', data => { output = (output + data).slice(-16000) })
      process.once('error', reject)
      process.once('exit', code => code === 0 ? resolve() : reject(new Error(`Native fixture build failed: ${output}`)))
    })
    return path.join(target, 'debug', globalThis.process.platform === 'win32' ? 'iris-chat-direct-files-fixture.exe' : 'iris-chat-direct-files-fixture')
  })()
}

/** Encrypted chat envelopes come from the test NDR device. File bytes use Rust. */
export class NativeDirectFiles {
  readonly events: NativeEvent[] = []
  readonly directory = mkdtempSync(path.join(tmpdir(), 'iris-direct-file-interop-'))
  readonly ready: Promise<NativeEvent>
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private requestId = 0
  private stderr = ''

  constructor(binary: string, seed: string, deviceSecret: Uint8Array) {
    mkdirSync(path.join(this.directory, 'received'))
    this.process = spawn(binary, [seed, this.directory, Buffer.from(deviceSecret).toString('hex')])
    this.ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: this.process.stdout })
      lines.on('line', line => {
        let event: NativeEvent
        try { event = JSON.parse(line) } catch { reject(new Error(`Unexpected fixture output: ${line}`)); return }
        if (event.type === 'ready') resolve(event)
        else if (event.type === 'reply') {
          const waiter = this.pending.get(event.requestId!)
          this.pending.delete(event.requestId!)
          if (event.error) waiter?.reject(new Error(event.error))
          else waiter?.resolve(event.value)
        } else this.events.push(event)
      })
      this.process.once('error', reject)
      this.process.once('exit', code => {
        const error = new Error(`Native fixture exited (${code}): ${this.stderr}`)
        reject(error)
        for (const waiter of this.pending.values()) waiter.reject(error)
      })
    })
    this.process.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-16000) })
  }
  async command(op: string, values: Record<string, unknown> = {}): Promise<any> {
    await this.ready
    const requestId = ++this.requestId
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.process.stdin.write(JSON.stringify({ op, requestId, ...values }) + '\n')
    })
  }
  async close(): Promise<void> {
    this.process.stdin.end()
    if (this.process.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => this.process.kill('SIGKILL'), 5000)
        this.process.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
    rmSync(this.directory, { recursive: true, force: true })
  }
}
