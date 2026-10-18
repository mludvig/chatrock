import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp, newChat, request, assertFits } from './ux.helpers'
import { renderChart } from '../backend/src/lib/visuals/chart'
import { renderHtml, type RawBubble } from '../backend/src/lib/transcript'
import { visualDocument, validateVisual, VISUAL_HOST_SCRIPT, type VisualArtifact } from '../shared/visuals'

// Recorded model outputs exercise the deployed client with test credentials
// without running paid inference in the deployment account.
const recorded = JSON.parse(readFileSync(join(__dirname, 'fixtures/visual-artifacts.json'), 'utf8')) as VisualArtifact[]
const visuals = [
  ...(['bar', 'line', 'pie'] as const).map(type => renderChart(`${type} chart`, {
    type, labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', values: [10, 15, 12, 20] }], unit: 'USD thousands',
  })),
  ...recorded.map(visual => validateVisual(visual)),
]

test('response style persists and chat overrides remain available', async ({ page }) => {
  await openApp(page)
  const original = await request<{ preferences: Record<string, unknown> }>(page, 'GET', '/preferences')
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('combobox', { name: 'Response style', exact: true }).selectOption('standard')
    await expect.poll(async () => (await request<{ preferences: { responseStyle?: string } }>(page, 'GET', '/preferences')).preferences.responseStyle).toBe('standard')
    await page.reload()
    if (!await page.locator('.prefs-panel').isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Response style', exact: true })).toHaveValue('standard')
    await page.getByTitle('Chat details', { exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Response style' })).toHaveValue('standard')
    await page.getByRole('dialog').getByRole('combobox', { name: 'Response style' }).selectOption('concise-visual')
    await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Response style' })).toHaveValue('concise-visual')
    await page.getByRole('dialog').getByText('Advanced tools', { exact: true }).click()
    await expect(page.getByRole('dialog').getByText('Image generation', { exact: true })).toHaveCount(0)
  } finally {
    await request(page, 'PUT', '/preferences', original.preferences)
  }
})

test('recorded charts and specialist visuals render, interact, download and survive reload', async ({ page }) => {
  await openApp(page)
  const { chatId } = await newChat(page)
  const bubbles = visuals.map((visual, i) => ({
    msgId: `visual-${i}`, parentId: null, role: 'assistant', model: visual.model ?? 'deterministic',
    createdAt: new Date().toISOString(), siblingIndex: 1, siblingCount: 1, siblings: [`visual-${i}`],
    steps: [{ kind: 'tool', toolUseId: `call-${i}`, name: 'create_visual', input: '{}', result: 'Created', visual }],
  }))
  await page.route(`**/api/chats/${chatId}/messages**`, route => route.fulfill({
    json: { bubbles, conversationUsage: { inputTokens: 0, outputTokens: 0 }, hasMore: false, oldestMsgId: null, streaming: false },
  }))
  try {
    await page.goto(`/c/${chatId}`)
    await expect(page.locator('.visual-card')).toHaveCount(7)
    const bar = page.locator('.visual-card').filter({ hasText: 'bar chart' })
    await bar.getByText('Data (USD thousands)', { exact: true }).click()
    await expect(bar.locator('tbody tr')).toHaveCount(4)
    await expect(bar.locator('tbody tr').last()).toContainText('20')
    const downloaded = page.waitForEvent('download')
    await bar.getByRole('button', { name: 'Download' }).click()
    expect((await downloaded).suggestedFilename()).toBe('bar-chart.svg')
    await bar.getByRole('button', { name: 'Expand' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').frameLocator('iframe').frameLocator('iframe').locator('svg')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()

    const road = page.locator('.visual-card').nth(5)
    const inner = road.frameLocator('iframe').frameLocator('iframe')
    // Visible without clicking Expand; height follows the whole document.
    await expect(road.locator('iframe')).toBeVisible()
    await expect.poll(() => road.locator('iframe').evaluate(f => f.clientHeight)).toBeGreaterThan(visuals[5].height)
    const originalHeight = await road.locator('iframe').evaluate(f => f.clientHeight)
    await inner.locator('details summary').click()
    await expect.poll(() => road.locator('iframe').evaluate(f => f.clientHeight)).toBeGreaterThan(originalHeight)
    await inner.locator('details summary').click()
    await expect.poll(() => road.locator('iframe').evaluate(f => f.clientHeight)).toBe(originalHeight)
    await page.evaluate(() => window.postMessage({ type: 'chatrock:visual-size', channel: 'spoof', height: 19000 }, '*'))
    await expect.poll(() => road.locator('iframe').evaluate(f => f.clientHeight)).toBe(originalHeight)
    await expect(inner.locator('#ig')).toHaveText('5.769%')
    await expect(inner.locator('#og')).toHaveText('4.412%')
    await expect(inner.locator('#verdict')).toContainText('30.769%')
    const set = async (id: string, value: number) => inner.locator(`#${id}`).evaluate((el, v) => {
      (el as HTMLInputElement).value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
    await set('a', 120)
    await expect(inner.locator('#ig')).toHaveText('5.769%')
    await expect(inner.locator('#rise')).toContainText('3.142')
    await set('r', 60)
    await expect(inner.locator('#ig')).toHaveText('5.357%')
    await expect(inner.locator('#verdict')).toContainText('14.286%')
    await set('p', 0)
    await expect(inner.locator('#verdict')).toContainText('Both level')
    await expect(inner.locator('#ig')).toHaveText('0.000%')
    await road.getByRole('button', { name: 'Replay' }).click()
    await expect(inner.locator('#ig')).toHaveText('5.769%')
    const organic = page.locator('.visual-card').nth(6)
    const organicInner = organic.frameLocator('iframe').frameLocator('iframe')
    expect(await organicInner.getByRole('slider').count()).toBeGreaterThanOrEqual(3)
    const initialText = await organicInner.locator('body').innerText()
    await organicInner.getByRole('slider').first().evaluate(el => {
      const input = el as HTMLInputElement
      input.value = input.value === input.min ? input.max : input.min
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect.poll(() => organicInner.locator('body').innerText()).not.toBe(initialText)
    await page.reload()
    await expect(page.locator('.visual-card')).toHaveCount(7)
    await expect(inner.locator('#ig')).toHaveText('5.769%')
    await expect(organicInner.locator('body')).toHaveText(initialText, { useInnerText: true })
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertFits(page, '.visual-card')
      await expect.poll(() => inner.locator('html').evaluate(el => el.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await expect.poll(() => organicInner.locator('html').evaluate(el => el.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await expect.poll(() => inner.locator('body').evaluate(el => el.scrollHeight <= window.innerHeight + 1)).toBe(true)
      await expect.poll(() => organicInner.locator('body').evaluate(el => el.scrollHeight <= window.innerHeight + 1)).toBe(true)
    }
    await page.setViewportSize({ width: 1440, height: 1050 })
    await road.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.screenshots/2026-10-22-uphill-road-visual.jpg' })
  } finally {
    await request(page, 'DELETE', `/chats/${chatId}`)
  }
})

test('HTML conversation download uses the authenticated export without creating a public share', async ({ page }) => {
  await openApp(page)
  const { chatId } = await newChat(page)
  try {
    await page.goto(`/c/${chatId}`)
    await page.getByTitle('Chat details', { exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Share', exact: true }).click()
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download HTML', exact: true }).click()
    const downloaded = await pending
    expect(downloaded.suggestedFilename()).toMatch(/\.html$/)
    const stream = await downloaded.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const html = Buffer.concat(chunks).toString('utf8')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Saved conversation')
    expect((await request<{ shares: unknown[] }>(page, 'GET', `/chats/${chatId}/shares`)).shares).toEqual([])
  } finally {
    await request(page, 'DELETE', `/chats/${chatId}`)
  }
})

test('portrait SVG keeps readable typography in wide cards, expanded views and HTML exports', async ({ page }) => {
  const portrait: VisualArtifact = {
    title: 'Planning timeline', summary: 'Three stages with readable labels.', format: 'svg', height: 800,
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 925" width="100%" role="img">
<title>Planning timeline</title><rect width="320" height="925" rx="12" fill="#f5f7fb"/>
<text id="heading" x="16" y="36" font-size="18">Planning timeline</text>
<text x="16" y="68" font-size="13">An overview of three stages.</text>
<rect x="16" y="100" width="288" height="180" rx="8" fill="#e8efff"/>
<text x="28" y="132" font-size="14">Stage 1: preparation</text>
<rect x="16" y="340" width="288" height="180" rx="8" fill="#e8efff"/>
<text x="28" y="372" font-size="14">Stage 2: transition</text>
<rect x="16" y="600" width="288" height="180" rx="8" fill="#e8efff"/>
<text x="28" y="632" font-size="14">Stage 3: review</text>
<text id="last" x="16" y="940" font-size="13">End of timeline</text></svg>`,
  }
  await openApp(page)
  const { chatId } = await newChat(page)
  const bubble: RawBubble = { msgId: 'portrait', parentId: null, role: 'assistant', model: 'test', createdAt: '',
    steps: [{ kind: 'tool', toolUseId: 'portrait', name: 'create_visual', input: '{}', visual: portrait }] }
  await page.route(`**/api/chats/${chatId}/messages**`, route => route.fulfill({
    json: { bubbles: [bubble], conversationUsage: { inputTokens: 0, outputTokens: 0 }, hasMore: false, streaming: false },
  }))
  const checkSize = async (container: ReturnType<typeof page.locator>, nativeSize: boolean) => {
    const inner = container.frameLocator('iframe').frameLocator('iframe')
    await expect(inner.locator('svg')).toBeVisible()
    await expect.poll(() => inner.locator('svg').evaluate(svg => svg.getBoundingClientRect().width)).toBeLessThanOrEqual(320)
    if (nativeSize) {
      await expect.poll(() => inner.locator('svg').evaluate(svg => svg.getBoundingClientRect().width)).toBe(320)
      await expect.poll(() => container.locator('iframe').evaluate(f => f.clientHeight)).toBeGreaterThan(964)
    }
    // Content beyond the authored viewBox is visible, including text descenders.
    await expect.poll(() => inner.locator('#last').evaluate(el => {
      const svg = el.closest('svg')!.getBoundingClientRect()
      return el.getBoundingClientRect().bottom <= svg.bottom && svg.bottom <= innerHeight
    })).toBe(true)
    await expect.poll(() => inner.locator('body').evaluate(el => el.scrollHeight <= innerHeight + 1)).toBe(true)
  }
  try {
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.goto(`/c/${chatId}`)
    const card = page.locator('.visual-card')
    await checkSize(card, true)
    const inner = card.frameLocator('iframe').frameLocator('iframe')
    const heading = await inner.locator('#heading').evaluate(el => {
      const text = el as SVGGraphicsElement
      return parseFloat(getComputedStyle(text).fontSize) * text.getScreenCTM()!.a
    })
    expect(heading).toBeCloseTo(18, 1)
    await card.getByRole('button', { name: 'Expand' }).click()
    await checkSize(page.getByRole('dialog'), true)
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await page.reload()
    await checkSize(card, true)
    await page.screenshot({ path: '.screenshots/2026-10-23-svg-portrait-sizing.jpg' })
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertFits(page, '.visual-card')
      await checkSize(card, false)
    }
    await page.route('**/s/portrait-test', route => route.fulfill({
      contentType: 'text/html', body: renderHtml([bubble], { title: 'Planning example', shared: false }),
    }))
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.goto('/s/portrait-test')
    await checkSize(page.locator('.visual'), true)
  } finally {
    await page.goto('/c/new') // restore the app before the authenticated cleanup
    await request(page, 'DELETE', `/chats/${chatId}`)
  }
})

test('public visual wrapper supports interaction and blocks generated code from app storage and network', async ({ page }) => {
  await openApp(page)
  const attempted: string[] = []
  await page.route('https://invalid.example/**', route => { attempted.push(route.request().url()); return route.abort() })
  const visual: VisualArtifact = {
    title: 'Isolation check', summary: 'Synthetic browser test', format: 'html', height: 300,
    source: `<button id="add">Add</button><output id="count">0</output><output id="access">blocked</output><div style="height:1100px"></div>
<script>let n=0;document.getElementById('add').onclick=()=>document.getElementById('count').textContent=++n;
try{window.top.localStorage.getItem('visualTest');document.getElementById('access').textContent='escaped'}catch{}
fetch('https://invalid.example/fetch').catch(()=>{});let i=new Image();i.src='https://invalid.example/image';
try{window.top.location='https://invalid.example/top'}catch{};window.open('https://invalid.example/popup');
</script>`,
  }
  const bubble: RawBubble = { msgId: 'v', parentId: null, role: 'assistant', model: '', createdAt: '',
    steps: [{ kind: 'tool', toolUseId: 'v', name: 'create_visual', input: '{}', visual }] }
  // The first measurement can precede the host script in a long transcript.
  // Delaying host setup reproduces that race; its handshake must recover sizing.
  const html = renderHtml([bubble], { title: 'Public visual' }).replace(
    `<script>${VISUAL_HOST_SCRIPT}</script>`, `<script>setTimeout(()=>{${VISUAL_HOST_SCRIPT}},500)</script>`,
  )
  await page.route('**/s/visual-browser-test', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('/s/visual-browser-test')
  const inner = page.frameLocator('iframe').frameLocator('iframe')
  await expect.poll(() => page.locator('.visual iframe').evaluate(f => f.clientHeight)).toBeGreaterThan(1100)
  await expect.poll(() => inner.locator('body').evaluate(e => e.scrollHeight <= innerHeight + 1)).toBe(true)
  await inner.getByRole('button', { name: 'Add' }).click()
  await expect(inner.locator('#count')).toHaveText('1')
  await expect(inner.locator('#access')).toHaveText('blocked')
  // Own-frame navigation is constrained by the trusted outer document too.
  await inner.locator('#count').evaluate(() => { window.location.href = 'https://invalid.example/self' })
  await expect.poll(() => page.frames().some(f => f.url().includes('chrome-error'))).toBe(true)
  expect(attempted).toEqual([])
  expect(page.context().pages()).toHaveLength(1)
  expect(page.url()).toContain('/s/visual-browser-test')
  expect(visualDocument(visual)).toContain("frame-src about:")
})

test('SVG sizing runs trusted code while CSP blocks source scripts', async ({ page }) => {
  await openApp(page)
  // Bypass source validation only in this fixture to exercise the CSP boundary.
  const visual: VisualArtifact = {
    title: 'SVG isolation', summary: 'Trusted sizing only.', format: 'svg', height: 300,
    source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100">
<text id="status" x="12" y="140" font-size="18">Passive graphics</text>
<script>document.querySelector('#status').textContent='Executed source script'</script></svg>`,
  }
  expect(() => validateVisual(visual)).toThrow('passive')
  const channel = 'svg-isolation-test'
  const body = `<iframe data-visual-channel="${channel}" sandbox="allow-scripts" style="width:400px;height:300px;border:0" srcdoc="${visualDocument(visual, channel).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe><script>${VISUAL_HOST_SCRIPT}</script>`
  await page.route('**/s/svg-isolation-test', route => route.fulfill({ contentType: 'text/html', body }))
  await page.goto('/s/svg-isolation-test')
  const inner = page.frameLocator('iframe').frameLocator('iframe')
  await expect(inner.locator('#status')).toHaveText('Passive graphics')
  await expect.poll(() => inner.locator('svg').evaluate(s => s.viewBox.baseVal.height)).toBeGreaterThan(140)
  await expect.poll(() => inner.locator('#status').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
})
