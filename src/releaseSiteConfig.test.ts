import { fileURLToPath } from 'node:url'
// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createReleasePlan, defaultSiteTreeName, parseArgs, runRelease } from '../scripts/release-site.mjs'

describe('release site config', () => {
  beforeEach(() => {
    vi.stubEnv('HTREE_BIN', 'htree')
    vi.stubEnv('IRIS_NATIVE_RELEASE_GATE', fileURLToPath(import.meta.url))
  })
  afterEach(() => vi.unstubAllEnvs())

  it('uses a dedicated mutable tree for the published site by default', () => {
    const parsed = parseArgs([])

    expect(defaultSiteTreeName).toBe('iris-chat-site')
    expect(parsed.treeName).toBe(defaultSiteTreeName)
    expect(parsed.treeName).not.toBe('iris-chat')
  })

  it('publishes the release plan to the configured site tree', () => {
    const plan = createReleasePlan({
      dryRun: false,
      skipCloudflare: true,
      pagesOnly: false,
      treeName: defaultSiteTreeName,
      branch: undefined,
      pagesProject: undefined,
      workerName: undefined,
      routes: [],
      domains: [],
      workerCompatibilityDate: '2026-03-26',
    })

    const publishStep = plan.steps.find((step) => step.id === 'publish')
    const portableTestStep = plan.steps.find((step) => step.id === 'test-portable')

    expect(plan.steps[0]).toMatchObject({
      id: 'install',
      command: ['pnpm', 'install', '--frozen-lockfile'],
    })
    expect(publishStep?.command).toContain(defaultSiteTreeName)
    expect(publishStep?.command[0]).toBe(process.execPath)
    expect(publishStep?.command.slice(-2)).toEqual(['--htree', 'htree'])
    expect(publishStep?.command).not.toContain('--manifest-path')
    expect(publishStep?.command).not.toContain('iris-chat')
    expect(portableTestStep?.command.slice(0, 2)).toEqual(['pnpm', 'test'])
    expect(portableTestStep?.command).toContain('src/lib/chat.invite.test.ts')
    expect(portableTestStep?.command).toContain('src/lib/chat.self-message.test.ts')
    expect(portableTestStep?.command).toContain('src/lib/messageMutationHistory.test.ts')
    expect(portableTestStep?.command).toContain('src/lib/privateRuntimeInitialization.test.ts')
    expect(portableTestStep?.command).toContain('src/lib/deviceSyncTcp.test.ts')
    expect(plan.steps.find((step) => step.id === 'test-e2e-nip07')?.command).toEqual([
      'pnpm',
      'exec',
      'playwright',
      'test',
      'e2e/private-key-login.spec.ts',
      'e2e/nip07.spec.ts',
      'e2e/contact-memory.spec.ts',
      'e2e/private-contact-sync.spec.ts',
      'e2e/web-join.spec.ts',
      'e2e/direct-file-first.spec.ts',
      'e2e/peer-attachments.spec.ts',
      'e2e/message-mutations.spec.ts',
      'e2e/link-device.spec.ts',
      'e2e/invite-roleplay.spec.ts',
      'e2e/composer-identity.spec.ts',
      'e2e/composer-completions.spec.ts',
      'e2e/timed-mute.spec.ts',
      'e2e/notification-navigation.spec.ts',
      'e2e/sw-push-handler.spec.ts',
      'e2e/device-removal.spec.ts',
      '--workers=2',
      '--retries=0',
    ])
  })

  it('uses an explicitly configured publisher binary', () => {
    vi.stubEnv('HTREE_BIN', '/configured/htree')
    const plan = createReleasePlan(parseArgs([]))
    expect(plan.steps.find((step) => step.id === 'publish')?.command.slice(-2)).toEqual(['--htree', '/configured/htree'])
  })

  it('runs native Hashtree publish before Cloudflare deploy after tests', async () => {
    let activeReleaseSteps = 0
    let maxActiveReleaseSteps = 0
    const calls: string[] = []

    await runRelease(
      {
        dryRun: false,
        skipCloudflare: false,
        pagesOnly: false,
        treeName: defaultSiteTreeName,
        branch: undefined,
        pagesProject: undefined,
        workerName: 'iris-chat',
        routes: [],
        domains: ['chat.iris.to'],
        workerCompatibilityDate: '2026-03-26',
      },
      async (step) => {
        calls.push(step.id)
        if (step.id === 'publish' || step.id === 'deploy') {
          activeReleaseSteps += 1
          maxActiveReleaseSteps = Math.max(maxActiveReleaseSteps, activeReleaseSteps)
          await new Promise((resolve) => setTimeout(resolve, 10))
          activeReleaseSteps -= 1
          if (step.id === 'publish') {
            return {
              status: 0,
              stdout: 'published: npub1example/iris-chat-site\nnhash1ace',
              stderr: '',
            }
          }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      {
        buildOutputExists: () => true,
      },
    )

    expect(calls).toEqual([
      'install',
      'build',
      'test-portable',
      'test-smoke',
      'test-graph',
      'test-relay-policy',
      'test-e2e-nip07',
      'publish',
      'deploy',
    ])
    expect(maxActiveReleaseSteps).toBe(1)
  })

  it('leaves Cloudflare untouched when the native publish reports upload errors', async () => {
    const calls: string[] = []
    await expect(runRelease(parseArgs([]), async (step) => {
      calls.push(step.id)
      return step.id === 'publish'
        ? {
            status: 0,
            stdout: 'published: npub1example/iris-chat-site\nnhash1ace',
            stderr: 'file server push failed: temporary upload failure',
          }
        : { status: 0, stdout: '', stderr: '' }
    }, { buildOutputExists: () => true })).rejects.toThrow('reported file-server errors')
    expect(calls.at(-1)).toBe('publish')
    expect(calls).not.toContain('deploy')
  })
})
