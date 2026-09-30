import { WixCache } from './cache'
import { runInstr, type OpCtx, type OpGenerator, type OpResult } from './ops'
import { assemble, type Instr, type Program, type ProgramLine } from './program'
import type { EvictionPolicy, NewEvent, SimEvent, Stats } from './types'

export type WatchKind = 'key' | 'eviction' | 'hitrate'

export interface Watchpoint {
  id: number
  kind: WatchKind
  value: string
  enabled: boolean
  trips: number
}

export type ThreadState = 'new' | 'queued' | 'running' | 'done'

export interface VirtualThread {
  id: number
  state: ThreadState
  command: string
}

export interface StepRecord {
  index: number
  line: number
  raw: string
  label: string
  thread: number
  clock: number
  events: SimEvent[]
  lookup?: 'hit' | 'miss'
  evicted?: string[]
  expired?: string[]
}

export interface RibbonEntry {
  i: number
  key: string
  outcome: 'hit' | 'miss'
  evicted: string[]
  expired: boolean
}

export interface HistorySample {
  i: number
  hits: number
  misses: number
  evictions: number
  hitRate: number
  missRate: number
  size: number
  clock: number
}

export interface TerminalLine {
  id: number
  text: string
  tone: 'out' | 'ok' | 'hit' | 'miss' | 'err' | 'dim'
}

export interface StatusLine {
  id: number
  text: string
  tone: 'sys' | 'ok' | 'warn' | 'err' | 'dim'
}

export interface MachineConfig {
  capacity: number
  policy: EvictionPolicy
  tickMs: number
  autofill: boolean
}

const TRACE_CAP = 6000
const STEP_CAP = 3000
const TERMINAL_CAP = 2000

interface QueueItem {
  thread: number
  instr: Instr
  line: number
  command: string
  /** true for work a SPAWN handed to a virtual thread — those must not move the pc */
  queued: boolean
}

export class Machine {
  config: MachineConfig
  program: Program
  cache: WixCache
  /**
   * Set by runHeadless so the A/B comparison can pin the policy it is testing.
   * The Java core fixes the policy at construction, so a directive still wins
   * for interactive runs — the comparison is the one place that must differ.
   */
  private forcedPolicy: EvictionPolicy | null = null

  clock = { t: 0 }
  store = new Map<string, string>()

  pc = 0
  private gen: OpGenerator | null = null
  current: QueueItem | null = null
  private thread: number = 0

  queue: QueueItem[] = []
  threads: VirtualThread[] = []
  private nextThreadId = 1

  trace: SimEvent[] = []
  steps: StepRecord[] = []
  history: HistorySample[] = []
  ribbon: RibbonEntry[] = []
  terminal: TerminalLine[] = []
  status: StatusLine[] = []

  breakpoints = new Set<number>()
  watchpoints: Watchpoint[] = []
  private watchSeq = 1

  running = false
  finished = false
  private lastEventId = 0
  private termSeq = 0
  private statusSeq = 0
  private stepSeq = 0
  private lookupSeq = 0
  private instructionCount = 0

  /** Headless runs keep no history — used by the LRU/LFU comparison. */
  readonly headless: boolean

  constructor(source: string, config: Partial<MachineConfig> = {}, headless = false) {
    this.headless = headless
    this.config = { capacity: 16, policy: 'LRU', tickMs: 100, autofill: true, ...config }
    if (config.policy === undefined) this.config.policy = undefined as unknown as EvictionPolicy
    this.program = assemble(source)
    if (config.policy && headless) this.forcedPolicy = config.policy
    this.cache = this.buildCache()
    if (this.cache) this.cache.onEvent = (e) => this.emit(e)
    this.boot()
  }

  private buildCache(): WixCache {
    const dirPolicy = this.program.directives.find((d) => d.name === 'policy')
    const dirCapacity = this.program.directives.find((d) => d.name === 'capacity')
    const dirTick = this.program.directives.find((d) => d.name === 'tick')
    const dirFill = this.program.directives.find((d) => d.name === 'autofill')
    const policy: EvictionPolicy =
      this.forcedPolicy ?? (dirPolicy ? (dirPolicy.arg as EvictionPolicy) : (this.config.policy ?? 'LRU'))
    this.config = {
      capacity: dirCapacity ? dirCapacity.value : this.config.capacity,
      policy,
      tickMs: dirTick ? dirTick.value : this.config.tickMs,
      autofill: dirFill ? dirFill.value === 1 : this.config.autofill,
    }
    return new WixCache(this.config.capacity, policy)
  }

