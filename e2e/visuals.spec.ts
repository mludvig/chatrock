import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp, newChat, request, assertFits } from './ux.helpers'
import { renderChart } from '../backend/src/lib/visuals/chart'
import { renderHtml, type RawBubble } from '../backend/src/lib/transcript'
import { visualDocument, validateVisual, type VisualArtifact } from '../shared/visuals'

// Model inference is tested in <local-profile>. These recorded real results exercise the
// deployed client with test credentials without running paid inference in <local-profile>.
const generated = JSON.parse(readFileSync(join(__dirname, '../docs/research/visual-artifacts-2026-10-22/results.json'), 'utf8')) as Array<{ visual: VisualArtifact }>
const pipeline = JSON.parse(readFileSync(join(__dirname, '../docs/research/visual-artifacts-2026-10-22/full-pipeline.json'), 'utf8')) as { events: Array<{ type: string; visual?: VisualArtifact }> }
const visuals = [
  ...(['bar', 'line', 'pie'] as const).map(type => renderChart(`${type} chart`, {
    type, labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', values: [10, 15, 12, 20] }], unit: 'USD thousands',
  })),
  ...generated.map(r => validateVisual(r.visual)),
  validateVisual(pipeline.events.find(e => e.type === 'tool_result' && e.visual)!.visual),
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

    const road = page.locator('.visual-card').filter({ hasText: 'Why the inside of an uphill bend feels steeper' })
    const inner = road.frameLocator('iframe').frameLocator('iframe')
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
    const organic = page.locator('.visual-card').filter({ hasText: 'Why the inside of an uphill curve feels steeper' })
    const organicInner = organic.frameLocator('iframe').frameLocator('iframe')
    await expect(organicInner.locator('#runnerGrade')).toHaveText('6.79%')
    await organicInner.locator('#offset').evaluate(el => {
      (el as HTMLInputElement).value = '-3.5'; el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(organicInner.locator('#runnerGrade')).toHaveText('5.37%')
    await page.reload()
    await expect(page.locator('.visual-card')).toHaveCount(7)
    await expect(inner.locator('#ig')).toHaveText('5.769%')
    await expect(organicInner.locator('#runnerGrade')).toHaveText('6.79%')
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 })
      await assertFits(page, '.visual-card')
      await expect.poll(() => inner.locator('html').evaluate(el => el.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await expect.poll(() => organicInner.locator('html').evaluate(el => el.scrollWidth <= window.innerWidth + 1)).toBe(true)
    }
    await page.setViewportSize({ width: 1440, height: 1050 })
    await road.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.screenshots/2026-10-22-uphill-road-visual.jpg' })
  } finally {
    await request(page, 'DELETE', `/chats/${chatId}`)
  }
})

test('public visual wrapper supports interaction and blocks generated code from app storage and network', async ({ page }) => {
  await openApp(page)
  const attempted: string[] = []
  await page.route('https://invalid.example/**', route => { attempted.push(route.request().url()); return route.abort() })
  const visual: VisualArtifact = {
    title: 'Isolation check', summary: 'Synthetic browser test', format: 'html', height: 300,
    source: `<button id="add">Add</button><output id="count">0</output><output id="access">blocked</output>
<script>let n=0;document.getElementById('add').onclick=()=>document.getElementById('count').textContent=++n;
try{window.top.localStorage.getItem('visualTest');document.getElementById('access').textContent='escaped'}catch{}
fetch('https://invalid.example/fetch').catch(()=>{});let i=new Image();i.src='https://invalid.example/image';
try{window.top.location='https://invalid.example/top'}catch{};window.open('https://invalid.example/popup');
</script>`,
  }
  const bubble: RawBubble = { msgId: 'v', parentId: null, role: 'assistant', model: '', createdAt: '',
    steps: [{ kind: 'tool', toolUseId: 'v', name: 'create_visual', input: '{}', visual }] }
  await page.route('**/s/visual-browser-test', route => route.fulfill({ contentType: 'text/html', body: renderHtml([bubble], { title: 'Public visual' }) }))
  await page.goto('/s/visual-browser-test')
  const inner = page.frameLocator('iframe').frameLocator('iframe')
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
