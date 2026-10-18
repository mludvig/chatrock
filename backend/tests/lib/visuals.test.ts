jest.mock('../../src/lib/bedrock', () => ({ converseOnce: jest.fn() }))
import { converseOnce } from '../../src/lib/bedrock'
import { executeCreateVisualTool } from '../../src/lib/visuals/tool'
import { renderChart, validateChart } from '../../src/lib/visuals/chart'
import { VISUAL_MODEL, isValidModelId } from '../../src/config/models'
import { validateVisual, type VisualArtifact } from '../../../shared/visuals'

const once = converseOnce as jest.Mock
const ctx = { sub: 'test-user', chatId: 'test-chat', modelId: 'small-narrator' }
const output = { format: 'svg', summary: 'A to B.', source: '<svg viewBox="0 0 100 100"><title>Flow</title><text>A → B</text></svg>', height: 300 }
beforeEach(() => once.mockReset())

test('numeric charts have exact geometry, signed values, and inspectable data without a model call', async () => {
  const chart = { type: 'bar' as const, labels: ['A', 'B', 'C'], series: [{ name: 'Amount', values: [-10, 0, 20] }], unit: 'USD' }
  const result = await executeCreateVisualTool({ title: 'Revenue', brief: 'Compare the values', chart }, ctx)
  expect(result.isError).toBe(false)
  expect(once).not.toHaveBeenCalled()
  expect(result.visual?.chart).toEqual(chart)
  const bars = [...result.visual!.source.matchAll(/<rect data-value="([^"]+)" x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"/g)]
  expect(bars.map(b => Number(b[1]))).toEqual([-10, 0, 20])
  expect(Number(bars[0][3])).toBeCloseTo(260 / 3)
  expect(Number(bars[1][3])).toBe(0)
  expect(Number(bars[2][3])).toBeCloseTo(520 / 3)
})

test('line charts place data points at exact coordinates; pie handles a single whole slice', () => {
  const line = renderChart('Series', { type: 'line', labels: ['A', 'B'], series: [{ name: 'x', values: [0, 10] }] })
  expect(line.source).toContain('points="226,350 526,90"')
  const pie = renderChart('Whole', { type: 'pie', labels: ['Only'], series: [{ name: 'x', values: [3] }] })
  expect(pie.source).toContain('<circle cx="210" cy="230" r="140"')
  expect(pie.source).toContain('Only: 3 (100.0%)')
})

test.each([
  { type: 'bar', labels: ['A'], series: [{ name: 'x', values: [NaN] }] },
  { type: 'line', labels: ['A'], series: [{ name: 'x', values: [] }] },
  { type: 'pie', labels: ['A'], series: [{ name: 'x', values: [-1] }] },
  { type: 'pie', labels: ['A'], series: [{ name: 'x', values: [0] }] },
])('invalid numeric data is refused', chart => expect(() => validateChart(chart)).toThrow())

test('specialist uses the configured registry model, never the narrator', async () => {
  once.mockResolvedValue(JSON.stringify(output))
  const result = await executeCreateVisualTool({ title: 'Flow', brief: 'A sends a request to B' }, ctx)
  expect(isValidModelId(VISUAL_MODEL)).toBe(true)
  expect(result.visual?.model).toBe(VISUAL_MODEL)
  expect(once.mock.calls[0][0]).toBe(VISUAL_MODEL)
  expect(once.mock.calls[0][2][0].content[0].text).toContain('A sends a request to B')
  expect(once.mock.calls[0][3].call.purpose).toBe('visual')
})

test('one bounded repair of malformed JSON, then a complete artifact', async () => {
  once.mockResolvedValueOnce('{"format":').mockResolvedValueOnce(JSON.stringify(output))
  expect((await executeCreateVisualTool({ title: 'Flow', brief: 'A to B' }, ctx)).isError).toBe(false)
  expect(once).toHaveBeenCalledTimes(2)
  once.mockReset().mockResolvedValue('broken')
  expect((await executeCreateVisualTool({ title: 'Flow', brief: 'A to B' }, ctx)).isError).toBe(true)
  expect(once).toHaveBeenCalledTimes(2)
})

test('expired deadline and exhausted round budget avoid a specialist call', async () => {
  expect((await executeCreateVisualTool({ title: 'Flow', brief: 'A to B' }, { ...ctx, deadlineAt: Date.now() })).isError).toBe(true)
  expect((await executeCreateVisualTool({ title: 'Flow', brief: 'A to B' }, { ...ctx, visualMaxBytes: 100 })).isError).toBe(true)
  expect(once).not.toHaveBeenCalled()
})

test('size limits include JSON escapes and SVG refuses executable content', () => {
  const visual: VisualArtifact = { ...output, format: 'svg', title: 'Flow' }
  expect(() => validateVisual({ ...visual, source: '<svg>' + '"'.repeat(11000) + '</svg>' })).toThrow('too large')
  expect(() => validateVisual({ ...visual, source: '<svg onload="alert(1)"></svg>' })).toThrow('passive')
  expect(() => validateVisual({ ...visual, source: '<svg><use href="https://example.com/remote.svg"/></svg>' })).toThrow('local')
  expect(() => validateVisual({ ...visual, source: '<svg><style>path{fill:url(https://example.com/x)}</style></svg>' })).toThrow('local')
  expect(() => validateVisual({ ...visual, source: '<svg><a href="javascript:alert(1)">Click</a></svg>' })).toThrow('passive')
  expect(() => validateVisual({ ...visual, source: '<svg><path marker-end="url(#arrow)"/></svg>' })).not.toThrow()
})