  private emit(e: NewEvent) {
    if (this.headless) return
    this.lastEventId++
    this.trace.push({ ...e, id: this.lastEventId })
    if (this.trace.length > TRACE_CAP) this.trace.splice(0, this.trace.length - TRACE_CAP)
  }

  private say(text: string, tone: TerminalLine['tone'] = 'out') {
    if (this.headless) return
    this.terminal.push({ id: ++this.termSeq, text, tone })
    if (this.terminal.length > TERMINAL_CAP) this.terminal.splice(0, this.terminal.length - TERMINAL_CAP)
  }

  log(text: string, tone: StatusLine['tone'] = 'sys') {
    if (this.headless) return
    this.status.push({ id: ++this.statusSeq, text, tone })
    if (this.status.length > 400) this.status.splice(0, this.status.length - 400)
  }

  private boot() {
    if (this.headless) return
    const cap = this.config.capacity
    this.log(
      `cacheulator has started with system WIX-${this.config.policy} capacity ${cap} containing a Java-simulated InMemoryCache core.`,
      'ok',
    )
    this.log(
      `core config: eviction_policy=${this.config.policy}, max_capacity=${cap}, autofill=${this.config.autofill ? 'on' : 'off'}, tick=${this.config.tickMs}ms`,
      'dim',
    )
    if (this.program.errors.length === 0) {
      this.log(`loaded ${this.program.source.split('\n').length} source lines, ${this.executableLines().length} instructions`, 'dim')
      this.fetch()
    } else {
      for (const err of this.program.errors) this.log(`line ${err.line}: ${err.message}`, 'err')
      this.log('compilation failed — fix the marked lines and press Reload', 'err')
    }
  }

  // ── program helpers ────────────────────────────────────────────────────────

  private executableLines(): ProgramLine[] {
    return this.program.lines.filter((l) => l.instr && l.instr.t !== 'nop')
  }

  get currentLine(): number | null {
    if (this.current) return this.current.line
    const line = this.program.lines[this.pc]
    return line ? line.line : null
  }

  private fetch(): void {
    this.current = null
    this.gen = null
    this.thread = 0
    if (this.queue.length > 0) {
      const item = this.queue.shift()!
      this.current = item
      this.thread = item.thread
      const t = this.threads.find((x) => x.id === item.thread)
      if (t) t.state = 'running'
    } else {
      while (this.pc < this.program.lines.length) {
        const line = this.program.lines[this.pc]
        if (line.instr && line.instr.t !== 'nop') break
        this.pc++
      }
      if (this.pc >= this.program.lines.length) {
        this.halt()
        return
      }
      const line = this.program.lines[this.pc]
      this.current = { thread: 0, instr: line.instr!, line: line.line, command: line.raw.trim(), queued: false }
      this.thread = 0
    }
    this.startGenerator()
  }

  private startGenerator() {
    if (!this.current) return
    const ctx: OpCtx = {
      cache: this.cache,
      clock: this.clock,
      thread: this.thread,
      autofill: this.config.autofill,
      store: this.store,
      onEvent: (e) => this.emit(e),
    }
    this.gen = runInstr(ctx, this.current.instr)
  }

  private halt() {
    this.finished = true
    this.running = false
    this.gen = null
    this.current = null
    const s = this.cache.stats()
    this.log(
      `program halted — ${this.instructionCount} instructions, ${s.totalRequests} lookups, hit rate ${(s.hitRate * 100).toFixed(2)}%, ${s.evictions} evictions`,
      'ok',
    )
  }

  // ── the step engine ────────────────────────────────────────────────────────

  /** One micro-step: the smallest unit of Java the debugger can stop on. */
  step(): boolean {
    if (this.finished) return false
    if (!this.gen) this.fetch()
    if (this.finished || !this.gen || !this.current) return false

    const before = this.trace.length
    const res = this.gen.next()
    const events = this.headless ? [] : this.trace.slice(before > TRACE_CAP ? 0 : before)

    if (!res.done) {
      this.recordStep(this.current, res.value, events)
      return true
    }

    this.completeInstruction(res.value, events)
    return true
  }

  /** Runs the current instruction to its last statement, then stops. */
  stepOver(): boolean {
    if (this.finished) return false
    let guard = 0
    while (!this.finished && guard++ < 20000) {
      const at = this.current?.line
      const n = this.steps.length
      this.step()
      if (this.finished) return false
      if (this.current?.line !== at || this.steps.length === n) return true
    }
    return true
  }

