// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { createReleasePlan, defaultSiteTreeName, parseArgs, runRelease } from '../scripts/release-site.mjs'

describe('release site config', () => {
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
    expect(publishStep?.command[0]).toBe('htree')
    expect(publishStep?.command).not.toContain('--manifest-path')
    expect(publishStep?.command).not.toContain('iris-chat')
    expect(portableTestStep?.command).toContain('src/lib/chat.invite.test.ts')
    expect(portableTestStep?.command).toContain('src/lib/chat.self-message.test.ts')
    expect(plan.steps.find((step) => step.id === 'test-e2e-nip07')?.command).toEqual([
      'pnpm',
      'exec',
      'playwright',
      'test',
      'e2e/nip07.spec.ts',
    ])
  })

  it('runs hashtree publish and Cloudflare deploy in parallel after tests', async () => {
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
      'test-e2e-nip07',
      'publish',
      'deploy',
    ])
    expect(maxActiveReleaseSteps).toBe(2)
  })

  it('retries a soft-failed hashtree file-server upload and rejects retry errors', async () => {
    const calls: { id: string; command: string[] }[] = []
    const options = {
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
    }
    const runner = async (step: { id: string; command: string[] }) => {
      calls.push(step)
      if (step.id === 'publish') {
        return {
          status: 0,
          stdout: 'published: npub1example/iris-chat-site\nnhash1ace',
          stderr: 'file server push failed: temporary upload failure',
        }
      }
      if (step.id === 'push') {
        return { status: 0, stdout: 'Uploaded: 3, Skipped: 0, Errors: 0', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }

    await runRelease(options, runner, { buildOutputExists: () => true })

    expect(calls.at(-1)).toEqual({
      id: 'push',
      label: 'Retry Iris Chat file-server upload',
      command: ['htree', 'push', 'nhash1ace', '--force'],
      cwd: expect.any(String),
    })

    await expect(runRelease(options, async (step) => {
      const result = await runner(step)
      return step.id === 'push'
        ? { status: 0, stdout: 'Uploaded: 2, Skipped: 0, Errors: 1', stderr: '' }
        : result
    }, { buildOutputExists: () => true })).rejects.toThrow(
      'Retry Iris Chat file-server upload completed with file-server errors',
    )
  })
})
