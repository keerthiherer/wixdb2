import { useMemo, useState } from 'react'
import { NO_EXPIRY, type WixCache } from '../engine/cache'
import type { Machine, WatchKind } from '../engine/machine'
import type { SimEvent } from '../engine/types'
import { cx, fmtMs, formatClock, formatValue, hash32, type DisplayFormat, type WordSize } from '../lib/format'
import { DieView } from './DieView'
import { IconPlus, IconTrash } from './icons'

type Tab = 'registers' | 'threads' | 'trace' | 'breakpoints' | 'watchpoints' | 'symbols'

const TABS: { id: Tab; label: string }[] = [
  { id: 'registers', label: 'Registers' },
  { id: 'threads', label: 'Threads' },
  { id: 'trace', label: 'Trace' },
  { id: 'breakpoints', label: 'Breakpoints' },
  { id: 'watchpoints', label: 'Watchpoints' },
  { id: 'symbols', label: 'Symbols' },
]

const TRACE_FILTERS: (SimEvent['kind'] | 'all')[] = ['all', 'stats', 'evict', 'ttl', 'policy', 'map', 'lock', 'store']

interface Props {
  machine: Machine
  displayFormat: DisplayFormat
  setDisplayFormat: (f: DisplayFormat) => void
  wordSize: WordSize
  setWordSize: (w: WordSize) => void
  showLines: boolean
  setShowLines: (v: boolean) => void
  selected: string | null
  setSelected: (k: string | null) => void
  addWatch: (kind: WatchKind, value: string) => void
  tick: () => void
}

