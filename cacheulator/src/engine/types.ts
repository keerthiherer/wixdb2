export type EvictionPolicy = 'LRU' | 'LFU'

export interface Stats {
  hits: number
  misses: number
  evictions: number
  totalRequests: number
  hitRate: number
  missRate: number
}

export type EventKind =
  | 'lock'
  | 'map'
  | 'ttl'
  | 'policy'
  | 'evict'
  | 'insert'
  | 'stats'
  | 'system'
  | 'store'
  | 'clear'
  | 'delete'

export type EventLevel = 'dim' | 'info' | 'good' | 'warn' | 'bad'

export interface SimEvent {
  id: number
  kind: EventKind
  level: EventLevel
  text: string
  key?: string
  thread?: number
}

export type NewEvent = Omit<SimEvent, 'id'>
