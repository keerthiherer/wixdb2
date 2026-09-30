import { useEffect, useMemo, useRef } from 'react'
import type { Machine, TerminalLine } from '../engine/machine'
import type { Comparison } from '../hooks/useSimulator'
import { cx, fmtMs, formatClock } from '../lib/format'
import { IconGauge } from './icons'

export function TerminalView({ lines }: { lines: TerminalLine[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])
  return (
    <div className="terminal" ref={ref}>
      {lines.length === 0 && <div className="term-dim">wix&gt; no commands issued yet</div>}
      {lines.map((l) => (
        <div key={l.id} className={cx('term-line', `term-${l.tone}`)}>
          {l.text.replace(/\r\n/g, ' ')}
        </div>
      ))}
      <div className="term-cursor" />
    </div>
  )
}

interface DeviceRow {
  range: string
  size: string
  irq: string
  name: string
  state: string
  usage: number
  tone?: 'good' | 'warn' | 'bad'
}

export function DevicesTable({ machine: m }: { machine: Machine }) {
  const rows: DeviceRow[] = useMemo(() => {
    const size = m.cache.liveSize(m.clock.t)
    const entries = m.cache.entries(m.clock.t)
    const expiring = entries.filter((e) => e.ttlLeft !== null).length
    const expiringSoon = entries.filter((e) => e.ttlLeft !== null && e.ttlLeft <= 1000).length
    const order = m.cache.lruOrder()
    const buckets = m.cache.buckets()
    const s = m.cache.stats()
    const policyName = m.config.policy === 'LRU' ? 'LRU Order List' : 'LFU Bucket Table'
    const policyState =
      m.config.policy === 'LRU'
        ? order.length
          ? `head ${order[0].key} → tail ${order[order.length - 1].key}`
          : 'empty'
        : `${buckets.length} buckets, minFrequency ${m.cache.minFreq}`
    return [
      {
        range: '0x0000–0x00FF',
        size: '256 B',
        irq: '0',
        name: 'HashMap Store',
        state: `${size} live node(s)`,
        usage: size / m.config.capacity,
      },
      {
        range: '0x0100–0x01FF',
        size: '256 B',
        irq: '1',
        name: policyName,
        state: policyState,
        usage: size / m.config.capacity,
        tone: size >= m.config.capacity ? 'warn' : undefined,
      },
      {
        range: '0x0200–0x02FF',
        size: '256 B',
        irq: '2',
        name: 'TTL Timer Wheel',
        state: expiring === 0 ? 'no timers armed' : `${expiring} armed, ${expiringSoon} due within 1s`,
        usage: expiring / Math.max(1, m.config.capacity),
        tone: expiringSoon > 0 ? 'warn' : undefined,
      },
      {
        range: '0x0300–0x03FF',
        size: '256 B',
        irq: '3',
        name: 'Stats Counter Block',
        state: `${s.hits} hits / ${s.misses} misses`,
        usage: s.hitRate,
        tone: s.hitRate >= 0.7 ? 'good' : s.hitRate < 0.4 ? 'bad' : undefined,
      },
      {
        range: '0x0400–0x043F',
        size: '64 B',
        irq: '4',
        name: 'ReentrantLock',
        state: m.cache.lockHolder !== null ? `held by T${m.cache.lockHolder}` : 'free',
        usage: m.cache.lockHolder !== null ? 1 : 0,
        tone: m.cache.lockHolder !== null ? 'good' : undefined,
      },
    ]
  }, [m, m.cache, m.clock.t, m.steps.length])

  return (
    <div className="devices">
      <table className="device-table">
        <thead>
          <tr>
            <th>address range</th>
            <th>size</th>
            <th>irq</th>
            <th>device</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className="mono dim">{r.range}</td>
              <td className="mono dim">{r.size}</td>
              <td className="mono dim">{r.irq}</td>
              <td>
                <div className="device-name">
                  <b>{r.name}</b>
                  <span className={cx('device-state', r.tone && `dev-${r.tone}`)}>{r.state}</span>
                  <div className="device-bar">
                    <i style={{ width: `${Math.min(100, Math.max(2, r.usage * 100))}%` }} className={cx(r.tone && `bar-${r.tone}`)} />
                  </div>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Donut({ value, tone }: { value: number; tone: 'hit' | 'miss' }) {
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <svg className="donut" viewBox="0 0 84 84">
      <circle cx="42" cy="42" r={r} className="donut-track" />
      <circle
        cx="42"
        cy="42"
        r={r}
        className={cx('donut-value', `donut-${tone}`)}
        strokeDasharray={`${c * Math.max(0, Math.min(1, value))} ${c}`}
        transform="rotate(-90 42 42)"
      />
      <text x="42" y="39" textAnchor="middle" className="donut-num">
        {(value * 100).toFixed(1)}
      </text>
      <text x="42" y="53" textAnchor="middle" className="donut-pct">
        %
      </text>
    </svg>
  )
}

function pathFor(values: number[], w: number, h: number): string {
  if (values.length < 2) return ''
  const step = w / (values.length - 1)
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(h - v * h).toFixed(2)}`)
    .join(' ')
}

const W = 520
const H = 120

export function MetricsPanel({ machine: m, comparison, onRunComparison }: { machine: Machine; comparison: Comparison | null; onRunComparison: () => void }) {
  const s = m.stats()
  const history = m.history
  const ribbon = m.ribbon.slice(-180)
  const hitPath = pathFor(history.map((h) => h.hitRate), W, H)
  const missPath = pathFor(history.map((h) => h.missRate), W, H)
  const evictPath = pathFor(history.map((h) => h.evictions / Math.max(1, m.config.capacity * 2)), W, H)

  return (
    <div className="metrics">
      <div className="metric-gauges">
        <div className="gauge-card hit">
          <Donut value={s.hitRate} tone="hit" />
          <div>
            <b>cache hit rate</b>
            <small>
              {s.hits.toLocaleString()} hits of {s.totalRequests.toLocaleString()} lookups
            </small>
            <em>returns a live, unexpired entry</em>
          </div>
        </div>
        <div className="gauge-card miss">
          <Donut value={s.missRate} tone="miss" />
          <div>
            <b>cache miss rate</b>
            <small>
              {s.misses.toLocaleString()} misses of {s.totalRequests.toLocaleString()} lookups
            </small>
            <em>absent or TTL-expired → backing store</em>
          </div>
        </div>
      </div>

      <div className="counter-grid">
        {(
          [
            ['hits', s.hits, 'good'],
            ['misses', s.misses, 'bad'],
            ['evictions', s.evictions, 'warn'],
            ['requests', s.totalRequests, ''],
            ['dbsize', m.cache.liveSize(m.clock.t), ''],
            ['clock', formatClock(m.clock.t), ''],
          ] as [string, number | string, string][]
        ).map(([label, value, tone]) => (
          <div key={label} className={cx('counter', tone && `c-${tone}`)}>
            <span>{label}</span>
            <b>{typeof value === 'number' ? value.toLocaleString() : value}</b>
          </div>
        ))}
      </div>

      <section className="metric-block">
        <header>
          <IconGauge size={13} />
          <span>hit &amp; miss rate over the sample access pattern</span>
        </header>
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <line key={g} x1={0} x2={W} y1={H - g * H} y2={H - g * H} className="chart-grid" />
          ))}
          <path d={hitPath} className="chart-hit" />
          <path d={missPath} className="chart-miss" />
          <path d={evictPath} className="chart-evict" />
        </svg>
        <div className="chart-legend">
          <span className="lg lg-hit">hit rate</span>
          <span className="lg lg-miss">miss rate</span>
          <span className="lg lg-evict">eviction pressure</span>
          <span className="dim mono">{history.length} lookups</span>
        </div>
        <div className="ribbon" title="one cell per lookup, newest on the right">
          {ribbon.length === 0 && <div className="empty">run the program to populate the access pattern</div>}
          {ribbon.map((r) => (
            <i
              key={r.i}
              className={cx('ribbon-cell', r.outcome === 'hit' ? 'r-hit' : 'r-miss', r.evicted.length > 0 && 'r-evict', r.expired && 'r-expired')}
              title={`#${r.i} ${r.key} — ${r.outcome}${r.evicted.length ? ` · evicted ${r.evicted.join(',')}` : ''}`}
            />
          ))}
        </div>
      </section>

      <section className="metric-block">
        <header>
          <IconGauge size={13} />
          <span>same program, both eviction policies</span>
          <button className="mini-btn primary" onClick={onRunComparison}>
            run A/B
          </button>
        </header>
        {!comparison && (
          <div className="empty">
            press <b>run A/B</b> to replay this program on a throwaway LRU core and a throwaway LFU core and compare the metrics
          </div>
        )}
        {comparison && (
          <>
            <table className="cmp-table">
              <thead>
                <tr>
                  <th>metric</th>
                  <th className="cmp-lru">LRU</th>
                  <th className="cmp-lfu">LFU</th>
                  <th>delta</th>
                </tr>
              </thead>
              <tbody>
                {cmpRow('hit rate', comparison.lru.stats.hitRate, comparison.lfu.stats.hitRate, true)}
                {cmpRow('miss rate', comparison.lru.stats.missRate, comparison.lfu.stats.missRate, false)}
                {cmpRow('hits', comparison.lru.stats.hits, comparison.lfu.stats.hits, true)}
                {cmpRow('misses', comparison.lru.stats.misses, comparison.lfu.stats.misses, false)}
                {cmpRow('evictions', comparison.lru.stats.evictions, comparison.lfu.stats.evictions, false)}
                <tr>
                  <td className="dim">survivors</td>
                  <td className="mono cmp-lru" colSpan={3}>
                    LRU keeps {comparison.lru.keys.length} key(s): {comparison.lru.keys.slice(0, 8).join(' ')}
                    {comparison.lru.keys.length > 8 ? ' …' : ''}
                  </td>
                </tr>
                <tr>
                  <td className="dim">survivors</td>
                  <td className="mono cmp-lfu" colSpan={3}>
                    LFU keeps {comparison.lfu.keys.length} key(s): {comparison.lfu.keys.slice(0, 8).join(' ')}
                    {comparison.lfu.keys.length > 8 ? ' …' : ''}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="ab-strip">
              <div className="ab-row">
                <span>LRU</span>
                <div className="ab-cells">
                  {comparison.lru.ribbon.slice(0, 140).map((r) => (
                    <i key={r.i} className={cx('ab-cell', r.outcome === 'hit' ? 'r-hit' : 'r-miss', r.evicted.length > 0 && 'r-evict')} />
                  ))}
                </div>
              </div>
              <div className="ab-row">
                <span>LFU</span>
                <div className="ab-cells">
                  {comparison.lfu.ribbon.slice(0, 140).map((r) => (
                    <i key={r.i} className={cx('ab-cell', r.outcome === 'hit' ? 'r-hit' : 'r-miss', r.evicted.length > 0 && 'r-evict')} />
                  ))}
                </div>
              </div>
            </div>
            <p className="ab-note">
              {verdict(comparison)}
            </p>
          </>
        )}
      </section>

      {m.threads.length > 0 && (
        <section className="metric-block">
          <header>
            <IconGauge size={13} />
            <span>thread safety</span>
          </header>
          <div className="counter-grid">
            <div className="counter">
              <span>virtual threads</span>
              <b>{m.threads.length}</b>
            </div>
            <div className="counter c-good">
              <span>lock acquisitions</span>
              <b>{m.cache.lockAcquisitions}</b>
            </div>
            <div className="counter">
              <span>still blocked</span>
              <b>{m.threads.filter((t) => t.state === 'queued').length}</b>
            </div>
            <div className="counter">
              <span>sim clock</span>
              <b>{fmtMs(m.clock.t)}</b>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function cmpRow(label: string, lru: number, lfu: number, higherIsBetter: boolean) {
  const fmt = (v: number) => (v <= 1 && label.includes('rate') ? `${(v * 100).toFixed(1)}%` : v.toLocaleString())
  const delta = lfu - lru
  const better = higherIsBetter ? delta > 0 : delta < 0
  const same = Math.abs(delta) < (label.includes('rate') ? 0.0005 : 0.5)
  return (
    <tr key={label}>
      <td className="dim">{label}</td>
      <td className="mono cmp-lru">{fmt(lru)}</td>
      <td className="mono cmp-lfu">{fmt(lfu)}</td>
      <td className={cx('mono', !same && (better ? 'delta-good' : 'delta-bad'))}>{same ? '—' : `${delta > 0 ? '+' : ''}${fmt(delta)}`}</td>
    </tr>
  )
}

function verdict(c: Comparison): string {
  const d = c.lfu.stats.hitRate - c.lru.stats.hitRate
  if (Math.abs(d) < 0.005) return 'Both policies land on the same hit rate for this workload — the pattern does not separate them.'
  if (d > 0) {
    return `LFU wins by ${(d * 100).toFixed(1)} points: frequency tracking protects the working set from the one-shot accesses that LRU keeps evicting.`
  }
  return `LRU wins by ${(-d * 100).toFixed(1)} points: when recency predicts future access, recency is the better signal than raw counts.`
}
