#!/usr/bin/env node
// Opt-in physical iPhone + fresh Chrome test using the deployed public servers.
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

process.umask(0o077)
const native = process.env.IRIS_CHAT_RS_DIR
const phone = process.env.IRIS_LINK_TEST_UDID
if (!native || !phone) throw new Error('Set IRIS_CHAT_RS_DIR and IRIS_LINK_TEST_UDID explicitly')
const helper = path.resolve(native, 'scripts/run_public_link_phone.py')
if (!fs.existsSync(helper)) throw new Error('The selected native checkout needs run_public_link_phone.py')
const run = path.resolve('work/public-device-link', randomUUID())
fs.mkdirSync(run, { recursive: true, mode: 0o700 })
const diagnostics = []
const errors = []
const record = entry => { if (diagnostics.length < 1000) diagnostics.push({ at: Date.now(), ...entry }) }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
let childResult
let phoneLog
let passed = false
let phoneExit = null
let relays = []
try {
  const context = await browser.newContext()
  if (process.env.IRIS_LINK_TEST_FIPS_SEEDS) {
    const servers = process.env.IRIS_LINK_TEST_FIPS_SEEDS.split(',')
    if (servers.some(url => !url.startsWith('wss://'))) throw new Error('Use public secure FIPS servers')
    await context.addInitScript(servers => localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers })), servers)
  }
  if (process.env.IRIS_LINK_TEST_SEEDLESS === '1') await context.addInitScript(() =>
    localStorage.setItem('iris-chat-call-servers', JSON.stringify({ servers: [], stunServers: ['stun:stun.l.google.com:19302'] })))
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (/deviceSync|FIPS|WebRTC|TCP|connection/i.test(message.text()))
      record({ level: message.type(), text: message.text().slice(0, 1500) })
  })
  page.on('websocket', socket => {
    record({ socket: socket.url(), state: 'open' })
    socket.on('socketerror', error => record({ socket: socket.url(), error }))
    socket.on('close', () => record({ socket: socket.url(), state: 'closed' }))
  })
  await page.goto(process.env.IRIS_LINK_TEST_URL || 'https://chat.iris.to/')
  const continueInBrowser = page.getByRole('button', { name: 'Continue in browser', exact: true })
  await expect(continueInBrowser).toBeVisible({ timeout: 15_000 })
  await continueInBrowser.click()
  await page.getByRole('button', { name: 'Link this device', exact: true }).click()
  const code = page.locator('button[title^="nostrconnect://"]')
  await expect(code).toBeVisible()
  const uri = await code.getAttribute('title')
  relays = new URL(uri).searchParams.getAll('relay')
  if (!relays.length || relays.some(url => !url.startsWith('wss://')))
    throw new Error('This test requires the public message servers')
  const body = `Public phone link history ${randomUUID()}`
  const input = path.join(run, 'input.json')
  fs.writeFileSync(input, JSON.stringify({ run, uri, body }), { mode: 0o600 })
  console.log(`Private evidence: ${run}`)
  const child = spawn('python3', [helper, input], { cwd: path.resolve(native), stdio: ['ignore', 'pipe', 'pipe'] })
  phoneLog = fs.createWriteStream(path.join(run, 'phone.log'), { mode: 0o600 })
  child.stdout.on('data', data => phoneLog.write(data))
  child.stderr.on('data', data => phoneLog.write(data))
  childResult = new Promise(resolve => {
    child.once('error', error => { errors.push(error.message); resolve(-1) })
    child.once('close', resolve)
  })
  try {
    await expect(page.getByRole('button', { name: 'New Chat', exact: true })).toBeVisible({ timeout: 185_000 })
    console.log('Browser signed in; checking history')
    const chat = page.getByTestId('sidebar-chat-list').getByRole('button').filter({ hasText: body })
    await expect(chat).toBeVisible({ timeout: 90_000 })
    await chat.click()
    await expect(page.getByTestId('message-bubble-body').filter({ hasText: body })).toHaveCount(1)
    await page.screenshot({ path: path.join(run, 'linked-history.png'), fullPage: true })
    await page.reload()
    await chat.click()
    await expect(page.getByTestId('message-bubble-body').filter({ hasText: body })).toHaveCount(1)
    console.log('Pre-link history survives reload exactly once')
    passed = true
  } catch (error) {
    fs.writeFileSync(path.join(run, 'browser-failure.txt'), `${error}\n${await page.locator('body').innerText()}`)
    await page.screenshot({ path: path.join(run, 'browser-failure.png'), fullPage: true })
    throw error
  }
} catch (error) {
  errors.push(String(error))
  console.error('Public device link/history test failed; see private evidence')
} finally {
  if (childResult) phoneExit = await childResult
  if (phoneLog) await new Promise(resolve => phoneLog.end(resolve))
  const result = { passed: passed && phoneExit === 0, phoneExit, relays, errors }
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(run, 'browser-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
  await browser.close()
  console.log(result.passed ? 'Public device linking and durable history passed' : `Failed; evidence: ${run}`)
  process.exitCode = result.passed ? 0 : 1
}
