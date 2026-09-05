/**
 * End-to-end test: Deep Research as a run_research_task sub-agent tool
 * (docs/adr/0039-deep-research-as-a-sub-agent-tool.md).
 *
 * Deep Research is no longer a separate durable system — setting research depth to
 * "Deep" on an ordinary turn is enough to unlock the run_research_task tool. This drives
 * one for real: the orchestrator should fire one or more run_research_task calls (shown
 * as ordinary tool pills, labelled "Research: <question>"), narrate live progress while
 * they're pending, and land a final synthesised answer — no plan-approval gate, no
 * separate research panel.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { test, expect } from '@playwright/test'
import { FAST_MODEL_LABEL } from './testConfig'

const question = readFileSync(join(__dirname, '..', 'research-question.tmp'), 'utf-8').trim()

test('a Deep-depth turn runs run_research_task and lands a final answer', async ({ page }) => {
  test.setTimeout(900_000) // matches the ws-sendMessage Lambda's own 900s ceiling (docs/adr/0039)

  await page.goto('/c/new')
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 10_000 })

  await page.locator('.model-picker').selectOption({ label: FAST_MODEL_LABEL })
  await page.locator('select[title^="Research depth"]').selectOption('deep')

  await page.locator('.message-input').fill(question)
  await page.locator('.btn-send').click()

  await page.waitForURL(/\/c\/(?!new)[^/]+$/, { timeout: 30_000 })
  await expect(page.locator('.message.user', { hasText: question })).toBeVisible({ timeout: 10_000 })

  // The orchestrator's run_research_task call(s) render as ordinary tool pills — no
  // separate research panel exists anymore.
  // The orchestrator often streams a chunk of its own preamble text before its first
  // tool_use block ever starts — give that room rather than treating it as a failure.
  const researchPill = page.locator('.tool-pill', { hasText: 'Research:' }).first()
  await expect(researchPill).toBeVisible({ timeout: 180_000 })

  // The wall-clock deadline banner only shows for a Deep turn, and only while it's
  // actually in flight.
  await expect(page.getByText(/Researching — answer by/)).toBeVisible({ timeout: 10_000 })

  // `.btn-stop` (bound to the store's per-chat sending flag) is the reliable "whole turn
  // finished" signal — text/tool-use steps come and go well before the turn itself is done.
  await expect(page.locator('.btn-stop')).toHaveCount(0, { timeout: 700_000 })

  const assistantBubble = page.locator('.message.assistant').last()
  await expect(assistantBubble).toBeVisible()
  await expect(researchPill).not.toHaveClass(/pending/)

  // The finished turn — the research pill and the answer — persists across reload,
  // since nothing about it lives only in the WebSocket stream.
  await page.reload()
  await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.tool-pill', { hasText: 'Research:' }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.message.assistant').last()).toBeVisible({ timeout: 15_000 })
})
