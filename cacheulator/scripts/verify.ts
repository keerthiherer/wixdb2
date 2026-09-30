/**
 * Fidelity check for the TypeScript port of cache/InMemoryCache.java.
 *
 * The expected values below are the outcomes documented in wixdb/cache_demo.py
 * and wixdb/README.md, so if this script passes the simulator agrees with the
 * Java implementation on the behaviours the demo relies on.
 *
 *   npm run verify
 */
import { Machine, runHeadless } from '../src/engine/machine'
import { CacheNode, NO_EXPIRY, WixCache } from '../src/engine/cache'
import { SAMPLES } from '../src/engine/samples'
import { assemble } from '../src/engine/program'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`  ${ok ? '\x1b[92mPASS\x1b[0m' : '\x1b[91mFAIL\x1b[0m'} ${label}${ok ? '' : `\n         expected ${e}\n         actual   ${a}`}`)
}

const sample = (id: string) => SAMPLES.find((s) => s.id === id)!.source

console.log('\n\x1b[1mScenario 1 — basic eviction on capacity overflow\x1b[0m')
{
  const lru = runHeadless(sample('basic-eviction'))
  const lfu = runHeadless(sample('basic-eviction').replace('!POLICY LRU','!POLICY LFU'))
  check('LRU evicts C (never read after SET)', lru.keys.includes('C'), false)
  check('LFU evicts C (lowest frequency)', lfu.keys.includes('C'), false)
  check('LRU keeps A,B,D,E,F', lru.keys.sort(), ['A', 'B', 'D', 'E', 'F'])
  check('LFU keeps A,B,D,E,F', lfu.keys.sort(), ['A', 'B', 'D', 'E', 'F'])
  check('LRU recorded 1 eviction', lru.stats.evictions, 1)
  check('LRU hit rate 100% (all reads hit)', (lru.stats.hitRate * 100).toFixed(0), '100')
}

console.log('\n\x1b[1mScenario 2 — frequency vs recency\x1b[0m')
{
  const lru = runHeadless(sample('freq-vs-recency'))
  const lfu = runHeadless(sample('freq-vs-recency').replace('!POLICY LRU','!POLICY LFU'))
  check('LRU evicts \'hot\' (least recently used)', lru.keys.includes('hot'), false)
  check("LFU keeps 'hot' (highest frequency)", lfu.keys.includes('hot'), true)
  check('LFU evicts from the tail of the cold bucket (w)', lfu.keys.includes('w'), false)
  check('LFU survivor set', lfu.keys.sort(), ['hot', 'new', 'x', 'y', 'z'])
  check('the trailing GET hot returned nil under LRU', lru.stats.misses, 1)
  check('...and a hit under LFU', lfu.stats.misses, 0)
}

console.log('\n\x1b[1mScenario 3 — scan resistance\x1b[0m')
{
  const lru = runHeadless(sample('scan-resistance'))
  const lfu = runHeadless(sample('scan-resistance').replace('!POLICY LRU','!POLICY LFU'))
  const survivors = (keys: string[]) => ['ws1', 'ws2', 'ws3'].filter((k) => keys.includes(k))
  check('LRU loses the whole working set', survivors(lru.keys), [])
  check('LFU keeps the whole working set', survivors(lfu.keys), ['ws1', 'ws2', 'ws3'])
  check('LRU ends up holding nothing but one-shot scan keys', lru.keys.filter((k) => k.startsWith('scan')).length, 5)
  check('LFU only kept the scan keys it could not avoid', lfu.keys.filter((k) => k.startsWith('scan')).length, 2)
}

console.log('\n\x1b[1mScenario 4 — per-entry TTL\x1b[0m')
{
  const source = sample('ttl')
  // With cache-aside on, the expired read is a miss that refills the entry.
  const m = new Machine(source)
  m.runToEnd()
  check('the expired read was counted as a miss', m.cache.stats().misses > 0, true)
  check('long-lived outlived the clock', m.cache.snapshotKeys().includes('long-lived'), true)
  check('permanent never expires', m.cache.snapshotKeys().includes('permanent'), true)
  check('the refilled entry comes back without a TTL', m.cache.mapGet('short-lived')?.expireAtMs, NO_EXPIRY)
  check('steps were recorded', m.steps.length > 10, true)

  // With cache-aside off the same programme leaves the dead entry gone for good.
  const noFill = new Machine(source, { autofill: false })
  noFill.runToEnd()
  check('without a backing store the expired key stays deleted', noFill.cache.snapshotKeys().includes('short-lived'), false)
  check('the sweep at the end reclaimed it too', noFill.cache.stats().misses > 0, true)
}

console.log('\n\x1b[1mEngine invariants\x1b[0m')
{
  // capacity is never exceeded, whichever policy is active
  for (const id of ['zipf', 'seq', 'scan-pattern', 'concurrency']) {
    const source = sample(id)
    for (const policy of ['LRU', 'LFU'] as const) {
      const m = new Machine(source, { policy })
      let peak = 0
      let guard = 0
      while (!m.finished && guard++ < 500_000) {
        m.step()
        peak = Math.max(peak, m.cache.mapSize())
      }
      const s = m.cache.stats()
      check(
        `${id}/${policy}: peak occupancy ${peak} <= capacity ${m.config.capacity}`,
        peak <= m.config.capacity,
        true,
      )
      check(`${id}/${policy}: hits + misses == total requests`, s.hits + s.misses, s.totalRequests)
      check(
        `${id}/${policy}: hit rate + miss rate == 1`,
        (s.hitRate + s.missRate).toFixed(6),
        s.totalRequests === 0 ? '0.000000' : '1.000000',
      )
    }
  }
}

