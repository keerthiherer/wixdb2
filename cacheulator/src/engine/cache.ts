import type { EvictionPolicy, NewEvent, Stats } from './types'

/**
 * Direct port of cache/InMemoryCache.java (Java 23).
 *
 * The Java class is a single big method per operation. To let the simulator
 * stop between individual Java statements, the bodies of put/get/remove/... are
 * kept here as small primitives that mirror those statements one-for-one.
 * engine/ops.ts composes the primitives into generators so the debugger can
 * yield on every one of them.
 *
 * NOTE: ReentrantLock is not simulated with real threads; the machine acquires
 * and releases it explicitly around every operation, which is exactly the
 * critical section the Java lock guards.
 */

export const NO_EXPIRY = Number.POSITIVE_INFINITY

export class CacheNode {
  key: string
  value: string
  expireAtMs: number
  frequency: number
  prev: CacheNode | null = null
  next: CacheNode | null = null

  constructor(key: string, value: string, expireAtMs: number) {
    this.key = key
    this.value = value
    this.expireAtMs = expireAtMs
    this.frequency = 1
  }
}

class DoublyLinkedList {
  readonly head: CacheNode
  readonly tail: CacheNode
  size = 0

  constructor() {
    this.head = new CacheNode('', '', NO_EXPIRY)
    this.tail = new CacheNode('', '', NO_EXPIRY)
    this.head.next = this.tail
    this.tail.prev = this.head
  }

  addFirst(node: CacheNode) {
    node.next = this.head.next
    node.prev = this.head
    this.head.next!.prev = node
    this.head.next = node
    this.size++
  }

  remove(node: CacheNode) {
    if (node.prev != null && node.next != null) {
      node.prev.next = node.next
      node.next.prev = node.prev
      node.prev = null
      node.next = null
      this.size--
    }
  }

  moveToFirst(node: CacheNode) {
    this.remove(node)
    this.addFirst(node)
  }

  removeLast(): CacheNode | null {
    if (this.size === 0) return null
    const last = this.tail.prev!
    this.remove(last)
    return last
  }

  toArray(): CacheNode[] {
    const out: CacheNode[] = []
    let cur = this.head.next
    while (cur && cur !== this.tail) {
      out.push(cur)
      cur = cur.next
    }
    return out
  }
}

export class WixCache {
  readonly capacity: number
  readonly policy: EvictionPolicy

  private readonly map = new Map<string, CacheNode>()
  private readonly lruList = new DoublyLinkedList()
  private readonly freqMap = new Map<number, DoublyLinkedList>()
  private minFrequency = 1

  private hits = 0
  private misses = 0
  private evictions = 0

  onEvent: (e: NewEvent) => void = () => {}

  constructor(capacity: number, policy: EvictionPolicy) {
    if (capacity <= 0) throw new Error('Cache capacity must be strictly greater than 0')
    this.capacity = capacity
    this.policy = policy
  }

  // ── Lock ───────────────────────────────────────────────────────────────────

  private lockOwner: number | null = null
  private lockDepth = 0
  private acquisitions = 0

  acquire(thread: number) {
    this.lockOwner = thread
    this.lockDepth++
    this.acquisitions++
    this.onEvent({
      kind: 'lock',
      level: 'dim',
      thread,
      text: `ReentrantLock.acquire() — thread T${thread} owns the cache lock (depth ${this.lockDepth})`,
    })
  }

  release(thread: number) {
    this.lockDepth--
    if (this.lockDepth === 0) this.lockOwner = null
    this.onEvent({
      kind: 'lock',
      level: 'dim',
      thread,
      text: `ReentrantLock.unlock() — thread T${thread} released the cache lock`,
    })
  }

  get lockHolder(): number | null {
    return this.lockOwner
  }

  get lockAcquisitions(): number {
    return this.acquisitions
  }

  // ── HashMap primitives ─────────────────────────────────────────────────────

  /** Java: map.get(key) */
  mapGet(key: string): CacheNode | null {
    return this.map.get(key) ?? null
  }

  /** Java: map.put(key, node) */
  mapPut(node: CacheNode) {
    this.map.set(node.key, node)
    this.onEvent({
      kind: 'map',
      level: 'info',
      key: node.key,
      text: `HashMap.put("${node.key}") — bucket slot 0x${this.slotOf(node.key).toString(16).toUpperCase().padStart(4, '0')}`,
    })
  }

