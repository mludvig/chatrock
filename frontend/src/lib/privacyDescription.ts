// Shared "what will actually happen" text for a chat's memory/search/auto-delete
// settings — used by both ChatDetailsDialog's Privacy section and ChatView's header
// chip/footer, so the two surfaces can't drift into describing different behavior.
// See docs/adr/0015-privacy-toggle-labels-and-sensitive-flag-mapping.md.

export interface PrivacyDescriptionInput {
  memoryEnabled: boolean   // "Use memory" toggle
  sensitive: boolean       // underlying flag; "Update memory" toggle displays !sensitive
  isProject: boolean
  ephemeral: boolean
  expiresAt?: string
}

export function describeChatPrivacy({ memoryEnabled, sensitive, isProject, ephemeral, expiresAt }: PrivacyDescriptionInput): string {
  const projectSuffix = isProject ? " (including this project's)" : ''
  let memoryPart: string
  if (!memoryEnabled) {
    memoryPart = "Saved memory isn't used here, and this chat's summary won't stay current for search."
  } else if (!sensitive) {
    memoryPart = `Saved memory is used${projectSuffix} and updated with new facts from this chat; it will appear in search & summaries.`
  } else {
    memoryPart = `Saved memory is used${projectSuffix} but not updated with anything new from this chat; it's excluded from search & summaries.`
  }
  const deletePart = ephemeral
    ? ` Auto-deletes ${expiresAt ? new Date(expiresAt).toLocaleString() : 'after a TTL'}.`
    : ''
  return memoryPart + deletePart
}
