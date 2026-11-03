import { useState, type KeyboardEvent, type RefObject } from 'react'
import {
  filterMentions,
  mentionAt,
  type MentionItem,
} from '../lib/mentionQuery'

export type { MentionItem }

/**
 * Shared @ autocomplete for prompt textareas (PromptBar / DirectorPanel).
 * Only lists the current ref pool — historical uploads live in the media library.
 */
export function useAssetMentions(opts: {
  items: MentionItem[]
  value: string
  setValue: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
}) {
  const { items, value, setValue, textareaRef } = opts
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null,
  )
  const [index, setIndex] = useState(0)

  const candidates = mention ? filterMentions(items, mention.query) : []
  const open = mention !== null && candidates.length > 0

  const sync = (text: string, caret: number) => {
    if (!items.length) {
      setMention(null)
      return
    }
    const next = mentionAt(text, caret)
    if (!next) {
      setMention(null)
      return
    }
    setMention((prev) => {
      if (prev?.start !== next.start || prev?.query !== next.query) setIndex(0)
      return next
    })
  }

  const pick = (item: MentionItem) => {
    if (!mention) return
    const el = textareaRef.current
    const caret = el ? el.selectionStart : value.length
    const before = value.slice(0, mention.start)
    const after = value.slice(caret)
    const inserted = `@${item.name}${after.startsWith(' ') ? '' : ' '}`
    setValue(before + inserted + after)
    setMention(null)
    requestAnimationFrame(() => {
      if (!el) return
      const pos = before.length + inserted.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  /** Returns true when the key event was consumed by the popup. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (i + 1) % candidates.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (i - 1 + candidates.length) % candidates.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(candidates[index])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
      return true
    }
    return false
  }

  return {
    open,
    candidates,
    index,
    setIndex,
    sync,
    pick,
    close: () => setMention(null),
    onKeyDown,
  }
}

export function MentionPopup({
  mentions,
}: {
  mentions: ReturnType<typeof useAssetMentions>
}) {
  if (!mentions.open) return null
  return (
    <div className="mention-pop" role="listbox" aria-label="Current references">
      {mentions.candidates.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === mentions.index}
          className={
            i === mentions.index ? 'mention-option active' : 'mention-option'
          }
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            mentions.pick(item)
          }}
          onPointerEnter={() => mentions.setIndex(i)}
        >
          <img src={item.thumb} alt="" />
          <span className="mention-name">@{item.name}</span>
        </button>
      ))}
    </div>
  )
}
