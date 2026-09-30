import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import type { GroupData, NdrRuntimeState } from 'nostr-double-ratchet'

export type FarmDiagnostics = {
  closed: boolean
  knownOwners: number
  active: number
  discoveryQueued: number
  deviceQueued: number
  reads: number
}

export type FarmDeviceSnapshot = {
  id: number
  owner: string
  state: NdrRuntimeState
  reads: number
  groups: Array<[string, GroupData]>
  messages: Array<[string, string]>
  receivedKeyHandoffs: Array<[string, string]>
  failures: string[]
}

export type FarmOperation = 'sendContact' | 'send' | 'start' | 'stop' | 'diagnostics' | 'directHandoffDiagnostics' | 'close'
export type FarmRequest = { requestId: number; operation: FarmOperation; device?: number; args: unknown[] }
export type FarmWorkerData = { memberCount: number; ownerOffset: number; url: string }
type WorkerMessage =
  | { type: 'ready'; owners: FarmDeviceSnapshot[][] }
  | { type: 'update'; devices: FarmDeviceSnapshot[] }
  | { type: 'reply'; requestId: number; result?: unknown; error?: string }
  | { type: 'failure'; error: string }

class FarmWorker {
  readonly worker: Worker
  readonly ready: Promise<GroupFarmProxy[][]>
  private readonly devices = new Map<number, GroupFarmProxy>()
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 0
  private failure?: Error
  private closing?: Promise<void>
  private resolveReady!: (owners: GroupFarmProxy[][]) => void
  private rejectReady!: (error: Error) => void

  constructor(data: FarmWorkerData) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.worker = new Worker(new URL('./group-runtime-worker.ts', import.meta.url), {
      workerData: data,
      // The farm uses TypeScript parameter properties. Native Node transforms
      // them without adding a test-only bundler or copying production modules.
      execArgv: ['--experimental-transform-types'],
    })
    this.worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'ready') {
        this.resolveReady(message.owners.map((owner) => owner.map((snapshot) => {
          const device = new GroupFarmProxy(this, snapshot)
          this.devices.set(snapshot.id, device)
          return device
        })))
      } else if (message.type === 'update') {
        for (const snapshot of message.devices) this.devices.get(snapshot.id)?.apply(snapshot)
      } else if (message.type === 'failure') {
        this.fail(new Error(message.error))
      } else {
        const request = this.pending.get(message.requestId)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(message.requestId)
        if (message.error) request.reject(new Error(message.error))
        else request.resolve(message.result)
      }
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.fail(new Error(`Group farm worker exited (${code})`)))
  }

  request<T>(operation: FarmOperation, device?: number, args: unknown[] = [], timeout = 180_000): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    const requestId = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Group farm ${operation} timed out for device ${device ?? 'all'}`))
      }, timeout)
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject, timer })
      this.worker.postMessage({ requestId, operation, device, args } satisfies FarmRequest)
    })
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { await this.request('close', undefined, [], 5_000) } catch { /* Terminate even a failed or busy worker. */ }
      finally {
        this.fail(new Error('Group farm closed'))
        await this.worker.terminate()
      }
    })()
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.rejectReady(error)
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}

export class GroupFarmProxy {
  readonly owner: string
  readonly groups = new Map<string, GroupData>()
  readonly messages = new Map<string, string>()
  readonly receivedKeyHandoffs = new Map<string, string>()
  readonly failures: string[] = []
  readonly storage = { reads: 0 }
  private state: NdrRuntimeState
  private readonly id: number

  constructor(private readonly worker: FarmWorker, snapshot: FarmDeviceSnapshot) {
    this.owner = snapshot.owner
    this.id = snapshot.id
    this.state = snapshot.state
    this.apply(snapshot)
  }

  apply(snapshot: FarmDeviceSnapshot): void {
    this.state = snapshot.state
    this.storage.reads = snapshot.reads
    for (const [id, group] of snapshot.groups) this.groups.set(id, group)
    for (const [id, body] of snapshot.messages) this.messages.set(id, body)
    for (const [id, sender] of snapshot.receivedKeyHandoffs) this.receivedKeyHandoffs.set(id, sender)
    this.failures.push(...snapshot.failures)
  }

  getState(): NdrRuntimeState { return structuredClone(this.state) }
  sendContact(owner: string, content: string): Promise<void> { return this.worker.request('sendContact', this.id, [owner, content]) }
  send(groupId: string, content: string): Promise<{ id: string; content: string }> { return this.worker.request('send', this.id, [groupId, content]) }
  start(): Promise<void> { return this.worker.request('start', this.id) }
  stop(): Promise<void> { return this.worker.request('stop', this.id) }
  diagnostics(): Promise<FarmDiagnostics> { return this.worker.request('diagnostics', this.id) }
  directHandoffDiagnostics(peer: GroupFarmProxy): Promise<Array<{ received: boolean; pending: boolean; knownAuthor: boolean }>> {
    if (peer.worker !== this.worker) throw new Error('Sibling diagnostics require devices in the same farm worker')
    return this.worker.request('directHandoffDiagnostics', this.id, [peer.id])
  }
}

export async function createParallelGroupFarm(memberCount: number, url: string) {
  const workers: FarmWorker[] = []
  const workerCount = Math.min(8, memberCount, Math.max(1, availableParallelism() - 2))
  const size = Math.ceil(memberCount / workerCount)
  const close = async () => { await Promise.all(workers.map((worker) => worker.close())) }
  try {
    for (let offset = 0; offset < memberCount; offset += size) {
      workers.push(new FarmWorker({ memberCount: Math.min(size, memberCount - offset), ownerOffset: offset, url }))
    }
    const owners = (await Promise.all(workers.map((worker) => worker.ready))).flat()
    return { owners, close, shardSize: size }
  } catch (error) {
    await close()
    throw error
  }
}
