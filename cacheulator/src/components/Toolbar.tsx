import { useEffect, useRef, useState } from 'react'
import type { Sample } from '../engine/samples'
import { INSTRUCTION_HELP } from '../engine/program'
import {
  IconChip,
  IconPlay,
  IconReload,
  IconRestart,
  IconStepInto,
  IconStepOut,
  IconStepOver,
  IconStop,
  IconTrash,
} from './icons'
import { cx } from '../lib/format'

interface Props {
  finished: boolean
  running: boolean
  lookups: number
  sampleGroups: [string, Sample[]][]
  sampleId: string
  onLoadSample: (s: Sample) => void
  onStepInto: () => void
  onStepOver: () => void
  onStepOut: () => void
  onContinue: () => void
  onStop: () => void
  onRestart: () => void
  onReload: () => void
  speed: number
  setSpeed: (n: number) => void
  dirty: boolean
}

function ControlButton({
  label,
  hint,
  onClick,
  disabled,
  children,
  accent,
}: {
  label: string
  hint: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  accent?: boolean
}) {
  return (
    <button className={cx('ctrl', accent && 'ctrl-accent')} onClick={onClick} disabled={disabled} title={hint}>
      {children}
      <span className="ctrl-label">{label}</span>
    </button>
  )
}

export function Toolbar(p: Props) {
  const [fileOpen, setFileOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const fileRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (fileRef.current && !fileRef.current.contains(e.target as Node)) setFileOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">
          <IconChip size={16} />
        </span>
        <span className="brand-name">
          cacheulator
          <em>WIX in-memory cache core simulator</em>
        </span>
      </div>

      <nav className="menus" ref={fileRef}>
        <div className="menu">
          <button className={cx('menu-btn', fileOpen && 'open')} onClick={() => setFileOpen((v) => !v)}>
            File
          </button>
          {fileOpen && (
            <div className="menu-pop">
              {p.sampleGroups.map(([group, items]) => (
                <div key={group} className="menu-group">
                  <div className="menu-label">{group}</div>
                  {items.map((s) => (
                    <button
                      key={s.id}
                      className={cx('menu-item', s.id === p.sampleId && 'active')}
                      onClick={() => {
                        p.onLoadSample(s)
                        setFileOpen(false)
                      }}
                    >
                      <span>{s.name}</span>
                      <small>{s.blurb}</small>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="menu">
          <button className={cx('menu-btn', helpOpen && 'open')} onClick={() => setHelpOpen((v) => !v)}>
            Help
          </button>
          {helpOpen && (
            <div className="menu-pop help-pop">
              <div className="menu-label">Instruction set</div>
              <table className="help-table">
                <tbody>
                  {INSTRUCTION_HELP.map((h) => (
                    <tr key={h.syntax}>
                      <td>
                        <code>{h.syntax}</code>
                      </td>
                      <td>{h.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="menu-label">Debugging</div>
              <ul className="help-list">
                <li>
                  <b>Step Into</b> — advance one Java statement of the running instruction.
                </li>
                <li>
                  <b>Step Over</b> — run the current instruction to its last statement.
                </li>
                <li>
                  <b>Step Out</b> — drain the virtual threads the current SPAWN launched.
                </li>
                <li>Click a line number to toggle a breakpoint. Click a die slot to inspect it.</li>
              </ul>
            </div>
          )}
        </div>
      </nav>

      <div className="controls">
        <ControlButton label="Step Into" hint="Advance one Java statement" onClick={p.onStepInto} disabled={p.finished || p.running}>
          <IconStepInto />
        </ControlButton>
        <ControlButton label="Step Over" hint="Finish the current instruction" onClick={p.onStepOver} disabled={p.finished || p.running}>
          <IconStepOver />
        </ControlButton>
        <ControlButton label="Step Out" hint="Leave the current virtual-thread frame" onClick={p.onStepOut} disabled={p.finished || p.running}>
          <IconStepOut />
        </ControlButton>
        <ControlButton
          label={p.running ? 'Running' : 'Continue'}
          hint={p.running ? 'Stop the run' : 'Run until a breakpoint or halt'}
          onClick={p.running ? p.onStop : p.onContinue}
          accent
        >
          {p.running ? <IconStop /> : <IconPlay />}
        </ControlButton>
        <ControlButton label="Stop" hint="Halt the run" onClick={p.onStop} disabled={!p.running}>
          <IconStop />
        </ControlButton>
        <span className="ctrl-sep" />
        <ControlButton label="Restart" hint="Replay the compiled program from pc 0" onClick={p.onRestart}>
          <IconRestart />
        </ControlButton>
        <ControlButton label="Reload" hint="Recompile the editor contents" onClick={p.onReload}>
          <IconReload />
        </ControlButton>
        <ControlButton label="Clear" hint="Wipe the core and reload the program" onClick={p.onRestart}>
          <IconTrash />
        </ControlButton>
      </div>

      <div className="toolbar-right">
        <span className={cx('dirty-dot', p.dirty && 'on')} title="Editor has uncompiled changes — press Reload" />
        <label className="speed">
          Speed
          <input
            type="range"
            min={1}
            max={40}
            value={p.speed}
            onChange={(e) => p.setSpeed(Number(e.target.value))}
          />
          <b>{p.speed}x</b>
        </label>
        <span className="stat-pill" title="lookups recorded by the core">
          {p.lookups.toLocaleString()} lookups
        </span>
      </div>
    </header>
  )
}
