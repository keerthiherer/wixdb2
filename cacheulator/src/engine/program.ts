export type Instr =
  | { t: 'nop' }
  | { t: 'directive'; name: 'capacity' | 'policy' | 'tick' | 'autofill'; arg: string; value: number }
  | { t: 'set'; key: string; value: string; ttlMs: number | null }
  | { t: 'get'; key: string }
  | { t: 'del'; keys: string[] }
  | { t: 'exists'; key: string }
  | { t: 'keys'; pattern: string }
  | { t: 'dbsize' }
  | { t: 'ttl'; key: string }
  | { t: 'flush' }
  | { t: 'clean' }
  | { t: 'info' }
  | { t: 'config'; param: string }
  | { t: 'sleep'; ms: number }
  | { t: 'spawn'; count: number; sub: Instr }
  | { t: 'pattern'; kind: PatternKind; count: number; param: number; seed: number; keys: string[] }

export type PatternKind = 'seq' | 'zipf' | 'hot' | 'scan'

export interface ProgramLine {
  line: number
  raw: string
  instr: Instr | null
  error: string | null
}

export interface Program {
  lines: ProgramLine[]
  /** Directives that the machine applies on load, in source order. */
  directives: { name: 'capacity' | 'policy' | 'tick' | 'autofill'; arg: string; value: number; line: number }[]
  source: string
  errors: { line: number; message: string }[]
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const keyName = (i: number, width: number) => `k:${String(i).padStart(width, '0')}`

function zipfTable(n: number, s: number): Float64Array {
  const cdf = new Float64Array(n + 1)
  let sum = 0
  for (let i = 1; i <= n; i++) {
    sum += 1 / Math.pow(i, s)
    cdf[i] = sum
  }
  for (let i = 1; i <= n; i++) cdf[i] /= sum
  return cdf
}

function pick(cdf: Float64Array, r: number): number {
  let lo = 1
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cdf[mid] < r) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/**
 * Sample access patterns are expanded at parse time into a concrete key
 * sequence. Both the interactive core and the LRU/LFU comparison engine replay
 * the very same sequence, so the comparison is apples-to-apples.
 */
export function buildPattern(kind: PatternKind, count: number, param: number, seed: number): string[] {
  const rnd = mulberry32(seed)
  const width = Math.max(4, String(Math.max(1, count)).length)
  const keys: string[] = []
  const universe = Math.max(2, Math.min(count, 64))
  const skew = param || 0.8

  if (kind === 'seq') {
    for (let i = 0; i < count; i++) keys.push(keyName(i % universe, width))
    return keys
  }

  if (kind === 'zipf') {
    const cdf = zipfTable(universe, skew)
    for (let i = 0; i < count; i++) keys.push(keyName(pick(cdf, rnd()), width))
    return keys
  }

  if (kind === 'hot') {
    const cdf = zipfTable(universe, 0.99)
    for (let i = 0; i < count; i++) {
      keys.push(rnd() < 0.8 ? keyName(0, width) : keyName(pick(cdf, rnd()), width))
    }
    return keys
  }

  // scan: hammer a 4-key working set for a few rounds, then punch a burst of
  // one-shot keys. The rounds matter — LFU can only protect keys whose
  // frequency actually climbed, exactly as in cache_demo.py scenario 3.
  const working = [0, 1, 2, 3]
  const rounds = 3
  const scanLen = Math.max(1, Math.round(param || 6))
  let burst = 0
  while (keys.length < count) {
    for (let r = 0; r < rounds; r++) {
      for (const w of working) {
        if (keys.length >= count) break
        keys.push(keyName(w, width))
      }
    }
    for (let i = 0; i < scanLen && keys.length < count; i++) {
      keys.push(keyName(4 + (burst * scanLen + i), width))
    }
    burst++
  }
  return keys
}

function tokenize(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#' || c === ';') break
    if (c === '"' || c === "'") {
      const quote = c
      i++
      let buf = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) i++
        buf += src[i++]
      }
      i++
      out.push(buf)
      continue
    }
    let buf = ''
    while (i < src.length && !' \t\r'.includes(src[i]) && src[i] !== '#' && src[i] !== ';') buf += src[i++]
    out.push(buf)
  }
  return out
}

const MAX_TOKENS = 64

