import { test, expect } from './fixtures'
import { nip19 } from 'nostr-tools'

for (const mobile of [false, true]) for (const group of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} ${group ? 'group' : 'direct'} previews keep chat rows in place`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Go', exact: true }).click()
    const back = page.getByRole('button', { name: 'Back', exact: true })
    const input = page.getByPlaceholder('Type a message...')
    // Both identities are synthetic, and every websocket uses the fixture's local relay.
    for (const key of ['c', 'd']) {
      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
      await page.getByPlaceholder('Paste invite link').fill(nip19.npubEncode(key.repeat(64)))
      await expect(input).toBeVisible()
      if (mobile) await back.click()
    }
    if (group) {
      await page.getByRole('button', { name: 'New Chat', exact: true }).click()
      await page.getByRole('button', { name: 'Create Group', exact: true }).click()
      await page.getByTestId('create-group-member').first().click()
      await page.getByTestId('create-group-next').click()
      await page.getByPlaceholder('Enter group name...').fill('Preview layout')
      await page.getByTestId('create-group-submit').click()
      await expect(input).toBeVisible()
    } else if (mobile) {
      await page.getByTestId('chat-list-row').first().getByRole('button').click()
      await expect(input).toBeVisible()
    }
    const chatUrl = page.url()
    const rows = page.getByTestId('chat-list-row')
    const geometry = () => rows.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect()
      return { height: box.height, y: box.y }
    }))
    for (const scale of [1, 1.5]) {
      await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px` }, scale)
      if (mobile) await back.click()
      await expect(rows).toHaveCount(group ? 3 : 2)
      const baseline = await geometry()
      expect(baseline.every(row => row.height > 0)).toBe(true)
      for (const text of ['Short preview', 'A preview that wraps onto another line. '.repeat(5), 'One\nTwo\nThree\nHello 👋 🎉']) {
        if (mobile) await page.goto(chatUrl)
        await input.fill(text)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        await expect(input).toHaveValue('')
        if (mobile) await back.click()
        await expect(rows.first()).toContainText(text.startsWith('One') ? 'One' : text.slice(0, 13))
        await expect.poll(geometry).toEqual(baseline)
      }
      await page.screenshot({ path: testInfo.outputPath(`chat-previews-${scale}.png`) })
      if (mobile) await page.goto(chatUrl)
    }
  })
}
