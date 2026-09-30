import { useMemo } from 'react'
import { NO_EXPIRY, type WixCache } from '../engine/cache'
import type { SimEvent } from '../engine/types'
import { cx, fmtMs, formatValue, hash32, type DisplayFormat, type WordSize } from '../lib/format'

interface Props {
  cache: WixCache
  policy: 'LRU' | 'LFU'
  capacity: number
  now: number
  lastEvent: SimEvent | null
  lastEventId: number
  displayFormat: DisplayFormat
  wordSize: WordSize
  selected: string | null
  onSelect: (key: string | null) => void
}

const MAX_SLOTS = 24
const TTL_WARN = 1000

/**
 * The die: one physical slot per cache entry, laid out like on-chip SRAM, plus
 * the policy structure that decides who dies next.
 */
export function DieView(p: Props) {
  const entries = p.cache.entries(p.now)
  const byKey = new Map(entries.map((e) => [e.node.key, e]))
  const shown = entries.slice(0, MAX_SLOTS)
  const overflow = Math.max(0, entries.length - MAX_SLOTS)

  const touched = p.lastEvent?.key ?? null
  const order = p.policy === 'LRU' ? p.cache.lruOrder() : p.cache.buckets().flatMap((b) => b.nodes)

  const slots = useMemo(
    () =>
      Array.from({ length: Math.min(p.capacity, MAX_SLOTS) }, (_, i) => {
        const entry = shown[i] ?? null
        const node = entry?.node ?? null
        let state = 'empty'
        if (entry && entry.expired) state = 'expired'
        else if (entry && entry.ttlLeft !== null && entry.ttlLeft <= TTL_WARN) state = 'expiring'
        else if (entry) state = 'live'
        let flash: string | null = null
        if (node && node.key === touched && p.lastEventId > 0) {
          if (p.lastEvent!.kind === 'evict') flash = 'evict'
          else if (p.lastEvent!.kind === 'ttl' && p.lastEvent!.level === 'bad') flash = 'expire'
          else if (p.lastEvent!.kind === 'stats') flash = p.lastEvent!.level === 'good' ? 'hit' : 'miss'
          else if (p.lastEvent!.kind === 'insert') flash = 'write'
        }
        return { entry, node, state, flash }
      }),
    [shown, p.capacity, touched, p.lastEventId, p.lastEvent, p.policy],
  )

  const minFreq = p.cache.minFreq

  return (
    <div className="die-wrap">
      <div className="die-stage">
        <svg className="die-pins" viewBox="0 0 320 300" preserveAspectRatio="none" aria-hidden>
          {Array.from({ length: 11 }, (_, i) => (
            <g key={`t${i}`}>
              <line x1={10 + i * 30} y1={0} x2={10 + i * 30} y2={9} />
              <line x1={10 + i * 30} y1={291} x2={10 + i * 30} y2={300} />
            </g>
          ))}
          {Array.from({ length: 9 }, (_, i) => (
            <g key={`s${i}`}>
              <line x1={0} y1={14 + i * 34} x2={9} y2={14 + i * 34} />
              <line x1={311} y1={14 + i * 34} x2={320} y2={14 + i * 34} />
            </g>
          ))}
        </svg>

        <div className="die">
          <div className="die-substrate" />
          <div className="die-head">
            <span className="die-title">WIX-CORE</span>
            <span className="die-policy" data-policy={p.policy}>
              {p.policy}
            </span>
          </div>
          <div className={cx('die-slots', p.capacity > 12 && 'dense')}>
            {slots.map((slot, i) => {
              if (!slot.node) {
                return (
                  <button key={`empty${i}`} className="slot slot-empty" onClick={() => p.onSelect(null)}>
                    <span className="slot-addr">{i}</span>
                    <span className="slot-empty-mark">—</span>
                  </button>
                )
              }
              const { node, entry } = slot
              const ttl = node.expireAtMs === NO_EXPIRY ? null : (entry?.ttlLeft ?? 0)
              return (
                <button
                  key={node.key}
                  className={cx(
                    'slot',
                    `slot-${slot.state}`,
                    slot.flash && `flash-${slot.flash}`,
                    p.selected === node.key && 'selected',
                  )}
                  onClick={() => p.onSelect(node.key === p.selected ? null : node.key)}
                  title={`${node.key} = ${node.value}\nfreq ${node.frequency}\nttl ${ttl === null ? '∞' : fmtMs(ttl)}`}
                >
                  <span className="slot-addr">{hash32(node.key) % p.capacity}</span>
                  <span className="slot-key">{node.key}</span>
                  <span className="slot-value">{formatValue(node.value, p.displayFormat, p.wordSize)}</span>
                  <span className="slot-meta">
                    <i className="f">f{node.frequency}</i>
                    <i className={cx('t', ttl !== null && ttl <= TTL_WARN && 'warn')}>{ttl === null ? '∞' : fmtMs(ttl)}</i>
                  </span>
                </button>
              )
            })}
            {overflow > 0 && <div className="slot-more">+{overflow} more</div>}
          </div>
          <div className="die-foot">
            <span>
              DBSIZE <b>{entries.length}</b>/{p.capacity}
            </span>
            <span>
              TTL due <b>{entries.filter((e) => e.expired).length}</b>
            </span>
            {byKey.size === 0 && <span className="die-idle">core idle</span>}
          </div>
        </div>
      </div>

      <div className="policy-block">
        <div className="policy-head">
          <span>{p.policy === 'LRU' ? 'order list · head = MRU, tail = next victim' : `frequency buckets · minFrequency = ${minFreq}`}</span>
          {p.policy === 'LFU' && (
            <span className="policy-hint">victim is the tail of bucket[{minFreq}]</span>
          )}
        </div>
        <div className="chain">
          {order.length === 0 && <span className="chain-empty">empty</span>}
          {order.map((node, i) => {
            const victim = p.policy === 'LRU' ? i === order.length - 1 : node.frequency === minFreq
            return (
              <span
                key={node.key}
                className={cx('chain-node', victim && 'victim', node.key === touched && 'touched', node.key === p.selected && 'selected')}
                onClick={() => p.onSelect(node.key === p.selected ? null : node.key)}
                title={`${node.key} · freq ${node.frequency}`}
              >
                <b>{node.key}</b>
                <i>{p.policy === 'LRU' ? `↻${i}` : `f${node.frequency}`}</i>
                {victim && <em>next out</em>}
              </span>
            )
          })}
        </div>
      </div>
    </div>
  )
}
