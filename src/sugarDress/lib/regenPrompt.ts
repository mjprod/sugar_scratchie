/** Combine stored prompt with optional user change notes for regeneration. */
export function buildRegenPrompt(
  metaPrompt: string,
  edits: { prompt?: string; note?: string },
): string {
  const note = edits.note?.trim()
  const basePrompt = (edits.prompt ?? '').trim() || metaPrompt
  return note ? `${basePrompt}\n\nChange: ${note}` : basePrompt
}

/** Recover prompt from storyboard-style captions when genMeta is missing. */
export function promptFromCaption(caption?: string): string | null {
  if (!caption) return null
  const m = caption.match(/^(?:畫面|視頻|Video)\s*[|｜](.+)$/m)
  const prompt = m?.[1]?.trim()
  return prompt || null
}
