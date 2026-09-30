import { CacheNode, NO_EXPIRY, WixCache } from './cache'
import type { Instr } from './program'
import type { NewEvent } from './types'

/**
 * Each generator mirrors one public method of InMemoryCache.java. Every `yield`
 * is a place where a Java statement boundary sits, so "Step Into" advances the
 * core by one statement at a time. The `return` value is what the terminal
 * (the RESP writer in the real server) would emit back to the client.
 */

export interface OpCtx {
  cache: WixCache
  clock: { t: number }
  thread: number
  autofill: boolean
  store: Map<string, string>
  onEvent: (e: NewEvent) => void
}

export type OpResult =
  | { t: 'get'; key: string; value: string | null; outcome: 'hit' | 'absent' | 'expired'; filled: boolean }
  | { t: 'set'; key: string; value: string; ttlMs: number | null; replaced: boolean; evicted: string | null; swept: string[] }
  | { t: 'del'; removed: string[] }
  | { t: 'exists'; key: string; exists: boolean }
  | { t: 'keys'; keys: string[] }
  | { t: 'dbsize'; size: number }
  | { t: 'ttl'; key: string; remaining: number | null }
  | { t: 'flush'; count: number }
  | { t: 'clean'; removed: string[] }
  | { t: 'info' }
  | { t: 'config'; param: string; value: string }
  | { t: 'sleep'; ms: number }
  | { t: 'spawn'; count: number }
  | { t: 'pattern'; kind: string; count: number; hits: number; misses: number; evictions: number }
  | { t: 'error'; message: string }
  | { t: 'nop' }

export type OpGenerator = Generator<string, OpResult, void>

interface InsertResult {
  evicted: string | null
  swept: string[]
}

type InsertGenerator = Generator<string, InsertResult, void>

function probe(ctx: OpCtx, key: string, node: CacheNode | null): CacheNode | null {
  ctx.onEvent({
    kind: 'map',
    level: node ? 'good' : 'bad',
    key,
    text: node ? `HashMap.get("${key}") → hit, node found` : `HashMap.get("${key}") → nil, no such node`,
  })
  return node
}

function originRead(ctx: OpCtx, key: string): string {
  const found = ctx.store.get(key)
  if (found !== undefined) {
    ctx.onEvent({ kind: 'store', level: 'info', key, text: `backing store read "${key}" → "${found}"` })
    return found
  }
  const synthesized = `payload-${key}`
  ctx.store.set(key, synthesized)
  ctx.onEvent({ kind: 'store', level: 'info', key, text: `backing store read "${key}" → "${synthesized}" (origin row materialised)` })
  return synthesized
}

/** Java: the tail of put() — sweep, evict, allocate, link into the policy. */
function* insertNode(ctx: OpCtx, key: string, value: string, ttlMs: number | null): InsertGenerator {
  const cache = ctx.cache
  const now = ctx.clock.t
  const expireAtMs = ttlMs === null ? NO_EXPIRY : now + ttlMs
  let swept: string[] = []
  let evicted: string | null = null

  yield 'capacity guard'
  if (cache.mapSize() >= cache.capacity) {
    swept = cache.cleanExpired(now)
    yield 'sweep expired'
  }

  yield 'eviction guard'
  if (cache.mapSize() >= cache.capacity) {
    evicted = cache.evictOne()
    yield 'evict victim'
  }

  yield 'allocate node'
  const node = new CacheNode(key, value, expireAtMs)
  cache.mapPut(node)
  cache.insertIntoPolicy(node)
  ctx.store.set(key, value)
  if (ttlMs !== null) {
    ctx.onEvent({
      kind: 'ttl',
      level: 'info',
      key,
      text: `expireAtMs = now + ${ttlMs}ms — per-entry TTL stored on the node, independent of ${cache.policy}`,
    })
  }
  yield 'link into policy'
  return { evicted, swept }
}

function* opSet(ctx: OpCtx, key: string, value: string, ttlMs: number | null): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)

  const existing = probe(ctx, key, cache.mapGet(key))
  yield 'hashmap probe'

  if (existing) {
    existing.value = value
    existing.expireAtMs = ttlMs === null ? NO_EXPIRY : ctx.clock.t + ttlMs
    ctx.onEvent({
      kind: 'insert',
      level: 'warn',
      key,
      text: `existing node updated in place — value := "${value}"${ttlMs === null ? ', TTL := ∞' : `, expireAtMs := now + ${ttlMs}ms`}`,
    })
    yield 'overwrite node'
    cache.recordAccess(existing)
    yield 'record access'
    cache.release(ctx.thread)
    yield 'unlock'
    return { t: 'set', key, value, ttlMs, replaced: true, evicted: null, swept: [] }
  }

  const { evicted, swept } = yield* insertNode(ctx, key, value, ttlMs)
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'set', key, value, ttlMs, replaced: false, evicted, swept }
}

