# 0071: PDF support is separate from text documents

## Status

Accepted.

## Context

GPT-6.2 Sol and Astra reject PDF `input_file` items but read text files, which the
Responses adapter already inlines as text. Grok 4.7 rejects every Converse document
block but reads text. A single `documents` flag forced these models to refuse text files
too, and a PDF earlier in a chat made every later turn fail after a model switch.

## Decision

Replace `documents` with `pdf`. Text documents (txt/md/csv) work on every model. When
`pdf` is false, `lib/llm/documents.ts` replaces each PDF, including one inside a tool
result, with a note saying it was omitted. On Converse, a model without PDF support also
gets its text documents inlined as text. The composer refuses new PDFs for such a model,
blocks Send while one is pending, and shows a dismissible notice about PDFs earlier in the
chat.

## Consequences

Switching a chat with PDFs to GPT-6.2 or Grok keeps working; the model knows a PDF was
there but not its content. Text attachments work on Grok.

A three-way `documents: 'all'|'text-only'|'none'` was rejected because no model lacks text
support once text is inlined. Extracting PDF text for these models was rejected as a new
ingestion path for a gap that may close. Inlining text for every Converse model was rejected
because the Anthropic models read native document blocks and their verified request
shapes need not change.
