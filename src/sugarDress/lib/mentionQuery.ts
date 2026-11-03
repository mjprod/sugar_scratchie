export type MentionItem = {
  id: string
  name: string
  thumb: string
}

export function mentionAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

export function filterMentions(
  items: MentionItem[],
  query: string,
): MentionItem[] {
  const q = query.toLowerCase()
  return q
    ? items.filter((item) => item.name.toLowerCase().includes(q))
    : items
}