function parseDuration(tok: string, fallbackUnit: 'ms' | 's' = 's'): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(tok)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? fallbackUnit
  if (unit === 'ms') return Math.round(n)
  if (unit === 'm') return Math.round(n * 60_000)
  return Math.round(n * 1000)
}

function parseLine(line: number, raw: string): ProgramLine {
  const tokens = tokenize(raw)
  if (tokens.length === 0) return { line, raw, instr: { t: 'nop' }, error: null }
  const fail = (message: string): ProgramLine => ({ line, raw, instr: null, error: message })

  const verb = tokens[0].toUpperCase()
  const arg = (i: number) => tokens[i]

  switch (verb) {
    case '!CAPACITY':
    case '!POLICY':
    case '!AUTOFILL':
    case '!TICK': {
      const name = verb.slice(1).toLowerCase() as 'capacity' | 'policy' | 'tick' | 'autofill'
      if (tokens.length < 2) return fail(`!${name.toUpperCase()} needs a value`)
      if (name === 'policy') {
        const p = tokens[1].toUpperCase()
        if (p !== 'LRU' && p !== 'LFU') return fail('policy must be LRU or LFU')
        return { line, raw, instr: { t: 'directive', name, arg: p, value: 0 }, error: null }
      }
      if (name === 'autofill') {
        const v = tokens[1].toLowerCase()
        if (v !== 'on' && v !== 'off') return fail('!AUTOFILL must be on or off')
        return { line, raw, instr: { t: 'directive', name, arg: v, value: v === 'on' ? 1 : 0 }, error: null }
      }
      const n = Number(tokens[1])
      if (!Number.isFinite(n) || n <= 0) return fail(`!${name.toUpperCase()} needs a positive number`)
      return { line, raw, instr: { t: 'directive', name, arg: tokens[1], value: n }, error: null }
    }
    case 'SET': {
      if (tokens.length < 3) return fail('SET <key> <value> [EX <sec>|PX <ms>]')
      let ttlMs: number | null = null
      if (tokens.length >= 5) {
        const flag = tokens[3].toUpperCase()
        if (flag === 'EX' || flag === 'PX') {
          ttlMs = parseDuration(tokens[4], 's')
          if (ttlMs === null) return fail(`bad duration "${tokens[4]}"`)
          if (flag === 'PX') ttlMs = Math.round(ttlMs)
        } else {
          return fail('expected EX <sec> or PX <ms>')
        }
      } else if (tokens.length === 4) {
        return fail('expected EX <sec> or PX <ms>')
      }
      return { line, raw, instr: { t: 'set', key: arg(1), value: arg(2), ttlMs }, error: null }
    }
    case 'GET':
      if (tokens.length < 2) return fail('GET <key>')
      return { line, raw, instr: { t: 'get', key: arg(1) }, error: null }
    case 'DEL':
      if (tokens.length < 2) return fail('DEL <key> [key ...]')
      return { line, raw, instr: { t: 'del', keys: tokens.slice(1, MAX_TOKENS) }, error: null }
    case 'EXISTS':
      if (tokens.length < 2) return fail('EXISTS <key>')
      return { line, raw, instr: { t: 'exists', key: arg(1) }, error: null }
    case 'KEYS':
      return { line, raw, instr: { t: 'keys', pattern: arg(1) ?? '*' }, error: null }
    case 'DBSIZE':
      return { line, raw, instr: { t: 'dbsize' }, error: null }
    case 'TTL':
      if (tokens.length < 2) return fail('TTL <key>')
      return { line, raw, instr: { t: 'ttl', key: arg(1) }, error: null }
    case 'FLUSHDB':
      return { line, raw, instr: { t: 'flush' }, error: null }
    case 'CLEAN':
    case 'CLEANEXPIRED':
      return { line, raw, instr: { t: 'clean' }, error: null }
    case 'INFO':
      return { line, raw, instr: { t: 'info' }, error: null }
    case 'CONFIG': {
      if (tokens.length < 3 || tokens[1].toUpperCase() !== 'GET') return fail('CONFIG GET <param>')
      return { line, raw, instr: { t: 'config', param: arg(2) }, error: null }
    }
    case 'SLEEP': {
      if (tokens.length < 2) return fail('SLEEP <ms|s>')
      const ms = parseDuration(tokens[1], 's')
      if (ms === null || ms < 0) return fail(`bad duration "${tokens[1]}"`)
      return { line, raw, instr: { t: 'sleep', ms }, error: null }
    }
    case 'SPAWN': {
      if (tokens.length < 3) return fail('SPAWN <n> <command ...>')
      const n = Number(tokens[1])
      if (!Number.isInteger(n) || n < 1) return fail('SPAWN needs a thread count >= 1')
      const sub = parseLine(line, tokens.slice(2).join(' '))
      if (sub.error) return fail(sub.error)
      return { line, raw, instr: { t: 'spawn', count: n, sub: sub.instr! }, error: null }
    }
    case 'PATTERN': {
      const kind = (arg(1) ?? 'zipf').toLowerCase()
      if (!['seq', 'zipf', 'hot', 'scan'].includes(kind)) return fail('pattern must be seq | zipf | hot | scan')
      const count = Number(arg(2))
      if (!Number.isInteger(count) || count < 1) return fail('PATTERN needs an access count')
      let param = kind === 'zipf' ? 0.8 : 6
      let seed = 1337
      const flag = (i: number, name: string) => tokens[i]?.toUpperCase() === name
      for (let i = 3; i < tokens.length; i++) {
        if (flag(i, 'SEED') && tokens[i + 1]) {
          seed = Number(tokens[i + 1])
          i++
        } else if (flag(i, 'SKEW') && tokens[i + 1]) {
          param = Number(tokens[i + 1])
          i++
        } else if (tokens[i] && Number.isFinite(Number(tokens[i]))) {
          param = Number(tokens[i])
        }
      }
      if (kind === 'zipf' && (param < 0 || param > 3)) return fail('SKEW must be between 0 and 3')
      return {
        line,
        raw,
        instr: {
          t: 'pattern',
          kind: kind as PatternKind,
          count,
          param,
          seed,
          keys: buildPattern(kind as PatternKind, count, param, seed),
        },
        error: null,
      }
    }
    default:
      return fail(`unknown instruction "${tokens[0]}"`)
  }
}

