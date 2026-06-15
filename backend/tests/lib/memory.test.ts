/**
 * Tests for backend/src/lib/memory.ts — TDD, written before implementation.
 *
 * extractUserFacts:
 *   - calls converseOnce with MEMORY_EXTRACTION_MODEL
 *   - passes a prompt that includes key extraction phrases
 *   - parses JSON array from the response
 *   - filters invalid items (missing category or text)
 *   - returns [] on JSON parse error or thrown exception
 *
 * reconcile:
 *   - new candidate → ADD op
 *   - duplicate by exact text (case-insensitive, trim) → NOOP
 *   - multiple candidates: new ones ADD, duplicates NOOP
 *   - existing memories with no matching candidate → NOOP (unchanged)
 *   - empty candidates, non-empty existing → all NOOP
 *   - both empty → empty result
 *
 * executeMemoryTool:
 *   - remember new fact
 *   - remember duplicate
 *   - remember missing text
 *   - remember invalid category
 *   - update valid memId
 *   - update unknown memId
 *   - update missing text
 *   - forget valid memId
 *   - forget unknown memId
 *   - forget missing memId
 *   - sub from ctx, NOT from input
 */

import * as bedrock from '../../src/lib/bedrock'
import { extractUserFacts, reconcile, executeMemoryTool } from '../../src/lib/memory'
import type { UserMemory, ReconcileOp } from '../../src/lib/memory'
import { MEMORY_EXTRACTION_MODEL } from '../../src/config/models'
import * as dynamoLib from '../../src/lib/dynamo'

jest.mock('../../src/lib/bedrock')
const mockBedrock = bedrock as jest.Mocked<typeof bedrock>

jest.mock('../../src/lib/dynamo', () => ({
  ...jest.requireActual('../../src/lib/dynamo'),
  listUserMemories: jest.fn(),
  putUserMemory: jest.fn(),
  deleteUserMemory: jest.fn(),
  buildUserMemKey: jest.fn((sub: string, memId: string) => ({ PK: `USER#${sub}`, SK: `MEM#USER#${memId}` })),
}))

const mockDynamo = dynamoLib as jest.Mocked<typeof dynamoLib>

// ── uuid mock for deterministic memIds ────────────────────────────────────────
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'new-mem-id'),
}))

beforeEach(() => {
  jest.clearAllMocks()
})

// ── extractUserFacts ──────────────────────────────────────────────────────────

describe('extractUserFacts', () => {
  test('returns parsed facts from valid JSON response', async () => {
    const facts = [
      { category: 'identity', text: 'I live in Berlin' },
      { category: 'preference', text: 'I prefer concise answers' },
    ]
    mockBedrock.converseOnce.mockResolvedValueOnce(JSON.stringify(facts))

    const result = await extractUserFacts('User: I live in Berlin. I prefer concise answers.')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ category: 'identity', text: 'I live in Berlin' })
    expect(result[1]).toEqual({ category: 'preference', text: 'I prefer concise answers' })
  })

  test('returns empty array on JSON parse error', async () => {
    mockBedrock.converseOnce.mockResolvedValueOnce('not valid json at all')

    const result = await extractUserFacts('some transcript')

    expect(result).toEqual([])
  })

  test('returns empty array when converseOnce throws', async () => {
    mockBedrock.converseOnce.mockRejectedValueOnce(new Error('Bedrock unavailable'))

    const result = await extractUserFacts('some transcript')

    expect(result).toEqual([])
  })

  test('filters out items missing the text field', async () => {
    const badItems = [
      { category: 'identity' },             // missing text
      { category: 'preference', text: 'I like Python' },  // valid
      { category: 'style', text: '' },      // text is empty string — still has text field, filter by non-empty
    ]
    mockBedrock.converseOnce.mockResolvedValueOnce(JSON.stringify(badItems))

    const result = await extractUserFacts('transcript')

    // Only the item with non-empty text and valid category should survive
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ category: 'preference', text: 'I like Python' })
  })

  test('filters out items missing the category field', async () => {
    const badItems = [
      { text: 'I live in Sydney' },                       // missing category
      { category: 'identity', text: 'I am a developer' }, // valid
    ]
    mockBedrock.converseOnce.mockResolvedValueOnce(JSON.stringify(badItems))

    const result = await extractUserFacts('transcript')

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ category: 'identity', text: 'I am a developer' })
  })

  test('uses MEMORY_EXTRACTION_MODEL as the modelId argument to converseOnce', async () => {
    mockBedrock.converseOnce.mockResolvedValueOnce('[]')

    await extractUserFacts('User: I am a developer.')

    expect(mockBedrock.converseOnce).toHaveBeenCalledTimes(1)
    const [modelId] = mockBedrock.converseOnce.mock.calls[0]
    expect(modelId).toBe(MEMORY_EXTRACTION_MODEL)
  })

  test('prompt instructs to extract only durable user facts and return JSON', async () => {
    mockBedrock.converseOnce.mockResolvedValueOnce('[]')

    await extractUserFacts('User said something.')

    expect(mockBedrock.converseOnce).toHaveBeenCalledTimes(1)
    // The system prompt or user message should mention "JSON" and durable/personal fact extraction
    const callArgs = mockBedrock.converseOnce.mock.calls[0]
    const fullCallText = JSON.stringify(callArgs)
    expect(fullCallText.toLowerCase()).toContain('json')
    expect(fullCallText.toLowerCase()).toMatch(/durable|lasting|personal fact/)
  })

  test('passes maxTokens option to converseOnce (must be > 64 for JSON extraction)', async () => {
    mockBedrock.converseOnce.mockResolvedValueOnce('[]')

    await extractUserFacts('A longer conversation transcript.')

    expect(mockBedrock.converseOnce).toHaveBeenCalledTimes(1)
    // The 4th argument (options) should include maxTokens > 64
    const callArgs = mockBedrock.converseOnce.mock.calls[0]
    const options = callArgs[3] as { maxTokens?: number } | undefined
    expect(options?.maxTokens).toBeDefined()
    expect(options!.maxTokens).toBeGreaterThan(64)
  })
})

