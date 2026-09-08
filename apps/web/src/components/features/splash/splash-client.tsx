'use client'
import { useEffect } from 'react'
// Behaviour for the splash: reveal on scroll, the blind-pair slider, muted autoplay, and the
// particle field behind the hero. Renders nothing.
export function SplashClient({ rootId = 'splash' }: { rootId?: string }) {
  useEffect(() => {
    const root = document.getElementById(rootId)
    if (!root) return
    const ac = new AbortController(),
      { signal } = ac,
      reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    root.classList.add('js')
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add('in')
            reveal.unobserve(e.target)
          }
      },
      { root: null, threshold: 0.12 },
    )
    for (const el of root.querySelectorAll('[data-reveal]')) reveal.observe(el)
    // React does not serialise the muted attribute, so set it before asking the browser to play.
    for (const v of root.querySelectorAll('video')) {
      v.muted = true
      if (!reduce) v.play().catch(() => {})
    }
    const pair = root.querySelector<HTMLElement>('.pair'),
      handle = pair?.querySelector<HTMLInputElement>('.handle')
    if (pair && handle)
      handle.addEventListener(
        'input',
        () => pair.style.setProperty('--pos', handle.value + '%'),
        { signal },
      )
    const hero = root.querySelector<HTMLElement>('.hero'),
      canvas = root.querySelector<HTMLCanvasElement>('.field'),
      ctx = canvas?.getContext('2d')
    if (reduce || !hero || !canvas || !ctx) {
      return () => {
        ac.abort()
        reveal.disconnect()
      }
    }
    let w = 0,
      h = 0,
      raf = 0,
      running = false,
      t = 0
    const N = 130,
      pts: {
        x: number
        y: number
        vx: number
        vy: number
        s: number
        p: number
      }[] = [],
      pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, lx: -1e4, ly: -1e4 }
    const size = () => {
      const r = hero.getBoundingClientRect(),
        dpr = Math.min(devicePixelRatio || 1, 2)
      w = r.width
      h = r.height
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!pts.length)
        for (let i = 0; i < N; i++)
          pts.push({
            x: Math.random() * w,
            y: Math.random() * h,
            vx: (Math.random() - 0.5) * 0.15,
            vy: (Math.random() - 0.5) * 0.15,
            s: 0.6 + Math.random() * 1.4,
            p: Math.random() * 6.28,
          })
    }
    const ro = new ResizeObserver(size)
    ro.observe(hero)
    hero.addEventListener(
      'pointermove',
      (e) => {
        const r = hero.getBoundingClientRect()
        pointer.lx = pointer.x
        pointer.ly = pointer.y
        pointer.x = e.clientX - r.left
        pointer.y = e.clientY - r.top
        if (pointer.lx > -1e3) {
          pointer.vx = pointer.x - pointer.lx
          pointer.vy = pointer.y - pointer.ly
        }
      },
      { signal },
    )
    hero.addEventListener(
      'pointerleave',
      () => {
        pointer.x = pointer.y = -1e4
        pointer.lx = pointer.ly = -1e4
      },
      { signal },
    )
    const frame = () => {
      if (!running) return
      t += 0.008
      ctx.clearRect(0, 0, w, h)
      for (const p of pts) {
        const dx = p.x - pointer.x,
          dy = p.y - pointer.y,
          d2 = dx * dx + dy * dy
        if (d2 < 160 * 160) {
          const f = (1 - Math.sqrt(d2) / 160) * 0.06
          p.vx += pointer.vx * f + dx * 0.0008
          p.vy += pointer.vy * f + dy * 0.0008
        }
        p.vx += Math.sin(t + p.p) * 0.002
        p.vy += Math.cos(t * 0.9 + p.p) * 0.002
        p.vx *= 0.985
        p.vy *= 0.985
        p.x += p.vx
        p.y += p.vy
        if (p.x < -10) p.x = w + 10
        if (p.x > w + 10) p.x = -10
        if (p.y < -10) p.y = h + 10
        if (p.y > h + 10) p.y = -10
        const sp = Math.min(1, Math.hypot(p.vx, p.vy) * 2.5),
          a = 0.18 + sp * 0.7
        ctx.fillStyle =
          sp > 0.35 ? `rgba(62,230,224,${a})` : `rgba(150,140,255,${a * 0.8})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.s * (1 + sp), 0, 6.28)
        ctx.fill()
        if (sp > 0.25) {
          ctx.strokeStyle = `rgba(62,230,224,${sp * 0.35})`
          ctx.lineWidth = p.s * 0.8
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(p.x - p.vx * 6, p.y - p.vy * 6)
          ctx.stroke()
        }
      }
      pointer.vx *= 0.8
      pointer.vy *= 0.8
      raf = requestAnimationFrame(frame)
    }
    const start = () => {
      if (running) return
      running = true
      size()
      raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }
    // Only animate while the hero is on screen.
    const visible = new IntersectionObserver(
      (entries) => {
        for (const e of entries) (e.isIntersecting ? start : stop)()
      },
      { root: null, threshold: 0.05 },
    )
    visible.observe(hero)
    return () => {
      stop()
      ac.abort()
      reveal.disconnect()
      visible.disconnect()
      ro.disconnect()
    }
  }, [rootId])
  return null
}
