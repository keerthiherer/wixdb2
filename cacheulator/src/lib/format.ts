export type DisplayFormat = 'hex' | 'dec' | 'text'
export type WordSize = 8 | 16 | 32 | 64

export const HEX_DIGITS: Record<WordSize, number> = { 8: 2, 16: 4, 32: 8, 64: 16 }

export function formatWord(n: number, format: DisplayFormat, wordSize: WordSize): string {
  if (format === 'dec') return String(n)
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(HEX_DIGITS[wordSize], '0')}`
}

export function formatValue(value: string, format: DisplayFormat, wordSize: WordSize): string {
  if (format === 'text') return value
  const asNumber = /^-?\d+$/.test(value) ? Number(value) : Number.NaN
  if (Number.isFinite(asNumber)) return formatWord(asNumber, format, wordSize)
  if (format === 'hex') {
    const bytes = new TextEncoder().encode(value)
    let out = ''
    for (const b of bytes.slice(0, 8)) out += b.toString(16).toUpperCase().padStart(2, '0')
    return `0x${out.padEnd(HEX_DIGITS[wordSize], '0')}`
  }
  return `"${value}"`
}

export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h >>> 0
}

export function formatPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`
}

export function formatClock(ms: number): string {
  const total = ms / 1000
  const mm = Math.floor(total / 60)
  const ss = Math.floor(total % 60)
  const mmm = Math.floor(ms % 1000)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

export const fmtMs = formatMs

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
