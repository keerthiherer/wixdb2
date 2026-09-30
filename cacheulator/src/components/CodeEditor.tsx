import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { Program } from '../engine/program'
import { cx } from '../lib/format'

interface Props {
  source: string
  program: Program
  currentLine: number | null
  breakpoints: Set<number>
  showLines: boolean
  finished: boolean
  onChange: (next: string) => void
  onToggleBreakpoint: (line: number) => void
}

type Token = { text: string; cls: string }

const VERBS = /^(SET|GET|DEL|EXISTS|KEYS|DBSIZE|TTL|FLUSHDB|CLEAN|CLEANEXPIRED|INFO|CONFIG|SLEEP|SPAWN|PATTERN|PING|ECHO|QUIT)$/i
const DIRECTIVES = /^![A-Z]+/i

function highlight(raw: string): Token[] {
  if (raw.trim() === '') return [{ text: raw, cls: '' }]
  if (raw.trimStart().startsWith('#') || raw.trimStart().startsWith(';'))
    return [{ text: raw, cls: 'tk-comment' }]
  if (DIRECTIVES.test(raw.trim())) return [{ text: raw, cls: 'tk-directive' }]

  const match = /^(\s*)(\S+)(\s+)(.*)$/.exec(raw)
  if (!match) return [{ text: raw, cls: '' }]
  const [, lead, verb, gap, rest] = match
  const tokens: Token[] = [{ text: lead, cls: '' }]
  tokens.push({ text: verb, cls: VERBS.test(verb) ? 'tk-verb' : 'tk-bad' })
  if (rest === '') return tokens
  tokens.push({ text: gap, cls: '' })
  const parts = /("[^"]*"|'[^']*'|\s+|[^\s]+)/g
  let m: RegExpExecArray | null
  let isFirst = true
  while ((m = parts.exec(rest))) {
    const piece = m[0]
    let cls = 'tk-text'
    if (/^\s+$/.test(piece)) cls = ''
    else if (/^["']/.test(piece)) cls = 'tk-string'
    else if (/^(EX|PX|GET|SEED|SKEW)$/i.test(piece)) cls = 'tk-flag'
    else if (/^-?\d+(\.\d+)?(ms|s)?$/i.test(piece)) cls = 'tk-number'
    else if (/^(LRU|LFU|on|off|zipf|seq|hot|scan)$/i.test(piece)) cls = 'tk-keyword'
    else if (isFirst) cls = 'tk-key'
    tokens.push({ text: piece, cls })
    isFirst = false
  }
  return tokens
}

export function CodeEditor(p: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => p.source.split('\n'), [p.source])
  const pcLine = p.finished ? null : p.currentLine

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop
      preRef.current.scrollLeft = ta.scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop
  })

  useEffect(() => {
    if (pcLine === null) return
    const ta = taRef.current
    if (!ta) return
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight || '20')
    const target = (pcLine - 3) * lineHeight
    if (target < ta.scrollTop || target > ta.scrollTop + ta.clientHeight - lineHeight * 4) {
      ta.scrollTop = Math.max(0, target)
    }
  }, [pcLine])

  const syncScroll = () => {
    const ta = taRef.current
    if (!ta) return
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop
      preRef.current.scrollLeft = ta.scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop
  }

  return (
    <div className="editor">
      <div className="editor-head">
        <span className="file-tab">
          <i /> untitled.wix
          {p.source !== p.program.source && <em>modified</em>}
        </span>
        <div className="editor-head-right">
          <span className="chip">language: WIX</span>
          <span className="chip">target: WIX-CORE</span>
          <span className="chip">
            pc: {pcLine === null ? 'halt' : `${pcLine}:${lines[pcLine - 1]?.trim().split(/\s+/)[0] ?? ''}`}
          </span>
        </div>
      </div>

      <div className="editor-body">
        <div className="gutter" ref={gutterRef}>
          {lines.map((_, i) => {
            const line = i + 1
            const err = p.program.errors.find((e) => e.line === line)
            return (
              <button
                key={line}
                className={cx('gutter-line', pcLine === line && 'pc', p.breakpoints.has(line) && 'bp', err && 'err')}
                onClick={() => p.onToggleBreakpoint(line)}
                title={p.breakpoints.has(line) ? 'remove breakpoint' : 'set breakpoint'}
              >
                {p.showLines ? line : ''}
              </button>
            )
          })}
        </div>

        <div className="code-area">
          <pre className="code-hl" ref={preRef} aria-hidden>
            {lines.map((raw, i) => (
              <div key={i} className={cx('code-line', pcLine === i + 1 && 'pc', p.program.errors.some((e) => e.line === i + 1) && 'err')}>
                {highlight(raw).map((t, j) => (
                  <span key={j} className={t.cls}>
                    {t.text}
                  </span>
                ))}
              </div>
            ))}
          </pre>
          <textarea
            ref={taRef}
            className="code-input"
            spellCheck={false}
            value={p.source}
            wrap="off"
            onChange={(e) => p.onChange(e.target.value)}
            onScroll={syncScroll}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault()
                const ta = e.currentTarget
                const start = ta.selectionStart
                const next = `${ta.value.slice(0, start)}  ${ta.value.slice(ta.selectionEnd)}`
                p.onChange(next)
                requestAnimationFrame(() => ta.setSelectionRange(start + 2, start + 2))
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}
