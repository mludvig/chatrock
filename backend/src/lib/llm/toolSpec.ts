// Neutral tool descriptor + result — plain JSON Schema, no Bedrock/OpenAI wire shape.
// Each provider lowers ToolSpec[] to its own tool-declaration format:
//   Converse: { toolSpec: { name, description, inputSchema: { json } } } + trailing cachePoint
//   Mantle:   { type: 'function', name, description, parameters, strict: false }

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ToolResultEntry =
  | { kind: 'text'; text: string }
  | { kind: 'image'; format: 'png' | 'jpeg'; bytes: Uint8Array }

export interface ToolResult {
  entries: ToolResultEntry[]
  isError: boolean
}
