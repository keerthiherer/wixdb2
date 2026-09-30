import { useEffect, useRef } from 'react'
import type { StatusLine } from '../engine/machine'
import { cx, formatClock } from '../lib/format'

interface Props {
  lines: StatusLine[]
  running: boolean
  finished: boolean
  pc: number | null
  clock: number
  policy: string
  capacity: number
  collapsed: boolean
  onToggle: () => void
}

export function StatusBar(p: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [p.lines.length])

  const state = p.running ? 'running' : p.finished ? 'halted' : 'paused'

  return (
    <footer className={cx('statusbar', p.collapsed && 'collapsed')}>
      <div className="status-head">
        <span className="status-title">Messages</span>
        <span className={cx('status-state', state)}>{state}</span>
        <span className="status-meta mono">
          WIX-{p.policy} · cap {p.capacity} · pc {p.pc === null ? 'end' : p.pc} · clock {formatClock(p.clock)}
        </span>
        <button className="mini-btn" onClick={p.onToggle}>
          {p.collapsed ? 'expand' : 'collapse'}
        </button>
      </div>
      {!p.collapsed && (
        <div className="status-body" ref={ref}>
          {p.lines.map((l) => (
            <div key={l.id} className={cx('status-line', `st-${l.tone}`)}>
              {l.text}
            </div>
          ))}
        </div>
      )}
    </footer>
  )
}