function* opGet(ctx: OpCtx, key: string): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)

  const node = probe(ctx, key, cache.mapGet(key))
  yield 'hashmap probe'

  if (!node) {
    cache.recordMiss('key absent', key)
    yield 'count miss'
    if (ctx.autofill) {
      ctx.onEvent({
        kind: 'store',
        level: 'warn',
        key,
        text: `miss → application layer falls back to the backing store (cache-aside)`,
      })
      yield 'cache-aside read'
      const value = originRead(ctx, key)
      yield 'cache-aside read'
      yield* insertNode(ctx, key, value, null)
      cache.release(ctx.thread)
      yield 'unlock'
      return { t: 'get', key, value, outcome: 'absent', filled: true }
    }
    cache.release(ctx.thread)
    yield 'unlock'
    return { t: 'get', key, value: null, outcome: 'absent', filled: false }
  }

  const expired = cache.isExpired(node, ctx.clock.t)
  yield 'ttl guard'
  if (expired) {
    cache.detachFromPolicy(node)
    cache.mapDelete(key)
    yield 'unlink expired'
    cache.recordMiss('TTL expired', key)
    yield 'count miss'
    if (ctx.autofill) {
      const value = originRead(ctx, key)
      yield 'cache-aside read'
      yield* insertNode(ctx, key, value, null)
      cache.release(ctx.thread)
      yield 'unlock'
      return { t: 'get', key, value, outcome: 'expired', filled: true }
    }
    cache.release(ctx.thread)
    yield 'unlock'
    return { t: 'get', key, value: null, outcome: 'expired', filled: false }
  }

  cache.recordHit()
  cache.recordAccess(node)
  yield 'record access'
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'get', key, value: node.value, outcome: 'hit', filled: false }
}

function* opDel(ctx: OpCtx, keys: string[]): OpGenerator {
  const cache = ctx.cache
  const removed: string[] = []
  yield 'lock'
  cache.acquire(ctx.thread)
  for (const key of keys) {
    const node = cache.mapDelete(key)
    if (node) {
      cache.detachFromPolicy(node)
      removed.push(key)
    } else {
      ctx.onEvent({ kind: 'delete', level: 'dim', key, text: `DEL "${key}" → not present` })
    }
    yield `del ${key}`
  }
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'del', removed }
}

function* opExists(ctx: OpCtx, key: string): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)
  const node = probe(ctx, key, cache.mapGet(key))
  yield 'hashmap probe'
  let exists = false
  if (node) {
    const expired = cache.isExpired(node, ctx.clock.t)
    yield 'ttl guard'
    if (expired) {
      cache.detachFromPolicy(node)
      cache.mapDelete(key)
      ctx.onEvent({ kind: 'delete', level: 'warn', key, text: `expired key removed on a lazy read` })
    } else {
      exists = true
      ctx.onEvent({
        kind: 'policy',
        level: 'dim',
        key,
        text: `containsKey() is read-only — ${cache.policy} order untouched, hit/miss counters untouched`,
      })
    }
    yield 'resolve'
  }
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'exists', key, exists }
}

function* opKeys(ctx: OpCtx, pattern: string): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)
  const swept = cache.cleanExpired(ctx.clock.t)
  yield 'sweep expired'
  const all = cache.snapshotKeys()
  const prefix = pattern === '*' ? '' : pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
  const keys = prefix === '' ? all : all.filter((k) => k.startsWith(prefix))
  ctx.onEvent({ kind: 'map', level: 'info', text: `KEYS ${pattern} → ${keys.length} live key(s)` })
  yield 'filter'
  cache.release(ctx.thread)
  yield 'unlock'
  void swept
  return { t: 'keys', keys }
}

function* opDbsize(ctx: OpCtx): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)
  cache.cleanExpired(ctx.clock.t)
  yield 'sweep expired'
  const size = cache.liveSize(ctx.clock.t)
  yield 'count'
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'dbsize', size }
}

