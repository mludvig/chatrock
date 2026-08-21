/**
 * Regression guard for the header/composer redesign
 * (docs/adr/0028-composer-owns-per-send-controls.md): every control must be laid out fully
 * inside the viewport at both 390px and 1440px, not merely reachable behind a scroll.
 */
import { test, expect, type Page } from '@playwright/test'

const MOBILE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth }
  })
  expect(overflow.scrollW).toBeLessThanOrEqual(overflow.clientW + 1)
}

// Every header/composer control must be fully inside the viewport — the original bug was
// controls being laid out past the right edge where they can't be tapped.
async function assertAllControlsReachable(page: Page) {
  const sel = '.chat-header button, .chat-header .project-chip, .composer-toolbar > *'
  const boxes = await page.locator(sel).evaluateAll(els =>
    els.map(el => {
      const r = el.getBoundingClientRect()
      return { cls: el.className, left: r.left, right: r.right, w: r.width }
    }),
  )
  expect(boxes.length).toBeGreaterThan(0)
  const vw = page.viewportSize()!.width
  for (const b of boxes) {
    expect.soft(b.left, `${b.cls} starts off-screen left`).toBeGreaterThanOrEqual(0)
    expect.soft(b.right, `${b.cls} extends past the right edge`).toBeLessThanOrEqual(vw)
  }
}

test.describe('redesigned chrome', () => {
  test('mobile: single header row, all controls reachable', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    // The global header is off-screen (folded into the drawer) until the hamburger is tapped.
    const globalHeaderBox = await page.locator('.sidebar-global-header').boundingBox()
    expect(globalHeaderBox!.x).toBeLessThan(0)

    // Only the chat header occupies chrome: it starts at the top of the app.
    const headerBox = await page.locator('.chat-header').boundingBox()
    expect(headerBox!.y).toBeLessThanOrEqual(1)

    await expect(page.locator('.btn-hamburger')).toBeVisible()
    await expect(page.locator('.btn-header-new-chat')).toBeVisible()
    await expect(page.locator('.chat-header .btn-icon[title="Chat details"]')).toBeVisible()

    // Composer toolbar carries the per-send controls.
    await expect(page.locator('.composer-toolbar .composer-select').first()).toBeVisible()
    await expect(page.locator('select[title^="Research depth"]')).toBeVisible()
    await expect(page.locator('.composer-toolbar .btn-private-toggle')).toBeVisible()

    // "Deep", not "Deep Research".
    const depthLabels = await page.locator('select[title^="Research depth"] option').allTextContents()
    expect(depthLabels).toEqual(['Brief', 'Extended', 'Deep'])

    await assertNoHorizontalOverflow(page)
    await assertAllControlsReachable(page)
    await page.screenshot({ path: '.screenshots/2026-08-22-mobile-new-chat.png' })

    // Drawer: global header slides in with the rail + panel.
    await page.locator('.btn-hamburger').click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.waitForTimeout(400) // slide transition
    const openBox = await page.locator('.sidebar-global-header').boundingBox()
    expect(openBox!.x).toBeGreaterThanOrEqual(0)
    await expect(page.locator('.search-input')).toBeVisible()
    await page.screenshot({ path: '.screenshots/2026-08-22-mobile-drawer.png' })
  })

  test('mobile: header stays on screen while the composer is focused', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })

    await page.locator('.message-input').fill('Tell me about ...')
    await page.locator('.message-input').focus()
    await page.waitForTimeout(300)

    const headerBox = await page.locator('.chat-header').boundingBox()
    expect(headerBox!.y).toBeGreaterThanOrEqual(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    await page.screenshot({ path: '.screenshots/2026-08-22-mobile-focused.png' })
  })

  test('mobile: a long project name cannot push the controls off-screen', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    // Inject a chat-header project chip with a pathologically long name (same markup the
    // real chip renders) and confirm the cap + ellipsis hold.
    await page.evaluate(() => {
      const chip = document.createElement('span')
      chip.className = 'project-chip'
      chip.textContent = 'ADHD and Rejection Sensitive Dysphoria Recognition and Other Very Long Words'
      document.querySelector('.chat-header h2')!.after(chip)
    })
    const chipBox = await page.locator('.chat-header .project-chip').boundingBox()
    expect(chipBox!.width).toBeLessThanOrEqual(121)
    await assertNoHorizontalOverflow(page)
    await assertAllControlsReachable(page)
    await page.screenshot({ path: '.screenshots/2026-08-22-mobile-long-project.png' })
  })

  test('mobile: the project picker is icon-only until a project is chosen', async ({ page }) => {
    await page.setViewportSize(MOBILE)
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    const wrap = page.locator('.project-picker-wrap')
    await expect(wrap).toHaveClass(/is-empty/)
    await expect(page.locator('.project-picker-icon')).toBeVisible()
    expect((await wrap.boundingBox())!.width).toBeLessThanOrEqual(34)

    // Choosing a project spends width on its (ellipsised) name instead.
    const picker = page.locator('.project-picker')
    const firstProject = await picker.locator('option').nth(1).getAttribute('value')
    await picker.selectOption(firstProject!)
    await expect(wrap).not.toHaveClass(/is-empty/)
    await expect(page.locator('.project-picker-icon')).toHaveCount(0)
    expect((await wrap.boundingBox())!.width).toBeGreaterThan(34)

    await assertNoHorizontalOverflow(page)
    await assertAllControlsReachable(page)
    await page.screenshot({ path: '.screenshots/2026-08-22-mobile-project-picked.png' })
  })

  test('desktop: header is lean, composer owns the per-send controls', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/c/new')
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    await expect(page.locator('.sidebar-global-header')).toBeVisible()
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.btn-hamburger')).toBeHidden()
    await expect(page.locator('.btn-header-new-chat')).toBeHidden()

    // Nothing per-send left in the header.
    await expect(page.locator('.chat-header .composer-select')).toHaveCount(0)
    await expect(page.locator('.chat-header .btn-private-toggle')).toHaveCount(0)
    await expect(page.locator('.composer-toolbar .composer-select').first()).toBeVisible()

    await assertNoHorizontalOverflow(page)
    await assertAllControlsReachable(page)
    await page.screenshot({ path: '.screenshots/2026-08-22-desktop-new-chat.png' })
  })

  test('models render from cache on a reload (no empty picker)', async ({ page }) => {
    await page.setViewportSize(DESKTOP)
    await page.goto('/c/new')
    await expect(page.locator('.composer-toolbar .composer-select').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState('networkidle')

    // Second load: block GET /api/models entirely. The picker must still be populated
    // from the localStorage cache.
    await page.route('**/api/models', route => route.abort())
    await page.reload()
    const modelSelect = page.locator('.composer-toolbar .composer-select').first()
    await expect(modelSelect).toBeVisible({ timeout: 15_000 })
    const optionCount = await modelSelect.locator('option').count()
    expect(optionCount).toBeGreaterThan(1)
  })
})
