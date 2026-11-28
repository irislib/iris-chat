import { TextEncoder as NodeTextEncoder } from 'node:util'

// jsdom has no TextEncoder. Node's encoder returns bytes from Node's realm;
// browser crypto correctly requires bytes from the active browser realm.
globalThis.TextEncoder = class extends NodeTextEncoder {
  override encode(input?: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(super.encode(input))
  }
}