  mapDelete(key: string): CacheNode | null {
    const node = this.map.get(key)
    if (node) {
      this.map.delete(key)
      this.onEvent({ kind: 'map', level: 'info', key, text: `HashMap.remove("${key}")` })
    }
    return node ?? null
  }

  mapSize(): number {
    return this.map.size
  }

  private slotOf(key: string): number {
    let h = 0
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0
    return h & 0x7fffffff
  }

  // ── TTL ────────────────────────────────────────────────────────────────────

  /** Java: node.isExpired(now) */
  isExpired(node: CacheNode, now: number): boolean {
    const expired = node.expireAtMs !== NO_EXPIRY && now > node.expireAtMs
    if (node.expireAtMs === NO_EXPIRY) {
      this.onEvent({
        kind: 'ttl',
        level: 'dim',
        key: node.key,
        text: `TTL check "${node.key}" — no expiry (persist forever)`,
      })
    } else {
      const left = node.expireAtMs - now
      this.onEvent({
        kind: 'ttl',
        level: expired ? 'bad' : left <= 1000 ? 'warn' : 'info',
        key: node.key,
        text: expired
          ? `TTL check "${node.key}" — EXPIRED ${fmtDuration(-left)} ago, independent of ${this.policy}`
          : `TTL check "${node.key}" — valid, ${fmtDuration(left)} remaining`,
      })
    }
    return expired
  }

  // ── Eviction policy structures ─────────────────────────────────────────────

  /** Java: insertNodeIntoPolicy(node) */
  insertIntoPolicy(node: CacheNode) {
    if (this.policy === 'LRU') {
      this.lruList.addFirst(node)
      this.onEvent({
        kind: 'policy',
        level: 'info',
        key: node.key,
        text: `LRU list.addFirst("${node.key}") — most recently used`,
      })
    } else {
      node.frequency = 1
      this.minFrequency = 1
      let list = this.freqMap.get(1)
      if (!list) {
        list = new DoublyLinkedList()
        this.freqMap.set(1, list)
      }
      list.addFirst(node)
      this.onEvent({
        kind: 'policy',
        level: 'info',
        key: node.key,
        text: `LFU bucket[1].addFirst("${node.key}") — minFrequency = ${this.minFrequency}`,
      })
    }
  }

  /** Java: recordAccess(node) */
  recordAccess(node: CacheNode) {
    if (this.policy === 'LRU') {
      this.lruList.moveToFirst(node)
      this.onEvent({
        kind: 'policy',
        level: 'good',
        key: node.key,
        text: `LRU moveToFirst("${node.key}") — recency updated, order is now [${this.lruOrder()
          .map((n) => n.key)
          .join(' > ')}]`,
      })
    } else {
      const oldFreq = node.frequency
      const list = this.freqMap.get(oldFreq)
      if (list) {
        list.remove(node)
        if (list.size === 0) {
          this.freqMap.delete(oldFreq)
          if (this.minFrequency === oldFreq) this.minFrequency++
        }
      }
      node.frequency++
      let next = this.freqMap.get(node.frequency)
      if (!next) {
        next = new DoublyLinkedList()
        this.freqMap.set(node.frequency, next)
      }
      next.addFirst(node)
      this.onEvent({
        kind: 'policy',
        level: 'good',
        key: node.key,
        text: `LFU bucket[${oldFreq}].remove → bucket[${node.frequency}].addFirst("${node.key}") — minFrequency = ${this.minFrequency}`,
      })
    }
  }

  /** Java: removeNodeFromPolicy(node) */
  detachFromPolicy(node: CacheNode) {
    if (this.policy === 'LRU') {
      this.lruList.remove(node)
      this.onEvent({
        kind: 'policy',
        level: 'dim',
        key: node.key,
        text: `LRU list.remove("${node.key}") — unlinked from the order list`,
      })
    } else {
      const list = this.freqMap.get(node.frequency)
      if (list) {
        list.remove(node)
        if (list.size === 0) this.freqMap.delete(node.frequency)
      }
      this.onEvent({
        kind: 'policy',
        level: 'dim',
        key: node.key,
        text: `LFU bucket[${node.frequency}].remove("${node.key}")`,
      })
    }
  }

