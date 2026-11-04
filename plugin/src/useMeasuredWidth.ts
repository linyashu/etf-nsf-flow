import { useEffect, useRef, useState } from 'react'

/**
 * 测量容器实际像素宽度，作为 SVG 的 viewBox 宽度。
 *
 * 为什么必须这么做：
 * SVG 用 width="100%" + 固定 viewBox 时，浏览器按 preserveAspectRatio="meet"
 * 等比缩放并**居中**。容器比 viewBox 宽时，图形只画在中间，两侧留白。
 * 此时鼠标坐标按整个容器换算，与图形实际位置错位 —— 表现为「鼠标和读数对不上」。
 * 让 viewBox 宽等于实际宽度后，缩放比恒为 1，坐标一一对应。
 */
export function useMeasuredWidth(fallback = 760) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [w, setW] = useState(fallback)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const apply = () => {
      const next = Math.round(el.getBoundingClientRect().width)
      if (next > 0) setW((prev) => (Math.abs(prev - next) > 1 ? next : prev))
    }

    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, w] as const
}