function* opTtl(ctx: OpCtx, key: string): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)
  const node = cache.mapGet(key)
  const remaining = node ? (node.expireAtMs === NO_EXPIRY ? null : node.expireAtMs - ctx.clock.t) : null
  ctx.onEvent({
    kind: 'ttl',
    level: remaining === null ? 'dim' : remaining <= 0 ? 'bad' : 'info',
    key,
    text: node
      ? remaining === null
        ? `TTL("${key}") = no expiry`
        : `TTL("${key}") = ${remaining}ms`
      : `TTL("${key}") = key not present`,
  })
  yield 'ttl read'
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'ttl', key, remaining }
}

function* opFlush(ctx: OpCtx): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)
  const count = cache.mapSize()
  cache.clear()
  ctx.onEvent({ kind: 'clear', level: 'warn', text: `FLUSHDB — dropped ${count} entries, order structures reset` })
  yield 'clear structures'
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'flush', count }
}

function* opClean(ctx: OpCtx): OpGenerator {
  const cache = ctx.cache
  yield 'lock'
  cache.acquire(ctx.thread)
  const removed = cache.cleanExpired(ctx.clock.t)
  yield 'sweep expired'
  cache.release(ctx.thread)
  yield 'unlock'
  return { t: 'clean', removed }
}

function* opPattern(ctx: OpCtx, instr: Extract<Instr, { t: 'pattern' }>): OpGenerator {
  const cache = ctx.cache
  const before = cache.stats()
  yield 'lock'
  cache.acquire(ctx.thread)
  const keys = instr.keys
  let i = 0
  while (i < keys.length) {
    const key = keys[i]
    const node = cache.mapGet(key)
    if (!node) {
      cache.recordMiss('key absent', key)
      const value = originRead(ctx, key)
      const res = yield* insertNode(ctx, key, value, null)
      void res
    } else if (cache.isExpired(node, ctx.clock.t)) {
      cache.detachFromPolicy(node)
      cache.mapDelete(key)
      cache.recordMiss('TTL expired', key)
    } else {
      cache.recordHit()
      cache.recordAccess(node)
    }
    i++
    // one yield per access keeps Step Into honest while letting Continue fly
    yield `access ${i}/${keys.length}`
  }
  cache.release(ctx.thread)
  yield 'unlock'
  const after = cache.stats()
  return {
    t: 'pattern',
    kind: instr.kind,
    count: keys.length,
    hits: after.hits - before.hits,
    misses: after.misses - before.misses,
    evictions: after.evictions - before.evictions,
  }
}

export function* runInstr(ctx: OpCtx, instr: Instr): OpGenerator {
  switch (instr.t) {
    case 'nop':
      return { t: 'nop' }
    case 'directive':
      return { t: 'nop' }
    case 'set':
      return yield* opSet(ctx, instr.key, instr.value, instr.ttlMs)
    case 'get':
      return yield* opGet(ctx, instr.key)
    case 'del':
      return yield* opDel(ctx, instr.keys)
    case 'exists':
      return yield* opExists(ctx, instr.key)
    case 'keys':
      return yield* opKeys(ctx, instr.pattern)
    case 'dbsize':
      return yield* opDbsize(ctx)
    case 'ttl':
      return yield* opTtl(ctx, instr.key)
    case 'flush':
      return yield* opFlush(ctx)
    case 'clean':
      return yield* opClean(ctx)
    case 'info':
      return { t: 'info' }
    case 'config':
      return { t: 'config', param: instr.param, value: instr.param.toLowerCase() === 'maxcapacity' ? String(ctx.cache.capacity) : ctx.cache.policy }
    case 'sleep': {
      yield 'advance clock'
      ctx.clock.t += instr.ms
      ctx.onEvent({ kind: 'system', level: 'dim', text: `SLEEP ${instr.ms}ms — simulated clock is now ${ctx.clock.t}ms` })
      return { t: 'sleep', ms: instr.ms }
    }
    case 'spawn': {
      for (let n = 0; n < instr.count; n++) {
        ctx.onEvent({
          kind: 'system',
          level: 'info',
          thread: n + 1,
          text: `Thread.ofVirtual().start() → T${n + 1} launched, queued on the ReentrantLock`,
        })
        yield `launch T${n + 1}`
      }
      return { t: 'spawn', count: instr.count }
    }
    case 'pattern':
      return yield* opPattern(ctx, instr)
  }
}
