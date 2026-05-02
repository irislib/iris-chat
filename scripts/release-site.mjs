import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolveHtreeCommand } from './hashtreePaths.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appDir = path.resolve(__dirname, '..')
const distDir = path.join(appDir, 'dist')
const defaultWorkerCompatibilityDate = '2026-03-26'
export const defaultSiteTreeName = 'iris-chat-site'

/**
 * @typedef {{
 *   dryRun: boolean
 *   skipCloudflare: boolean
 *   pagesOnly: boolean
 *   treeName: string
 *   branch: string | undefined
 *   pagesProject: string | undefined
 *   workerName: string | undefined
 *   routes: string[]
 *   domains: string[]
 *   workerCompatibilityDate: string
 * }} ReleaseOptions
 *
 * @typedef {{
 *   id: string
 *   label: string
 *   command: string[]
 *   cwd: string
 * }} ReleaseStep
 *
 * @typedef {{
 *   status: number
 *   stdout: string
 *   stderr: string
 * }} StepResult
 *
 * @typedef {{
 *   publish: { nhash: string, publishedRef: string }
 *   pagesUrl: string | null
 *   pagesProject: string | null
 *   workerName: string | null
 *   routes: string[]
 *   domains: string[]
 *   treeName: string
 * }} ReleaseResult
 */

const profile = {
  appName: 'Iris Chat',
  distDir: 'dist',
  // Keep the site tree separate from the htree git remote name.
  // Publishing both to the same mutable ref lets a later `git push origin master`
  // replace the released site with the raw repository contents.
  treeName: defaultSiteTreeName,
  defaultWorkerName: 'iris-chat',
  defaultDomains: ['chat.iris.to'],
}

/**
 * @param {string[]} args
 * @param {string} flag
 * @returns {string}
 */
function takeArgValue(args, flag) {
  const value = args.shift()
  if (!value) {
    throw new Error(`Missing value for ${flag}`)
  }
  return value
}

/**
 * @param {...string} args
 * @returns {string[]}
 */
function wranglerPagesCommand(...args) {
  return ['npx', 'wrangler@4', ...args]
}

/**
 * @param {...string} args
 * @returns {string[]}
 */
function wranglerWorkerCommand(...args) {
  return ['npx', 'wrangler@4', 'deploy', ...args]
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ReleaseOptions}
 */