// ── reconcile ────────────────────────────────────────────────────────────────

describe('reconcile', () => {
  const makeMemory = (memId: string, text: string, category: UserMemory['category'] = 'other'): UserMemory => ({
    memId,
    text,
    category,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  test('new fact with no existing memories → single ADD op', () => {
    const candidates = [{ category: 'identity' as const, text: 'I live in Berlin' }]
    const existing: UserMemory[] = []

    const ops = reconcile(candidates, existing)

    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: 'ADD', text: 'I live in Berlin', category: 'identity' })
  })

  test('duplicate text (exact case-insensitive match) → NOOP not ADD', () => {
    const candidates = [{ category: 'identity' as const, text: 'I Live In Berlin' }]
    const existing = [makeMemory('mem-1', 'i live in berlin', 'identity')]

    const ops = reconcile(candidates, existing)

    // The candidate is a dup → NOOP for existing; no ADD
    const addOps = ops.filter(o => o.op === 'ADD')
    const noopOps = ops.filter(o => o.op === 'NOOP')
    expect(addOps).toHaveLength(0)
    expect(noopOps).toHaveLength(1)
    expect((noopOps[0] as Extract<ReconcileOp, { op: 'NOOP' }>).existingId).toBe('mem-1')
  })

  test('duplicate text with whitespace difference → NOOP not ADD', () => {
    const candidates = [{ category: 'preference' as const, text: '  I prefer Python  ' }]
    const existing = [makeMemory('mem-2', 'i prefer python', 'preference')]

    const ops = reconcile(candidates, existing)

    const addOps = ops.filter(o => o.op === 'ADD')
    expect(addOps).toHaveLength(0)
    const noopOps = ops.filter(o => o.op === 'NOOP')
    expect(noopOps).toHaveLength(1)
    expect((noopOps[0] as Extract<ReconcileOp, { op: 'NOOP' }>).existingId).toBe('mem-2')
  })

  test('multiple candidates: new ones ADD, dupes NOOP', () => {
    const candidates = [
      { category: 'identity' as const, text: 'I live in Berlin' },       // new
      { category: 'preference' as const, text: 'I prefer Python' },      // duplicate
      { category: 'style' as const, text: 'I like short answers' },      // new
    ]
    const existing = [
      makeMemory('mem-1', 'i prefer python', 'preference'),
    ]

    const ops = reconcile(candidates, existing)

    const addOps = ops.filter(o => o.op === 'ADD')
    const noopOps = ops.filter(o => o.op === 'NOOP')

    expect(addOps).toHaveLength(2)
    expect(addOps.find(o => (o as Extract<ReconcileOp, { op: 'ADD' }>).text === 'I live in Berlin')).toBeDefined()
    expect(addOps.find(o => (o as Extract<ReconcileOp, { op: 'ADD' }>).text === 'I like short answers')).toBeDefined()

    expect(noopOps).toHaveLength(1)
    expect((noopOps[0] as Extract<ReconcileOp, { op: 'NOOP' }>).existingId).toBe('mem-1')
  })

  test('empty candidates, existing memories present → all NOOP (memories preserved)', () => {
    const candidates: Array<{ category: UserMemory['category']; text: string }> = []
    const existing = [
      makeMemory('mem-1', 'I live in Berlin', 'identity'),
      makeMemory('mem-2', 'I prefer Python', 'preference'),
    ]

    const ops = reconcile(candidates, existing)

    // No ADD or DELETE; both existing memories get NOOP
    const addOps = ops.filter(o => o.op === 'ADD')
    const deleteOps = ops.filter(o => o.op === 'DELETE')
    const noopOps = ops.filter(o => o.op === 'NOOP')

    expect(addOps).toHaveLength(0)
    expect(deleteOps).toHaveLength(0)
    expect(noopOps).toHaveLength(2)
    const noopIds = noopOps.map(o => (o as Extract<ReconcileOp, { op: 'NOOP' }>).existingId)
    expect(noopIds).toContain('mem-1')
    expect(noopIds).toContain('mem-2')
  })

  test('empty candidates and empty existing → empty result', () => {
    const ops = reconcile([], [])
    expect(ops).toHaveLength(0)
    expect(ops).toEqual([])
  })
})

