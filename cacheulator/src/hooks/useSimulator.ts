import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Machine, runHeadless, type CompareResult, type WatchKind } from '../engine/machine'
import { DEFAULT_SAMPLE, SAMPLES, type Sample } from '../engine/samples'
import type { DisplayFormat, WordSize } from '../lib/format'

export interface Comparison {
  lru: CompareResult
  lfu: CompareResult
  lookups: number
}

const COMPARE_BUDGET = 8000

export function useSimulator() {
  const machineRef = useRef<Machine>(new Machine(DEFAULT_SAMPLE.source))
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const tick = useCallback(() => rerender(), [])

  const [draft, setDraft] = useState(DEFAULT_SAMPLE.source)
  const [sampleId, setSampleId] = useState(DEFAULT_SAMPLE.id)
  const [running, setRunning] = useState(false)
  const [speed, setSpeed] = useState(2)
  const [displayFormat, setDisplayFormat] = useState<DisplayFormat>('hex')
  const [wordSize, setWordSize] = useState<WordSize>(32)
  const [showLines, setShowLines] = useState(true)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [follow, setFollow] = useState(true)

  const speedRef = useRef(speed)
  speedRef.current = speed

  const machine = machineRef.current

  const estimate = useCallback((source: string) => {
    const ops = source.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith(';'))
    let weight = 0
    for (const line of ops) {
      const m = /^\s*pattern\s+\w+\s+(\d+)/i.exec(line)
      if (m) weight += Number(m[1])
      else if (/spawn\s+(\d+)/i.test(line)) weight += Number(/spawn\s+(\d+)/i.exec(line)![1])
      else weight += 1
    }
    return weight
  }, [])

  const compare = useCallback(
    (source: string) => {
      if (estimate(source) > COMPARE_BUDGET) {
        setComparison(null)
        return
      }
      const lru = runHeadless(source, 'LRU', 16)
      const lfu = runHeadless(source, 'LFU', 16)
      setComparison({ lru, lfu, lookups: Math.max(lru.ribbon.length, lfu.ribbon.length) })
    },
    [estimate],
  )

  const load = useCallback(
    (source: string, id?: string) => {
      const previous = machineRef.current
      const next = new Machine(source)
      next.breakpoints = previous.breakpoints
      next.watchpoints = previous.watchpoints
      machineRef.current = next
      if (id) setSampleId(id)
      setRunning(false)
      compare(source)
      tick()
    },
    [compare, tick],
  )

  const loadSample = useCallback(
    (sample: Sample) => {
      setDraft(sample.source)
      load(sample.source, sample.id)
    },
    [load],
  )

  const reload = useCallback(() => load(draft), [draft, load])

  const restart = useCallback(() => {
    machineRef.current.clear()
    setRunning(false)
    tick()
  }, [tick])

  const stepOnce = useCallback(() => {
    const m = machineRef.current
    if (m.finished) m.clear()
    m.step()
    tick()
  }, [tick])

  const stepOver = useCallback(() => {
    const m = machineRef.current
    if (m.finished) m.clear()
    m.stepOver()
    tick()
  }, [tick])

  const stepOut = useCallback(() => {
    const m = machineRef.current
    if (m.finished) m.clear()
    m.stepOut()
    tick()
  }, [tick])

  const continueRun = useCallback(() => {
    const m = machineRef.current
    if (m.finished) m.clear()
    if (m.current && m.breakpoints.has(m.current.line) && m.queue.length === 0) {
      m.log(`breakpoint on line ${m.current.line} — press Continue again to run past it`, 'warn')
      tick()
      return
    }
    setRunning(true)
  }, [tick])

  const stop = useCallback(() => {
    setRunning(false)
    machineRef.current.log('execution stopped by user', 'dim')
    tick()
  }, [tick])

  const addWatch = useCallback((kind: WatchKind, value: string) => {
    machineRef.current.addWatchpoint(kind, value)
    tick()
  }, [tick])

  useEffect(() => {
    if (!running) return
    let frame = 0
    let idle = 0
    const loop = () => {
      const m = machineRef.current
      const outcome = m.advance(Math.max(1, speedRef.current * 8))
      if (outcome === 'halted') {
        setRunning(false)
        tick()
        return
      }
      if (outcome === 'breakpoint') {
        m.log(`breakpoint on line ${m.currentLine} — execution paused`, 'warn')
        setRunning(false)
        tick()
        return
      }
      if (outcome === 'watchpoint') {
        setRunning(false)
        tick()
        return
      }
      tick()
      if (outcome === 'budget') {
        idle = 0
      } else {
        idle++
      }
      if (idle > 2) {
        setRunning(false)
        tick()
        return
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [running, speed, tick])

  useEffect(() => {
    if (sampleId && draft === machineRef.current.program.source) return
    compare(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const grouped = useMemo(() => {
    const map = new Map<string, Sample[]>()
    for (const s of SAMPLES) {
      const list = map.get(s.group) ?? []
      list.push(s)
      map.set(s.group, list)
    }
    return [...map.entries()]
  }, [])

  return {
    machine,
    draft,
    setDraft,
    sampleId,
    grouped,
    loadSample,
    reload,
    restart,
    stepOnce,
    stepOver,
    stepOut,
    continueRun,
    stop,
    running,
    speed,
    setSpeed,
    displayFormat,
    setDisplayFormat,
    wordSize,
    setWordSize,
    showLines,
    setShowLines,
    comparison,
    runComparison: () => compare(draft),
    addWatch,
    follow,
    setFollow,
    tick,
  }
}
