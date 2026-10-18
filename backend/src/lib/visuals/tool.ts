import type { ToolSpec, ToolResult } from '../llm/toolSpec'
import type { ToolContext } from '../tools'
import { converseOnce } from '../bedrock'
import { VISUAL_MODEL } from '../../config/models'
import VISUAL_PROMPT from '../../../prompts/visual-generation.txt'
import { validateVisual, MAX_VISUAL_BYTES, type VisualArtifact } from '../../../../shared/visuals'
import { renderChart } from './chart'

export const CREATE_VISUAL_TOOL: ToolSpec = {
  name: 'create_visual',
  description: 'Create one inline visual that helps answer the user: a chart, org chart, flow diagram, architecture diagram, SVG illustration, or interactive HTML explanation. Use only when it adds understanding. For numeric bar/line/pie charts pass chart with exact labels, series values and units; code renders accurate geometry. Otherwise give a self-contained brief and all facts/data: a specialist model builds SVG/HTML and does not see the conversation. Say the main result in text first. Never invent data or create a decorative visual for a simple answer.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short descriptive title.' },
      brief: { type: 'string', description: 'Question, conclusion, all facts, relationships, labels, and any interaction needed. Self-contained; no access to chat history.' },
      format: { type: 'string', enum: ['svg', 'html'], description: 'Prefer svg; use html for meaningful interaction or animation.' },
      chart: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bar', 'line', 'pie'] },
          labels: { type: 'array', items: { type: 'string' } },
          series: { type: 'array', items: { type: 'object', properties: {
            name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } },
          }, required: ['name', 'values'] } },
          unit: { type: 'string' },
        },
        required: ['type', 'labels', 'series'],
      },
    },
    required: ['title', 'brief'],
  },
}

export async function executeCreateVisualTool(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160 ||
      typeof input.brief !== 'string' || !input.brief.trim() || input.brief.length > 12_000) {
      throw new Error('Provide a short title and a self-contained brief (at most 12000 characters).')
    }
    if (input.format !== undefined && input.format !== 'svg' && input.format !== 'html') throw new Error('Format must be svg or html.')
    const maxBytes = Math.min(MAX_VISUAL_BYTES, ctx.visualMaxBytes ?? MAX_VISUAL_BYTES)
    if (maxBytes < 2000) throw new Error('Too many visuals in one round. Create fewer, smaller visuals.')
    let visual: VisualArtifact
    if (input.chart !== undefined) {
      visual = renderChart(input.title, input.chart as Parameters<typeof renderChart>[1])
    } else {
      if (ctx.deadlineAt && ctx.deadlineAt - Date.now() < 30_000) throw new Error('Too little time remains to create a visual. Answer in text.')
      const prompt = JSON.stringify({ title: input.title, brief: input.brief, format: input.format ?? 'svg', maxBytes })
      let failure = ''
      let generated: VisualArtifact | undefined
      // One bounded repair; never recurse into the agentic loop or use other tools.
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await converseOnce(VISUAL_MODEL, VISUAL_PROMPT,
          [{ role: 'user', content: [{ kind: 'text', text: prompt + (failure ? `\nPrevious output was invalid: ${failure}. Return a simpler complete visual.` : '') }] }],
          { maxTokens: 10000, call: { purpose: 'visual', sub: ctx.sub, chatId: ctx.chatId, projectId: ctx.projectId } })
        try {
          const parsed = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
          generated = validateVisual({ ...parsed, title: input.title, model: VISUAL_MODEL }, maxBytes)
          if (input.format && generated.format !== input.format) throw new Error('Use the requested format.')
          break
        } catch (error) {
          failure = String(error)
          if (ctx.deadlineAt && ctx.deadlineAt - Date.now() < 30_000) break
        }
      }
      if (!generated) throw new Error(`Could not create a complete visual: ${failure}`)
      visual = generated
    }
    validateVisual(visual, maxBytes)
    return {
      isError: false, visual,
      entries: [{ kind: 'text', text: `Created "${visual.title}". ${visual.summary} It is displayed inline. Explain the implication briefly; do not paste its code.` }],
    }
  } catch (error) {
    return { isError: true, entries: [{ kind: 'text', text: String(error) }] }
  }
}