  /**
   * Java: cleanExpiredInternal(now) — collect expired keys, then unlink each.
   * Runs before eviction so a full cache full of dead entries does not cause
   * an unnecessary eviction of a live entry.
   */
  cleanExpired(now: number): string[] {
    const expiredKeys: string[] = []
    for (const node of this.map.values()) {
      if (node.expireAtMs !== NO_EXPIRY && now > node.expireAtMs) expiredKeys.push(node.key)
    }
    for (const key of expiredKeys) {
      const node = this.map.get(key)
      if (node) {
        this.map.delete(key)
        this.detachFromPolicy(node)
      }
    }
    if (expiredKeys.length > 0) {
      this.onEvent({
        kind: 'clear',
        level: 'warn',
        text: `sweep() — pruned ${expiredKeys.length} TTL-expired entr${expiredKeys.length === 1 ? 'y' : 'ies'}: ${expiredKeys.join(', ')}`,
      })
    }
    return expiredKeys
  }

  /** Java: evictOne() */
  evictOne(): string | null {
    let evicted: CacheNode | null = null
    if (this.policy === 'LRU') {
      evicted = this.lruList.removeLast()
      if (evicted) {
        this.onEvent({
          kind: 'evict',
          level: 'bad',
          key: evicted.key,
          text: `evictOne() — LRU victim is "${evicted.key}" (tail of the order list)`,
        })
      }
    } else {
      const minList = this.freqMap.get(this.minFrequency)
      if (minList) {
        evicted = minList.removeLast()
        if (minList.size === 0) this.freqMap.delete(this.minFrequency)
        if (evicted) {
          this.onEvent({
            kind: 'evict',
            level: 'bad',
            key: evicted.key,
            text: `evictOne() — LFU victim is "${evicted.key}" (freq ${evicted.frequency} = minFrequency ${this.minFrequency})`,
          })
        }
      }
    }
    if (evicted) {
      this.map.delete(evicted.key)
      this.evictions++
    }
    return evicted ? evicted.key : null
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  recordHit() {
    this.hits++
    this.onEvent({
      kind: 'stats',
      level: 'good',
      text: `stats.hits++ → ${this.hits}   (hit rate ${(this.stats().hitRate * 100).toFixed(2)}%)`,
    })
  }

  recordMiss(reason: string, key: string) {
    this.misses++
    this.onEvent({
      kind: 'stats',
      level: 'bad',
      key,
      text: `stats.misses++ → ${this.misses}  (${reason}; miss rate ${(this.stats().missRate * 100).toFixed(2)}%)`,
    })
  }

  stats(): Stats {
    const totalRequests = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      totalRequests,
      hitRate: totalRequests === 0 ? 0 : this.hits / totalRequests,
      missRate: totalRequests === 0 ? 0 : this.misses / totalRequests,
    }
  }

  // ── Views for the die / register panels ────────────────────────────────────

  lruOrder(): CacheNode[] {
    return this.lruList.toArray()
  }

  buckets(): { freq: number; nodes: CacheNode[] }[] {
    return [...this.freqMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([freq, list]) => ({ freq, nodes: list.toArray() }))
  }

  get minFreq(): number {
    return this.minFrequency
  }

  liveSize(now: number): number {
    let n = 0
    for (const node of this.map.values()) if (!(node.expireAtMs !== NO_EXPIRY && now > node.expireAtMs)) n++
    return n
  }

  entries(now: number): { node: CacheNode; expired: boolean; ttlLeft: number | null }[] {
    return [...this.map.values()].map((node) => {
      const expired = node.expireAtMs !== NO_EXPIRY && now > node.expireAtMs
      return { node, expired, ttlLeft: node.expireAtMs === NO_EXPIRY ? null : node.expireAtMs - now }
    })
  }

  snapshotKeys(): string[] {
    return [...this.map.keys()].sort()
  }

  clear() {
    this.map.clear()
    this.freqMap.clear()
    this.minFrequency = 1
    this.lruList.size = 0
    this.lruList.head.next = this.lruList.tail
    this.lruList.tail.prev = this.lruList.head
  }
}

export function statsOf(hits: number, misses: number, evictions: number): Stats {
  const totalRequests = hits + misses
  return {
    hits,
    misses,
    evictions,
    totalRequests,
    hitRate: totalRequests === 0 ? 0 : hits / totalRequests,
    missRate: totalRequests === 0 ? 0 : misses / totalRequests,
  }
}

export function fmtDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 1000) return `${Math.round(abs)}ms`
  if (abs < 60_000) return `${(abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}s`
  const m = Math.floor(abs / 60_000)
  const s = Math.round((abs % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}
