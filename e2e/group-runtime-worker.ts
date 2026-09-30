import { parentPort, workerData } from 'node:worker_threads'
import { setImmediate, clearImmediate } from 'node:timers'
import { createGroupFarm, type GroupFarmDevice } from './group-runtime-farm.ts'
import type { FarmDeviceSnapshot, FarmRequest, FarmWorkerData } from './parallel-group-runtime-farm.ts'

const port = parentPort!
const data = workerData as FarmWorkerData
const previous = new Map<number, {
  groups: Map<string, unknown>
  messages: Map<string, string>
  handoffs: Map<string, string>
  failures: number
}>()
let scheduled: ReturnType<typeof setImmediate> | undefined
let devices: GroupFarmDevice[] = []
const dirty = new Set<number>()

function snapshot(device: GroupFarmDevice, id: number): FarmDeviceSnapshot {
  const old = previous.get(id) ?? { groups: new Map(), messages: new Map(), handoffs: new Map(), failures: 0 }
  const groups = [...device.groups].filter(([key, value]) => old.groups.get(key) !== value)
  const messages = [...device.messages].filter(([key, value]) => old.messages.get(key) !== value)
  const receivedKeyHandoffs = [...device.receivedKeyHandoffs].filter(([key, value]) => old.handoffs.get(key) !== value)
  for (const [key, value] of groups) old.groups.set(key, value)
  for (const [key, value] of messages) old.messages.set(key, value)
  for (const [key, value] of receivedKeyHandoffs) old.handoffs.set(key, value)
  const failures = device.failures.slice(old.failures)
  old.failures = device.failures.length
  previous.set(id, old)
  return { id, owner: device.owner, state: device.getState(), reads: device.storage.reads, groups, messages, receivedKeyHandoffs, failures }
}

function flush(): void {
  if (scheduled) clearImmediate(scheduled)
  scheduled = undefined
  if (!dirty.size) return
  const updates = [...dirty].map((id) => snapshot(devices[id]!, id))
  dirty.clear()
  port.postMessage({ type: 'update', devices: updates })
}

function changed(id: number): void {
  dirty.add(id)
  scheduled ??= setImmediate(flush)
}

try {
  const owners = await createGroupFarm(data.memberCount, data.url, data.ownerOffset)
  devices = owners.flat()
  for (const [id, device] of devices.entries()) device.onChange = () => changed(id)
  let nextId = 0
  port.postMessage({ type: 'ready', owners: owners.map((owner) => owner.map((device) => snapshot(device, nextId++))) })

  port.on('message', async (request: FarmRequest) => {
    try {
      if (request.operation === 'close') {
        for (const device of devices) device.onChange = undefined
        await Promise.all(devices.map((device) => device.stop()))
        if (scheduled) clearImmediate(scheduled)
        port.postMessage({ type: 'reply', requestId: request.requestId })
        port.close()
        return
      }
      const device = devices[request.device!]
      if (!device) throw new Error(`Unknown farm device ${request.device}`)
      let result: unknown
      switch (request.operation) {
        case 'sendContact': result = await device.sendContact(String(request.args[0]), String(request.args[1])); break
        case 'send': result = await device.send(String(request.args[0]), String(request.args[1])); break
        case 'start': result = await device.start(); break
        case 'stop': result = await device.stop(); break
        case 'diagnostics': result = await device.diagnostics(); break
        case 'directHandoffDiagnostics': {
          const peer = devices[Number(request.args[0])]
          if (!peer) throw new Error('Unknown sibling device')
          result = await device.directHandoffDiagnostics(peer)
          break
        }
        default: throw new Error(`Unknown farm operation ${request.operation}`)
      }
      dirty.add(request.device!)
      flush()
      port.postMessage({ type: 'reply', requestId: request.requestId, result })
    } catch (error) {
      flush()
      port.postMessage({ type: 'reply', requestId: request.requestId, error: String(error) })
    }
  })
} catch (error) {
  port.postMessage({ type: 'failure', error: String(error) })
  for (const device of devices) device.stop()
  port.close()
}