// ── executeMemoryTool ─────────────────────────────────────────────────────────

describe('executeMemoryTool', () => {
  const ctx = { sub: 'user-42' }

  const makeRawMemory = (memId: string, text: string, category: string = 'other') => ({
    PK: `USER#${ctx.sub}`,
    SK: `MEM#USER#${memId}`,
    memId,
    text,
    category,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockDynamo.listUserMemories.mockResolvedValue([])
    mockDynamo.putUserMemory.mockResolvedValue(undefined)
    mockDynamo.deleteUserMemory.mockResolvedValue(undefined)
    mockDynamo.buildUserMemKey.mockImplementation((sub: string, memId: string) => ({
      PK: `USER#${sub}`,
      SK: `MEM#USER#${memId}`,
    }))
  })

  // ── remember ──────────────────────────────────────────────────────────────

  test('remember new fact → putUserMemory called with ctx.sub-scoped key, returns Saved.', async () => {
    mockDynamo.listUserMemories.mockResolvedValue([])

    const result = await executeMemoryTool(
      { operation: 'remember', text: 'I am a developer', category: 'identity' },
      ctx,
    )

    expect(result.status).toBe('success')
    expect((result.content?.[0] as { text: string }).text).toBe('Saved.')
    expect(mockDynamo.putUserMemory).toHaveBeenCalledTimes(1)
    const arg = mockDynamo.putUserMemory.mock.calls[0][0] as Record<string, unknown>
    expect(arg.PK).toBe(`USER#${ctx.sub}`)
    expect(arg.memId).toBe('new-mem-id')
    expect(arg.text).toBe('I am a developer')
    expect(arg.category).toBe('identity')
  })

  test('remember duplicate (same text, case-insensitive) → putUserMemory NOT called, returns Already known.', async () => {
    mockDynamo.listUserMemories.mockResolvedValue([
      makeRawMemory('existing-id', 'i am a developer', 'identity'),
    ])

    const result = await executeMemoryTool(
      { operation: 'remember', text: 'I Am A Developer', category: 'identity' },
      ctx,
    )

    expect(result.status).toBe('success')
    expect((result.content?.[0] as { text: string }).text).toBe('Already known.')
    expect(mockDynamo.putUserMemory).not.toHaveBeenCalled()
  })

  test('remember missing text → error result, no dynamo call', async () => {
    const result = await executeMemoryTool(
      { operation: 'remember', category: 'identity' },
      ctx,
    )

    expect(result.status).toBe('error')
    expect(mockDynamo.putUserMemory).not.toHaveBeenCalled()
  })

  test('remember invalid category → error result, no dynamo call', async () => {
    const result = await executeMemoryTool(
      { operation: 'remember', text: 'I am a developer', category: 'invalid-category' },
      ctx,
    )

    expect(result.status).toBe('error')
    expect(mockDynamo.putUserMemory).not.toHaveBeenCalled()
  })

  // ── update ────────────────────────────────────────────────────────────────

  test('update valid memId → putUserMemory called with same key/memId/createdAt, new text; returns Updated.', async () => {
    mockDynamo.listUserMemories.mockResolvedValue([
      makeRawMemory('mem-abc', 'Old fact', 'identity'),
    ])

    const result = await executeMemoryTool(
      { operation: 'update', memId: 'mem-abc', text: 'New fact', category: 'preference' },
      ctx,
    )

    expect(result.status).toBe('success')
    expect((result.content?.[0] as { text: string }).text).toBe('Updated.')
    expect(mockDynamo.putUserMemory).toHaveBeenCalledTimes(1)
    const arg = mockDynamo.putUserMemory.mock.calls[0][0] as Record<string, unknown>
    expect(arg.PK).toBe(`USER#${ctx.sub}`)
    expect(arg.SK).toBe('MEM#USER#mem-abc')
    expect(arg.memId).toBe('mem-abc')
    expect(arg.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(arg.text).toBe('New fact')
    expect(arg.category).toBe('preference')
    // updatedAt must be bumped (different from original)
    expect(arg.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
  })

  test('update unknown memId → error result, no putUserMemory call', async () => {
    mockDynamo.listUserMemories.mockResolvedValue([
      makeRawMemory('mem-abc', 'Some fact', 'identity'),
    ])

    const result = await executeMemoryTool(
      { operation: 'update', memId: 'unknown-id', text: 'New text' },
      ctx,
    )

    expect(result.status).toBe('error')
    expect((result.content?.[0] as { text: string }).text).toContain('not found')
    expect(mockDynamo.putUserMemory).not.toHaveBeenCalled()
  })

  test('update missing text → error result', async () => {
    const result = await executeMemoryTool(
      { operation: 'update', memId: 'mem-abc' },
      ctx,
    )

    expect(result.status).toBe('error')
    expect(mockDynamo.putUserMemory).not.toHaveBeenCalled()
  })

  // ── forget ────────────────────────────────────────────────────────────────

  test('forget valid memId → deleteUserMemory(ctx.sub, memId) called; returns Forgotten.', async () => {
    mockDynamo.listUserMemories.mockResolvedValue([
      makeRawMemory('mem-del', 'Fact to delete', 'other'),
    ])

    const result = await executeMemoryTool(
      { operation: 'forget', memId: 'mem-del' },
      ctx,
    )

    expect(result.status).toBe('success')
    expect((result.content?.[0] as { text: string }).text).toBe('Forgotten.')
    expect(mockDynamo.deleteUserMemory).toHaveBeenCalledTimes(1)
    expect(mockDynamo.deleteUserMemory).toHaveBeenCalledWith(ctx.sub, 'mem-del')
  })

  test('forget unknown memId → error result, deleteUserMemory NOT called', async () => {
    mockDynamo.listUserMemories.mockResolvedValue([
      makeRawMemory('mem-abc', 'Some fact', 'other'),
    ])

    const result = await executeMemoryTool(
      { operation: 'forget', memId: 'unknown-id' },
      ctx,
    )

    expect(result.status).toBe('error')
    expect(mockDynamo.deleteUserMemory).not.toHaveBeenCalled()
  })

  test('forget missing memId → error result', async () => {
    const result = await executeMemoryTool(
      { operation: 'forget' },
      ctx,
    )

    expect(result.status).toBe('error')
    expect(mockDynamo.deleteUserMemory).not.toHaveBeenCalled()
  })

  // ── security ──────────────────────────────────────────────────────────────

  test('sub from ctx, NOT from input — dynamo key uses ctx.sub even if input.sub is provided', async () => {
    mockDynamo.listUserMemories.mockResolvedValue([])

    await executeMemoryTool(
      { operation: 'remember', text: 'I am a hacker', category: 'identity', sub: 'attacker-sub' },
      { sub: 'real-user-sub' },
    )

    // listUserMemories must be called with ctx.sub, not input.sub
    expect(mockDynamo.listUserMemories).toHaveBeenCalledWith('real-user-sub')
    // putUserMemory key must use ctx.sub
    if (mockDynamo.putUserMemory.mock.calls.length > 0) {
      const arg = mockDynamo.putUserMemory.mock.calls[0][0] as Record<string, unknown>
      expect(arg.PK).toBe('USER#real-user-sub')
    }
  })

  // ── unknown operation ─────────────────────────────────────────────────────

  test('unknown operation → error result', async () => {
    const result = await executeMemoryTool(
      { operation: 'invalidop' },
      ctx,
    )

    expect(result.status).toBe('error')
  })
})
