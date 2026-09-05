import { useCallback, useLayoutEffect, useRef } from 'react'

/** How close to the bottom still counts as "at the bottom", in pixels. */
const SLACK = 8

export function atBottom(box: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= SLACK
}

/**
 * Keeps a scroll container pinned to the bottom as content arrives. Scrolling up
 * releases the pin; scrolling back to the bottom restores it. Pass whatever value
 * changes when new content is appended.
 */
export function useStickToBottom(content: unknown) {
  const ref = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)

  useLayoutEffect(() => {
    const element = ref.current
    if (stuck.current && element) element.scrollTop = element.scrollHeight
  }, [content])

  const onScroll = useCallback(() => {
    const element = ref.current
    if (element) stuck.current = atBottom(element)
  }, [])

  return { ref, onScroll }
}
