// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { createReleasePlan, defaultSiteTreeName, parseArgs } from '../scripts/release-site.mjs'

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
    expect(publishStep?.command).not.toContain('iris-chat')
  })
})
