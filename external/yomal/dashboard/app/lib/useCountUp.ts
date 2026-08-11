'use client'

import { useEffect, useRef, useState } from 'react'

/** Animates from 0 to `target` over `duration` ms with an ease-out curve. */
export function useCountUp(target: number, duration = 600): number {
  const [value, setValue] = useState(0)
  const frame = useRef(0)

  useEffect(() => {
    if (!Number.isFinite(target) || target <= 0) {
      setValue(target)
      return
    }
    const start = performance.now()
    function tick(now: number) {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(target * eased))
      if (t < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [target, duration])

  return value
}
