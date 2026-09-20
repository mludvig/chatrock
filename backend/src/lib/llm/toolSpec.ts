// Neutral tool descriptor + result — plain JSON Schema, no Bedrock/OpenAI wire shape.
// Each provider lowers ToolSpec[] to its own tool-declaration format:
//   Converse: { toolSpec: { name, description, inputSchema: { json } } } + trailing cachePoint
//   Responses: { type: 'function', name, description, parameters, strict: false }

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ToolResultEntry =
  | { kind: 'text'; text: string }
  | { kind: 'image'; format: 'png' | 'jpeg'; bytes: Uint8Array }
  // Full-document tool results (e.g. project_read_file returning a raw PDF for the model to
  // read directly) — distinct from the neutral Block's DocumentBlock (which is at-rest/stored
  // shape) since a tool result's document is always inline bytes, never an s3Uri.
  | { kind: 'document'; format: 'pdf' | 'txt' | 'md' | 'csv'; name: string; bytes: Uint8Array }

export interface ToolResult {
  entries: ToolResultEntry[]
  isError: boolean
}