export function assemble(source: string): Program {
  const lines = source.split('\n').map((raw, i) => parseLine(i + 1, raw))
  const directives = lines
    .filter(
      (
        l,
      ): l is ProgramLine & {
        instr: { t: 'directive'; name: 'capacity' | 'policy' | 'tick' | 'autofill'; arg: string; value: number }
      } => l.instr?.t === 'directive',
    )
    .map((l) => ({ name: l.instr.name, arg: l.instr.arg, value: l.instr.value, line: l.line }))
  const errors = lines.filter((l) => l.error).map((l) => ({ line: l.line, message: l.error! }))
  return { lines, directives, source, errors }
}

export const INSTRUCTION_HELP: { syntax: string; desc: string }[] = [
  { syntax: '!CAPACITY <n>', desc: 'resize the on-die cache (default 16 slots)' },
  { syntax: '!POLICY LRU|LFU', desc: 'select the eviction policy' },
  { syntax: '!TICK <ms>', desc: 'simulated clock advance per command' },
  { syntax: '!AUTOFILL on|off', desc: 'cache-aside: on a miss, read the backing store and insert (default on)' },
  { syntax: 'SET <key> <value> [EX <sec>|PX <ms>]', desc: 'write with an optional per-entry TTL' },
  { syntax: 'GET <key>', desc: 'read — hit / miss / TTL-expired' },
  { syntax: 'DEL <key>...', desc: 'remove mappings' },
  { syntax: 'EXISTS <key>', desc: 'presence test without touching policy order' },
  { syntax: 'KEYS [glob]', desc: 'list live keys' },
  { syntax: 'DBSIZE', desc: 'count of live entries' },
  { syntax: 'TTL <key>', desc: 'read remaining time-to-live (simulator introspection, not counted as a lookup)' },
  { syntax: 'FLUSHDB', desc: 'drop every entry' },
  { syntax: 'CLEAN', desc: 'sweep TTL-expired entries now' },
  { syntax: 'INFO', desc: 'dump cache config + stats to the terminal' },
  { syntax: 'CONFIG GET <param>', desc: 'read eviction_policy or maxcapacity' },
  { syntax: 'SLEEP <n>[ms|s]', desc: 'advance the simulated clock' },
  { syntax: 'SPAWN <n> <cmd>', desc: 'launch n virtual threads that contend for the ReentrantLock' },
  { syntax: 'PATTERN <kind> <count> [param] [SEED n]', desc: 'replay a sample access pattern: seq | zipf | hot | scan' },
]