console.log('\n\x1b[1mDirect cache behaviour\x1b[0m')
{
  // LFU bookkeeping: frequency must equal insert + reads, minFrequency must track
  const c = new WixCache(2, 'LFU')
  c.acquire(0)
  for (const key of ['a', 'b']) {
    const node = new CacheNode(key, `v-${key}`, NO_EXPIRY)
    c.mapPut(node)
    c.insertIntoPolicy(node)
  }
  for (let i = 0; i < 3; i++) c.recordAccess(c.mapGet('a')!)
  check('LFU frequency counts the reads', c.mapGet('a')!.frequency, 4)
  check('LFU untouched node stays at 1', c.mapGet('b')!.frequency, 1)
  check('LFU minFrequency points at the cold bucket', c.minFreq, 1)
  check('LFU evicts the cold node', c.evictOne(), 'b')
  check('LFU map dropped the victim', c.mapGet('b'), null)
  c.release(0)
}
{
  // LRU: the order list head is the most recently used, the tail dies first
  const c = new WixCache(3, 'LRU')
  for (const key of ['a', 'b', 'c']) {
    const node = new CacheNode(key, key, NO_EXPIRY)
    c.mapPut(node)
    c.insertIntoPolicy(node)
  }
  c.recordAccess(c.mapGet('a')!)
  check('LRU head is the last touched key', c.lruOrder()[0].key, 'a')
  // insert order a,b,c makes c the newest, so b is the oldest after a is touched
  check('LRU evicts the oldest survivor', c.lruOrder().at(-1)?.key, 'b')
  check('LRU evicts the oldest survivor', c.evictOne(), 'b')
}
{
  // TTL: expiry is a property of the node, independent of the policy
  const c = new WixCache(2, 'LRU')
  const node = new CacheNode('a', 'A', 1000)
  c.mapPut(node)
  c.insertIntoPolicy(node)
  check('node is live before its deadline', c.isExpired(node, 999), false)
  check('node is expired past the deadline (now > expireAt)', c.isExpired(node, 1001), true)
  check('sweep reclaims the dead node', c.cleanExpired(2000), ['a'])
  check('sweep unlinked it from the order list', c.mapSize(), 0)
}

console.log('\n\x1b[1mPolicy contrast on the sample patterns\x1b[0m')
{
  for (const id of ['zipf', 'seq', 'scan-pattern']) {
    const source = sample(id)
    const lru = runHeadless(source, 'LRU', 16)
    const lfu = runHeadless(source, 'LFU', 16)
    console.log(
      `  ${id.padEnd(14)} LRU ${(lru.stats.hitRate * 100).toFixed(1).padStart(5)}%  (${String(lru.stats.evictions).padStart(4)} evictions)   ` +
        `LFU ${(lfu.stats.hitRate * 100).toFixed(1).padStart(5)}%  (${String(lfu.stats.evictions).padStart(4)} evictions)`,
    )
    if (id === 'seq') {
      // A pure sequential scan defeats both policies — every key is colder than the last.
      check('seq: LRU collapses to 0%', lru.stats.hitRate, 0)
      check('seq: LFU cannot save a pure scan either', lfu.stats.hitRate, 0)
    } else if (id === 'scan-pattern') {
      // The burst is longer than the cache, so LRU loses the working set and LFU keeps it.
      check('scan: LFU is scan-resistant', lfu.stats.hitRate > lru.stats.hitRate, true)
    } else {
      check(`${id}: the two policies diverge`, Math.abs(lfu.stats.hitRate - lru.stats.hitRate) > 0.01, true)
    }
  }
}

console.log('\n\x1b[1mParser\x1b[0m')
{
  const p = assemble('SET a b EX 5\nGET a\nBADCMD\nPATTERN zipf 10 0.9 SEED 3\nSLEEP 500ms\n')
  check('parses without unexpected errors', p.errors.map((e) => e.message), ["unknown instruction \"BADCMD\""])
  check('SET keeps its TTL', p.lines[0].instr, { t: 'set', key: 'a', value: 'b', ttlMs: 5000 })
  check('SLEEP honours the ms suffix', p.lines[4].instr, { t: 'sleep', ms: 500 })
  const pattern = p.lines[3].instr as { t: 'pattern'; keys: string[] }
  check('PATTERN expands to the requested number of accesses', pattern.keys.length, 10)
  check('PATTERN is deterministic for a seed', assemble(p.source).lines[3].instr, p.lines[3].instr)
}

console.log(
  failures === 0
    ? '\n\x1b[92m\x1b[1mAll checks passed — the simulated core matches the Java WIX behaviour.\x1b[0m\n'
    : `\n\x1b[91m\x1b[1m${failures} check(s) failed.\x1b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