export function LeftPanel(p: Props) {
  const [tab, setTab] = useState<Tab>('registers')
  const m = p.machine
  const lastEvent = m.trace[m.trace.length - 1] ?? null

  return (
    <aside className="panel left">
      <DieView
        cache={m.cache}
        policy={m.config.policy}
        capacity={m.config.capacity}
        now={m.clock.t}
        lastEvent={lastEvent}
        lastEventId={lastEvent?.id ?? 0}
        displayFormat={p.displayFormat}
        wordSize={p.wordSize}
        selected={p.selected}
        onSelect={p.setSelected}
      />

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={cx('tab', tab === t.id && 'active')} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'breakpoints' && m.breakpoints.size > 0 && <i className="badge">{m.breakpoints.size}</i>}
            {t.id === 'watchpoints' && m.watchpoints.length > 0 && <i className="badge">{m.watchpoints.length}</i>}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === 'registers' && <Registers cache={m.cache} now={m.clock.t} {...p} />}
        {tab === 'threads' && <Threads machine={m} />}
        {tab === 'trace' && <Trace machine={m} />}
        {tab === 'breakpoints' && <Breakpoints machine={m} tick={p.tick} />}
        {tab === 'watchpoints' && <Watchpoints machine={m} addWatch={p.addWatch} tick={p.tick} />}
        {tab === 'symbols' && <Symbols {...p} />}
      </div>

      <div className="settings">
        <div className="settings-row">
          <span>Number format</span>
          <div className="seg">
            {(['hex', 'dec', 'text'] as DisplayFormat[]).map((f) => (
              <button key={f} className={cx(p.displayFormat === f && 'on')} onClick={() => p.setDisplayFormat(f)}>
                {f === 'hex' ? 'Hex' : f === 'dec' ? 'Dec' : 'Text'}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>Word size</span>
          <div className="seg">
            {([8, 16, 32, 64] as WordSize[]).map((w) => (
              <button key={w} className={cx(p.wordSize === w && 'on')} onClick={() => p.setWordSize(w)}>
                {w}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>Line numbers</span>
          <div className="seg">
            <button className={cx(p.showLines && 'on')} onClick={() => p.setShowLines(true)}>
              on
            </button>
            <button className={cx(!p.showLines && 'on')} onClick={() => p.setShowLines(false)}>
              off
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function Registers({ cache, now, selected, setSelected, displayFormat, wordSize }: Props & { cache: WixCache; now: number }) {
  const entries = cache.entries(now)
  const [sort, setSort] = useState<'slot' | 'freq' | 'ttl'>('slot')
  const ordered = useMemo(() => {
    const list = [...entries]
    if (sort === 'freq') list.sort((a, b) => b.node.frequency - a.node.frequency)
    else if (sort === 'ttl')
      list.sort((a, b) => (a.ttlLeft ?? Infinity) - (b.ttlLeft ?? Infinity))
    else list.sort((a, b) => hash32(a.node.key) - hash32(b.node.key))
    return list
  }, [entries, sort])

  return (
    <>
      <div className="reg-toolbar">
        <span>cache state · {entries.length}/{cache.capacity} slots</span>
        <div className="seg tiny">
          {(['slot', 'freq', 'ttl'] as const).map((s) => (
            <button key={s} className={cx(sort === s && 'on')} onClick={() => setSort(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="reg-scroll">
        <table className="reg-table">
          <thead>
            <tr>
              <th>slot</th>
              <th>key</th>
              <th>value</th>
              <th>len</th>
              <th>freq</th>
              <th>ttl</th>
            </tr>
          </thead>
          <tbody>
            {ordered.length === 0 && (
              <tr className="empty-row">
                <td colSpan={6}>no entries — DBSIZE is 0</td>
              </tr>
            )}
            {ordered.map(({ node, expired, ttlLeft }) => (
              <tr
                key={node.key}
                className={cx(expired && 'row-expired', selected === node.key && 'row-selected')}
                onClick={() => setSelected(selected === node.key ? null : node.key)}
              >
                <td className="mono dim">{formatValue(String(hash32(node.key) % cache.capacity), displayFormat, wordSize)}</td>
                <td className="mono">{node.key}</td>
                <td className="mono val">{formatValue(node.value, displayFormat, wordSize)}</td>
                <td className="mono dim">{new TextEncoder().encode(node.value).length}</td>
                <td className="mono">{node.frequency.toString()}</td>
                <td className="mono">
                  {node.expireAtMs === NO_EXPIRY ? (
                    <span className="dim">∞</span>
                  ) : expired ? (
                    <span className="bad">expired</span>
                  ) : (
                    <span className={cx(ttlLeft !== null && ttlLeft <= 1000 && 'warn')}>{fmtMs(ttlLeft ?? 0)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Threads({ machine: m }: { machine: Machine }) {
  const rows = [
    { id: 0, state: m.finished ? 'done' : 'running', command: 'main — request thread' },
    ...m.threads,
  ]
  return (
    <>
      <div className="lock-banner">
        <span className={cx('lock-dot', m.cache.lockHolder !== null && 'held')} />
        <div>
          <b>ReentrantLock {m.cache.lockHolder !== null ? `held by T${m.cache.lockHolder}` : 'free'}</b>
          <small>
            {m.cache.lockAcquisitions} acquisitions · {m.threads.filter((t) => t.state === 'queued').length} thread(s) blocked · Java 23 virtual
            threads
          </small>
        </div>
      </div>
      <table className="reg-table">
        <thead>
          <tr>
            <th>thread</th>
            <th>state</th>
            <th>command</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="mono">T{t.id}</td>
              <td>
                <span className={cx('pill', `pill-${t.state}`)}>{t.state}</span>
              </td>
              <td className="mono dim">{t.command}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Trace({ machine: m }: { machine: Machine }) {
  const [filter, setFilter] = useState<SimEvent['kind'] | 'all'>('all')
  const events = m.trace.filter((e) => filter === 'all' || e.kind === filter)
  return (
    <>
      <div className="reg-toolbar">
        <span>micro-step trace · {events.length} events</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as SimEvent['kind'] | 'all')}>
          {TRACE_FILTERS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <div className="trace-list">
        {events.length === 0 && <div className="empty">no events yet — press Step Into</div>}
        {events
          .slice(-260)
          .reverse()
          .map((e) => (
            <div key={e.id} className={cx('trace-row', `lvl-${e.level}`)}>
              <span className="trace-kind">{e.kind}</span>
              {e.thread !== undefined && <span className="trace-thread">T{e.thread}</span>}
              <span className="trace-text">{e.text}</span>
            </div>
          ))}
      </div>
    </>
  )
}

function Breakpoints({ machine: m, tick }: { machine: Machine; tick: () => void }) {
  const lines = [...m.breakpoints].sort((a, b) => a - b)
  return (
    <>
      <div className="reg-toolbar">
        <span>{lines.length} breakpoint(s)</span>
        <button
          className="mini-btn"
          disabled={m.currentLine === null}
          onClick={() => {
            if (m.currentLine !== null) m.toggleBreakpoint(m.currentLine)
            tick()
          }}
        >
          <IconPlus size={12} /> add at pc
        </button>
      </div>
      <div className="wp-list">
        {lines.length === 0 && <div className="empty">click a line number in the editor to set a breakpoint</div>}
        {lines.map((line) => (
          <div key={line} className="wp-row">
            <span className="bp-dot" />
            <span className="mono">line {line}</span>
            <span className="wp-src mono dim">{m.program.lines[line - 1]?.raw.trim() || '(blank)'}</span>
            <button
              className="mini-btn"
              onClick={() => {
                m.toggleBreakpoint(line)
                tick()
              }}
            >
              <IconTrash size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

function Watchpoints({ machine: m, addWatch, tick }: { machine: Machine; addWatch: (k: WatchKind, v: string) => void; tick: () => void }) {
  const [kind, setKind] = useState<WatchKind>('key')
  const [value, setValue] = useState('')
  return (
    <>
      <form
        className="wp-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!value.trim()) return
          addWatch(kind, value.trim())
          setValue('')
        }}
      >
        <select value={kind} onChange={(e) => setKind(e.target.value as WatchKind)}>
          <option value="key">key touched</option>
          <option value="eviction">any eviction</option>
          <option value="hitrate">hit rate below %</option>
        </select>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={kind === 'hitrate' ? '85' : kind === 'key' ? 'user:1' : '1'}
          disabled={kind === 'eviction'}
        />
        <button className="mini-btn primary" type="submit">
          add
        </button>
      </form>
      <div className="wp-list">
        {m.watchpoints.length === 0 && <div className="empty">no watchpoints</div>}
        {m.watchpoints.map((w) => (
          <div key={w.id} className={cx('wp-row', !w.enabled && 'off')}>
            <span className={cx('wp-dot', w.enabled && 'on')} />
            <span className="mono">
              {w.kind === 'key' ? `key "${w.value}"` : w.kind === 'eviction' ? 'any eviction' : `hit rate < ${w.value}%`}
            </span>
            <span className="wp-trips">{w.trips}×</span>
            <button className="mini-btn" onClick={() => m.toggleWatchpoint(w.id)}>
              {w.enabled ? 'off' : 'on'}
            </button>
            <button
              className="mini-btn"
              onClick={() => {
                m.removeWatchpoint(w.id)
                tick()
              }}
            >
              <IconTrash size={12} />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

function Symbols({ machine: m, displayFormat, wordSize }: Props) {
  const info = m.info()
  const rows: [string, string][] = [
    ['eviction_policy', info.eviction_policy],
    ['max_capacity', formatValue(String(info.max_capacity), displayFormat, wordSize)],
    ['current_size', formatValue(String(info.current_size), displayFormat, wordSize)],
    ['autofill', m.config.autofill ? 'on' : 'off'],
    ['tick_ms', formatValue(String(m.config.tickMs), displayFormat, wordSize)],
    ['sim_clock', formatClock(m.clock.t)],
    ['pc', m.currentLine === null ? 'end' : `line ${m.currentLine}`],
    ['min_frequency', formatValue(String(m.cache.minFreq), displayFormat, wordSize)],
    ['lock_acquisitions', formatValue(String(m.cache.lockAcquisitions), displayFormat, wordSize)],
    ['virtual_threads', formatValue(String(m.threads.length), displayFormat, wordSize)],
  ]
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>symbol</th>
          <th>value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="mono dim">{k}</td>
            <td className="mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