  /**
   * Leaves the current "call frame": drains the virtual threads spawned by the
   * current instruction, otherwise behaves like Continue.
   */
  stepOut(): boolean {
    if (this.finished) return false
    const batch = this.queue.length
    const startLine = this.current?.line ?? null
    let guard = 0
    while (!this.finished && guard++ < 200000) {
      const n = this.steps.length
      this.step()
      if (this.finished) return false
      if (this.steps.length === n) continue
      if (startLine !== null && this.current?.line !== startLine) return true
      if (batch > 0 && this.queue.length < batch) return true
      if (this.queue.length === 0 && this.current?.line !== startLine) return true
    }
    return true
  }

  /**
   * Pumps micro-steps until the program ends or a breakpoint/watchpoint trips.
   * `budget` bounds the work per call so a huge PATTERN cannot freeze the tab.
   */
  advance(budget = 20000): 'halted' | 'breakpoint' | 'watchpoint' | 'budget' {
    let worked = 0
    while (!this.finished && worked < budget) {
      if (this.current && this.breakpoints.has(this.current.line) && this.queue.length === 0) {
        return 'breakpoint'
      }
      const before = this.steps.length
      this.step()
      worked++
      if (this.steps.length > before) {
        const w = this.checkWatchpoints()
        if (w) return 'watchpoint'
      }
    }
    return this.finished ? 'halted' : 'budget'
  }

  runToEnd(maxSteps = 400_000): Stats {
    let n = 0
    while (!this.finished && n < maxSteps) {
      this.step()
      n++
    }
    return this.cache.stats()
  }

  private recordStep(current: QueueItem, label: string, events: SimEvent[]) {
    if (this.headless) return
    this.instructionCount++
    this.clock.t += this.config.tickMs
    this.steps.push({
      index: ++this.stepSeq,
      line: current.line,
      raw: current.command,
      label,
      thread: current.thread,
      clock: this.clock.t,
      events,
    })
    if (this.steps.length > STEP_CAP) this.steps.splice(0, this.steps.length - STEP_CAP)
    this.sampleFromEvents(events)
  }

  private sampleFromEvents(events: SimEvent[]) {
    if (this.headless) return
    const stat = events.find((e) => e.kind === 'stats')
    if (!stat) return
    const outcome = stat.level === 'good' ? 'hit' : 'miss'
    const s = this.cache.stats()
    this.history.push({
      i: ++this.lookupSeq,
      hits: s.hits,
      misses: s.misses,
      evictions: s.evictions,
      hitRate: s.hitRate,
      missRate: s.missRate,
      size: this.cache.liveSize(this.clock.t),
      clock: this.clock.t,
    })
    this.ribbon.push({
      i: this.lookupSeq,
      key: stat.key ?? '',
      outcome,
      evicted: events.filter((e) => e.kind === 'evict').map((e) => e.key!),
      expired: events.some((e) => e.kind === 'delete' && e.level === 'warn'),
    })
    if (this.history.length > TRACE_CAP) this.history.splice(0, this.history.length - TRACE_CAP)
    if (this.ribbon.length > TRACE_CAP) this.ribbon.splice(0, this.ribbon.length - TRACE_CAP)
  }

  private completeInstruction(result: OpResult, events: SimEvent[]) {
    const finishedThread = this.thread
    const item = this.current
    this.renderResult(result, events)

    if (result.t === 'spawn' && item && item.instr.t === 'spawn') {
      for (let i = 0; i < item.instr.count; i++) {
        const id = this.nextThreadId++
        this.threads.push({ id, state: 'queued', command: `T${id} → ${describeInstr(item.instr.sub)}` })
        this.queue.push({ thread: id, instr: item.instr.sub, line: item.line, command: item.command, queued: true })
        this.emit({
          kind: 'system',
          level: 'dim',
          thread: id,
          text: `T${id} blocked on ReentrantLock — waiting for the current holder to unlock`,
        })
      }
    }

    const t = this.threads.find((x) => x.id === finishedThread)
    if (t) t.state = 'done'
    // A virtual thread finishes its own command; only the main program advances.
    if (item && !item.queued) this.pc++
    this.fetch()
  }

