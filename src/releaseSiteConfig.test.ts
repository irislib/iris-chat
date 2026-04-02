// @vitest-environment node

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { createReleasePlan, defaultSiteTreeName, parseArgs, runRelease } from '../scripts/release-site.mjs'

const distDir = path.resolve(__dirname, '../dist')

async function withDistFixture(run: () => Promise<void>) {
  fs.mkdirSync(distDir, { recursive: true })
  try {
    await run()
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true })
  }
}

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

    expect(publishStep?.command).toContain(defaultSiteTreeName)
    expect(publishStep?.command[0]).toBe('htree')
    expect(publishStep?.command).not.toContain('--manifest-path')
    expect(publishStep?.command).not.toContain('iris-chat')
  })

  it('runs hashtree publish and Cloudflare deploy in parallel after tests', async () => {
    let activeReleaseSteps = 0
    let maxActiveReleaseSteps = 0
    const calls: string[] = []

    await withDistFixture(async () => {
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
      )
    })

    expect(calls).toEqual(['build', 'test-portable', 'test-smoke', 'publish', 'deploy'])
    expect(maxActiveReleaseSteps).toBe(2)
  })
})