export function parseArgs(argv, env = process.env) {
  const args = [...argv].filter((arg, index) => !(arg === '--' && index === 0))

  let pagesProject
  let workerName = env.CF_WORKER_NAME ?? profile.defaultWorkerName
  let treeName = profile.treeName
  let branch
  let dryRun = false
  let skipCloudflare = false
  let pagesOnly = false
  const routes = []
  const domains = []
  let workerCompatibilityDate = env.CF_WORKER_COMPATIBILITY_DATE ?? defaultWorkerCompatibilityDate

  while (args.length > 0) {
    const arg = args.shift()
    if (arg === '--') {
      continue
    }
    if (arg === '--pages-project') {
      pagesProject = takeArgValue(args, arg)
      continue
    }
    if (arg === '--worker-name') {
      workerName = takeArgValue(args, arg)
      continue
    }
    if (arg === '--tree') {
      treeName = takeArgValue(args, arg)
      continue
    }
    if (arg === '--route') {
      routes.push(takeArgValue(args, arg))
      continue
    }
    if (arg === '--domain') {
      domains.push(takeArgValue(args, arg))
      continue
    }
    if (arg === '--branch') {
      branch = takeArgValue(args, arg)
      continue
    }
    if (arg === '--compatibility-date') {
      workerCompatibilityDate = takeArgValue(args, arg)
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--skip-cloudflare' || arg === '--skip-pages') {
      skipCloudflare = true
      continue
    }
    if (arg === '--pages-only') {
      pagesOnly = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return {
    dryRun,
    skipCloudflare,
    pagesOnly,
    treeName,
    branch,
    pagesProject: pagesProject ?? env.CF_PAGES_PROJECT ?? undefined,
    workerName: pagesOnly ? undefined : workerName,
    routes,
    domains: pagesOnly ? [] : (domains.length > 0 ? domains : profile.defaultDomains),
    workerCompatibilityDate,
  }
}

/**
 * @param {ReleaseOptions} options
 * @returns {{steps: ReleaseStep[]}}
 */
export function createReleasePlan(options) {
  if (!options.skipCloudflare && !options.workerName && !options.pagesProject) {
    throw new Error('Missing Cloudflare target. Pass --worker-name, --pages-project, or set CF_WORKER_NAME / CF_PAGES_PROJECT.')
  }
  if (options.workerName && options.branch) {
    throw new Error('--branch is only supported for Pages deployments')
  }

  const steps = [
    {
      id: 'build',
      label: `Build ${profile.appName}`,
      command: ['pnpm', 'run', 'build'],
      cwd: appDir,
    },
    {
      id: 'test-portable',
      label: `Test ${profile.appName} portable config`,
      command: [
        'pnpm',
        'exec',
        'vitest',
        'run',
        'src/portableBuildConfig.test.ts',
        'src/releaseSiteConfig.test.ts',
        'src/staticAssetsWorker.test.ts',
        'src/lib/chat.invite.test.ts',
        'src/lib/chat.self-message.test.ts',
      ],
      cwd: appDir,
    },
    {
      id: 'test-smoke',
      label: `Smoke-test ${profile.appName} portable build`,
      command: ['pnpm', 'run', 'smoke:portable'],
      cwd: appDir,
    },
    {
      id: 'test-e2e-nip07',
      label: `E2E-test ${profile.appName} NIP-07 invite flow`,
      command: ['pnpm', 'exec', 'playwright', 'test', 'e2e/nip07.spec.ts'],
      cwd: appDir,
    },
    {
      id: 'publish',
      label: `Publish ${profile.appName} to hashtree`,
      command: resolveHtreeCommand('add', '.', '--publish', options.treeName),
      cwd: distDir,
    },
  ]

  if (!options.skipCloudflare) {
    const deployCommand = options.workerName
      ? wranglerWorkerCommand(
          '--keep-vars',
          '--name',
          options.workerName,
          '--compatibility-date',
          options.workerCompatibilityDate,
        )
      : (() => {
          if (!options.pagesProject) {
            throw new Error('Pages deployments require a project name')
          }
          return wranglerPagesCommand(
            'pages',
            'deploy',
            profile.distDir,
            '--project-name',
            options.pagesProject,
          )
        })()

    if (options.workerName) {
      for (const route of options.routes) {
        deployCommand.push('--route', route)
      }
      for (const domain of options.domains) {
        deployCommand.push('--domain', domain)
      }
    }
    if (options.pagesProject && options.branch) {
      deployCommand.push('--branch', options.branch)
    }

    steps.push({
      id: 'deploy',
      label: options.workerName
        ? `Deploy ${profile.appName} to Cloudflare Worker`
        : `Deploy ${profile.appName} to Cloudflare Pages`,
      command: deployCommand,
      cwd: appDir,
    })
  }

  return { steps }
}

/**
 * @param {ReleaseStep} step
 * @returns {Promise<StepResult>}
 */
function defaultRunner(step) {
  const [command, ...args] = step.command
  console.log(`\n==> ${step.label}`)
  console.log(`$ ${[command, ...args].join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: step.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) {
        const signalMessage = `Process exited with signal ${signal}\n`
        stderr += signalMessage
        process.stderr.write(signalMessage)
      }
      resolve({
        status: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

/**
 * @param {(path: import('node:fs').PathLike) => boolean} [buildOutputExists]
 */
function ensureDistExists(buildOutputExists = existsSync) {
  if (!buildOutputExists(distDir)) {
    throw new Error(`Build output directory not found: ${distDir}`)
  }
}

/**
 * @param {string} output
 * @returns {{nhash: string, publishedRef: string}}
 */
export function parsePublishOutput(output) {
  const nhashMatch = output.match(/nhash1[ac-hj-np-z02-9]+/i)
  if (!nhashMatch) {
    throw new Error('Publish succeeded but no nhash was found in htree output')
  }

  const publishedMatch = output.match(/^\s*published:\s+(\S+)\s*$/im)
  if (!publishedMatch) {
    throw new Error('Publish succeeded but no mutable ref was found in htree output')
  }

  return {
    nhash: nhashMatch[0],
    publishedRef: publishedMatch[1],
  }
}

/**
 * @param {string} output
 * @returns {string | null}
 */
function parsePagesOutput(output) {
  const pagesUrlMatch = output.match(/https:\/\/[^\s]+\.pages\.dev(?:\/[^\s]*)?/i)
  return pagesUrlMatch ? pagesUrlMatch[0] : null
}

/**
 * @param {ReleaseStep} step
 * @returns {boolean}
 */
function isReleaseStep(step) {
  return step.id === 'publish' || step.id === 'deploy'
}

/**
 * @param {ReleaseStep} step
 * @param {StepResult} result
 */
function assertStepSucceeded(step, result) {
  if (result.status !== 0) {
    throw new Error(`${step.label} failed with exit code ${result.status}`)
  }
}

/**
 * @param {ReleaseOptions} options
 * @param {(step: ReleaseStep) => StepResult | Promise<StepResult>} [runner]
 * @param {{ buildOutputExists?: (path: import('node:fs').PathLike) => boolean }} [hooks]
 * @returns {Promise<ReleaseResult | {dryRun: true, steps: ReleaseStep[]}>}
 */
export async function runRelease(options, runner = defaultRunner, hooks = {}) {
  const plan = createReleasePlan(options)
  const buildOutputExists = hooks.buildOutputExists ?? existsSync

  if (options.dryRun) {
    return { dryRun: true, steps: plan.steps }
  }

  let publishOutput = ''
  let deployOutput = ''
  const prereleaseSteps = plan.steps.filter((step) => !isReleaseStep(step))
  const releaseSteps = plan.steps.filter(isReleaseStep)

  for (const step of prereleaseSteps) {
    const result = await runner(step)
    assertStepSucceeded(step, result)
    if (step.id === 'build') {
      ensureDistExists(buildOutputExists)
    }
  }

  const releaseResults = await Promise.allSettled(
    releaseSteps.map((step) => Promise.resolve().then(() => runner(step))),
  )

  for (const [index, execution] of releaseResults.entries()) {
    const step = releaseSteps[index]
    if (execution.status === 'rejected') {
      throw execution.reason
    }
    const result = execution.value
    assertStepSucceeded(step, result)
    if (step.id === 'publish') {
      publishOutput = `${result.stdout}\n${result.stderr}`
    }
    if (step.id === 'deploy') {
      deployOutput = `${result.stdout}\n${result.stderr}`
    }
  }

  return {
    publish: parsePublishOutput(publishOutput),
    pagesUrl: deployOutput ? parsePagesOutput(deployOutput) : null,
    pagesProject: options.skipCloudflare || options.workerName ? null : options.pagesProject ?? null,
    workerName: options.skipCloudflare ? null : options.workerName ?? null,
    routes: options.skipCloudflare || !options.workerName ? [] : options.routes,
    domains: options.skipCloudflare || !options.workerName ? [] : options.domains,
    treeName: options.treeName,
  }
}

export function usage() {
  return `Usage: node ./scripts/release-site.mjs [options]

Build once, test the built output, then publish to hashtree and deploy that same
directory to Cloudflare Workers Static Assets or Cloudflare Pages in parallel.

Options:
  --worker-name <name>    Cloudflare Worker service name for static assets
  --pages-project <name>  Cloudflare Pages project name
  --tree <name>           hashtree mutable tree name override
  --route <pattern>       Worker route, for example chat.iris.to/*
  --domain <hostname>     Worker custom domain, for example chat.iris.to
  --branch <name>         Pages branch/preview deployment target
  --pages-only            disable the built-in/default Worker target and use Pages
  --compatibility-date    Worker compatibility date override
  --skip-cloudflare       publish to hashtree only
  --skip-pages            alias for --skip-cloudflare
  --dry-run               print planned steps without running them
`
}

/**
 * @param {ReleaseResult} result
 */
function printSummary(result) {
  console.log(`\n${profile.appName} release complete.`)
  console.log(`Hashtree immutable URL: htree://${result.publish.nhash}/index.html`)
  console.log(`Hashtree mutable URL: htree://${result.publish.publishedRef}`)
  console.log(`Hashtree owner URL: htree://${result.publish.publishedRef}`)
  if (result.workerName) {
    console.log(`Worker service: ${result.workerName}`)
  }
  for (const route of result.routes) {
    console.log(`Worker route: ${route}`)
  }
  for (const domain of result.domains) {
    console.log(`Worker custom domain: ${domain}`)
  }
  if (result.pagesProject) {
    console.log(`Pages project: ${result.pagesProject}`)
  }
  if (result.pagesUrl) {
    console.log(`Pages deployment: ${result.pagesUrl}`)
  }
  console.log(`Tree name: ${result.treeName}`)
}

function isMainModule() {
  if (!process.argv[1]) {
    return false
  }
  return path.resolve(process.argv[1]) === __filename
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const result = await runRelease(parsed)
  if ('dryRun' in result) {
    console.log(usage())
    for (const step of result.steps) {
      console.log(`${step.label}: ${step.command.join(' ')} (cwd: ${step.cwd})`)
    }
  } else {
    printSummary(result)
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