  private renderResult(result: OpResult, events: SimEvent[]) {
    if (this.headless) return
    const ev = (k: SimEvent['kind']) => events.filter((e) => e.kind === k)
    switch (result.t) {
      case 'get': {
        if (result.outcome === 'hit') {
          this.say(`(bulk) "${result.value}"`, 'hit')
        } else if (result.filled) {
          this.say(`(nil) → cache-aside: loaded "${result.value}" from the backing store and inserted it`, 'out')
        } else {
          this.say('(nil)', 'miss')
        }
        break
      }
      case 'set': {
        const ttl = result.ttlMs === null ? '' : ` EX ${result.ttlMs}ms`
        this.say(`+OK ${result.replaced ? '(updated in place)' : ''}${ttl}`, 'ok')
        if (result.swept.length) this.say(`  swept TTL-expired: ${result.swept.join(', ')}`, 'dim')
        if (result.evicted) this.say(`  evicted "${result.evicted}" to make room (${this.config.policy})`, 'miss')
        break
      }
      case 'del':
        this.say(`:${result.removed.length}`, result.removed.length ? 'ok' : 'miss')
        break
      case 'exists':
        this.say(`:${result.exists ? 1 : 0}`, result.exists ? 'hit' : 'miss')
        break
      case 'keys':
        this.say(`*${result.keys.length} ${JSON.stringify(result.keys)}`, 'out')
        break
      case 'dbsize':
        this.say(`:${result.size}`, 'out')
        break
      case 'ttl':
        this.say(result.remaining === null ? 'TTL: no expiry' : `TTL: ${result.remaining}ms`, result.remaining && result.remaining <= 0 ? 'miss' : 'out')
        break
      case 'flush':
        this.say(`+OK (flushed ${result.count})`, 'ok')
        break
      case 'clean':
        this.say(`swept ${result.removed.length} expired: ${result.removed.join(', ') || '—'}`, result.removed.length ? 'ok' : 'dim')
        break
      case 'info': {
        const s = this.cache.stats()
        const size = this.cache.liveSize(this.clock.t)
        const lines = [
          '# Cache',
          `eviction_policy:${this.config.policy}`,
          `max_capacity:${this.config.capacity}`,
          `current_size:${size}`,
          '',
          '# Stats',
          `cache_hits:${s.hits}`,
          `cache_misses:${s.misses}`,
          `cache_evictions:${s.evictions}`,
          `total_requests:${s.totalRequests}`,
          `cache_hit_rate:${s.hitRate.toFixed(4)}`,
          `cache_miss_rate:${s.missRate.toFixed(4)}`,
          `cache_hit_rate_pct:${(s.hitRate * 100).toFixed(2)}%`,
          `cache_miss_rate_pct:${(s.missRate * 100).toFixed(2)}%`,
        ]
        lines.forEach((l) => this.say(l, l.startsWith('#') ? 'dim' : 'out'))
        break
      }
      case 'config':
        this.say(`*2\r\n${result.param}\r\n${result.value}`, 'out')
        break
      case 'sleep':
        this.say(`(clock +${result.ms}ms)`, 'dim')
        break
      case 'spawn':
        this.say(`> spawned ${result.count} virtual thread(s) — all queued on the ReentrantLock`, 'out')
        break
      case 'pattern': {
        const total = result.hits + result.misses
        const rate = total === 0 ? 0 : (result.hits / total) * 100
        this.say(
          `pattern ${result.kind}: ${result.count} accesses → ${result.hits} hits / ${result.misses} misses (${rate.toFixed(1)}% hit rate), ${result.evictions} evictions`,
          rate >= 60 ? 'hit' : 'miss',
        )
        break
      }
      case 'error':
        this.say(`ERR ${result.message}`, 'err')
        break
      case 'nop':
        break
    }
    if (ev('evict').length > 0) this.log(`eviction: ${ev('evict').map((e) => e.key).join(', ')} dropped by ${this.config.policy}`, 'warn')
  }

  // ── watchpoints ────────────────────────────────────────────────────────────

  addWatchpoint(kind: WatchKind, value: string): Watchpoint {
    const wp: Watchpoint = { id: this.watchSeq++, kind, value, enabled: true, trips: 0 }
    this.watchpoints.push(wp)
    return wp
  }

  removeWatchpoint(id: number) {
    this.watchpoints = this.watchpoints.filter((w) => w.id !== id)
  }

  toggleWatchpoint(id: number) {
    const w = this.watchpoints.find((x) => x.id === id)
    if (w) w.enabled = !w.enabled
  }

  private checkWatchpoints(): Watchpoint | null {
    const last = this.steps[this.steps.length - 1]
    if (!last) return null
    for (const wp of this.watchpoints) {
      if (!wp.enabled) continue
      let hit = false
      if (wp.kind === 'key') hit = last.events.some((e) => e.key === wp.value && e.kind !== 'stats')
      else if (wp.kind === 'eviction') hit = last.events.some((e) => e.kind === 'evict')
      else if (wp.kind === 'hitrate') {
        const threshold = Number(wp.value)
        if (Number.isFinite(threshold) && this.cache.stats().hitRate * 100 < threshold) hit = true
      }
      if (hit) {
        wp.trips++
        this.log(`watchpoint #${wp.id} tripped — ${describeWatch(wp)}`, 'warn')
        return wp
      }
    }
    return null
  }

  // ── control ────────────────────────────────────────────────────────────────

  toggleBreakpoint(line: number) {
    if (this.breakpoints.has(line)) this.breakpoints.delete(line)
    else this.breakpoints.add(line)
  }

  clear() {
    this.pc = 0
    this.clock.t = 0
    this.store.clear()
    this.cache.clear()
    this.gen = null
    this.current = null
    this.queue = []
    this.threads = []
    this.trace = []
    this.steps = []
    this.history = []
    this.ribbon = []
    this.terminal = []
    this.status = []
    this.finished = false
    this.running = false
    this.lastEventId = 0
    this.stepSeq = 0
    this.lookupSeq = 0
    this.instructionCount = 0
    this.boot()
  }

  // ── views ──────────────────────────────────────────────────────────────────

  stats(): Stats {
    return this.cache.stats()
  }

  info() {
    const s = this.cache.stats()
    return {
      eviction_policy: this.config.policy,
      max_capacity: this.config.capacity,
      current_size: this.cache.liveSize(this.clock.t),
      cache_hits: s.hits,
      cache_misses: s.misses,
      cache_evictions: s.evictions,
      total_requests: s.totalRequests,
      cache_hit_rate_pct: `${(s.hitRate * 100).toFixed(2)}%`,
      cache_miss_rate_pct: `${(s.missRate * 100).toFixed(2)}%`,
    }
  }
}

export function describeInstr(instr: Instr): string {
  switch (instr.t) {
    case 'set':
      return `SET ${instr.key} ${instr.value}${instr.ttlMs === null ? '' : ` EX ${instr.ttlMs}ms`}`
    case 'get':
      return `GET ${instr.key}`
    case 'del':
      return `DEL ${instr.keys.join(' ')}`
    case 'exists':
      return `EXISTS ${instr.key}`
    case 'keys':
      return `KEYS ${instr.pattern}`
    case 'dbsize':
      return 'DBSIZE'
    case 'ttl':
      return `TTL ${instr.key}`
    case 'flush':
      return 'FLUSHDB'
    case 'clean':
      return 'CLEAN'
    case 'info':
      return 'INFO'
    case 'config':
      return `CONFIG GET ${instr.param}`
    case 'sleep':
      return `SLEEP ${instr.ms}ms`
    case 'spawn':
      return `SPAWN ${instr.count} ${describeInstr(instr.sub)}`
    case 'pattern':
      return `PATTERN ${instr.kind} ${instr.count}`
    default:
      return 'NOP'
  }
}

function describeWatch(wp: Watchpoint): string {
  if (wp.kind === 'key') return `key "${wp.value}" touched`
  if (wp.kind === 'eviction') return 'an eviction happened'
  return `hit rate fell below ${wp.value}%`
}

export interface CompareResult {
  policy: EvictionPolicy
  stats: Stats
  keys: string[]
  size: number
  evictions: number
  ribbon: RibbonEntry[]
  history: HistorySample[]
}

/**
 * Runs a program to completion on a throwaway core and reports the outcome.
 * Omit `policy` to let the programme's own `!POLICY` directive decide — that is
 * how the interactive core behaves. Pass it to pin the policy for the A/B run.
 */
export function runHeadless(
  source: string,
  policy?: EvictionPolicy,
  capacity = 16,
  tickMs = 100,
  autofill = true,
): CompareResult {
  const m = new Machine(source, { policy, capacity, tickMs, autofill }, true)
  m.runToEnd()
  return {
    policy: m.config.policy,
    stats: m.cache.stats(),
    keys: m.cache.snapshotKeys(),
    size: m.cache.liveSize(m.clock.t),
    evictions: m.cache.stats().evictions,
    ribbon: m.ribbon,
    history: m.history,
  }
}
