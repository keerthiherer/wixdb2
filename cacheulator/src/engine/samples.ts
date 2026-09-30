export interface Sample {
  id: string
  name: string
  group: string
  blurb: string
  source: string
}

/**
 * The guided programs mirror the scenarios in wixdb/cache_demo.py, expressed in
 * the simulator's instruction language.
 */
export const SAMPLES: Sample[] = [
  {
    id: 'tour',
    name: 'untitled.wix',
    group: 'Guided tour',
    blurb: 'Hand-worked GET/SET/TTL tour that ends in a sample access pattern',
    source: `# ── WIX core walkthrough ────────────────────────────────
# Step Into advances one Java statement at a time.
!CAPACITY 8
!POLICY LRU
!TICK 100

# 1. writes: the second entry carries a per-entry TTL
SET user:1 Alice EX 30
SET user:2 Bob
SET user:3 Cara

# 2. reads: a hit moves the node to the head of the LRU list
GET user:1
GET user:1

# 3. a miss falls back to the backing store (cache-aside)
GET user:7

# 4. overflow the cache and watch the LRU victim get evicted
SET user:4 Dan
SET user:5 Eve
SET user:6 Fay
SET user:8 Gil

DBSIZE
INFO

# 5. replay a sample access pattern to fill the metrics panel
PATTERN zipf 150 0.8 SEED 7
INFO
`,
  },
  {
    id: 'basic-eviction',
    name: 'scenario-1-basic-eviction',
    group: 'LRU vs LFU',
    blurb: 'Fill to capacity, skew the access pattern, then force one eviction',
    source: `# Scenario 1 — basic eviction on capacity overflow
# Capacity 5, keys A..E, then F forces exactly one eviction.
# C is never read after its SET, so it is the victim under both policies.
!CAPACITY 5
!POLICY LRU
!TICK 100

SET A val-A
SET B val-B
SET C val-C
SET D val-D
SET E val-E

# recency order after this: E > D > B > A > C
GET A
GET A
GET B
GET D
GET E

SET F val-F
KEYS
INFO
`,
  },
  {
    id: 'freq-vs-recency',
    name: 'scenario-2-frequency-vs-recency',
    group: 'LRU vs LFU',
    blurb: 'A hot key that goes cold: LRU throws it away, LFU keeps it',
    source: `# Scenario 2 — frequency vs recency
# "hot" is read 10 times, then goes untouched while w x y z cycle.
# !AUTOFILL off so a miss stays a miss: the real WIX server returns nil and
# leaves the refetch to the application, which is what we want to observe here.
!CAPACITY 5
!POLICY LRU
!TICK 100
!AUTOFILL off

SET hot popular-value
GET hot
GET hot
GET hot
GET hot
GET hot
GET hot
GET hot
GET hot
GET hot
GET hot

# "hot" is now the LEAST recently used but by far the MOST frequent
SET w val-w
SET x val-x
SET y val-y
SET z val-z

GET w
GET x
GET y
GET z

SET new triggers-eviction
GET hot
INFO
`,
  },
  {
    id: 'scan-resistance',
    name: 'scenario-3-scan-resistance',
    group: 'LRU vs LFU',
    blurb: 'A one-shot scan burst evicts the whole working set under LRU',
    source: `# Scenario 3 — scan resistance
# A 3-key working set plus 2 fillers reach capacity 5.
# A burst of 5 one-shot keys then evicts live data.
!CAPACITY 5
!POLICY LRU
!TICK 100

SET ws1 working-ws1
SET ws2 working-ws2
SET ws3 working-ws3

GET ws1
GET ws2
GET ws3
GET ws1
GET ws2
GET ws3
GET ws1
GET ws2
GET ws3
GET ws1
GET ws2
GET ws3

SET fill1 filler-fill1
SET fill2 filler-fill2
KEYS

# scan burst — every key is used exactly once
SET scan1 one-shot-1
SET scan2 one-shot-2
SET scan3 one-shot-3
SET scan4 one-shot-4
SET scan5 one-shot-5

KEYS
INFO
`,
  },
  {
    id: 'ttl',
    name: 'scenario-4-ttl',
    group: 'TTL',
    blurb: 'Per-entry TTL expiring independently of the eviction policy',
    source: `# Scenario 4 — per-entry TTL
# TTL is checked on every read, and swept before an eviction happens.
# It has nothing to do with which eviction policy is selected.
!CAPACITY 8
!POLICY LFU
!TICK 100

SET short-lived gone-soon EX 2
SET long-lived stays-around EX 30
SET permanent never-expires

# all three are live right now
GET short-lived
GET long-lived
GET permanent
TTL short-lived

# advance the simulated clock past short-lived's deadline
SLEEP 3s

# expired reads are misses: the node is unlinked and the miss is counted
GET short-lived
GET long-lived
GET permanent
TTL short-lived

CLEAN
KEYS
INFO
`,
  },
  {
    id: 'concurrency',
    name: 'concurrency.vt',
    group: 'Threading',
    blurb: 'Virtual threads contending for the ReentrantLock that guards the cache',
    source: `# Thread safety — every operation runs inside ReentrantLock
# SPAWN launches Java virtual threads; they all queue on the same lock,
# so the HashMap, the order list and the counters can never tear.
!CAPACITY 2
!POLICY LRU
!TICK 100

SET k:1 first
SPAWN 8 GET k:1
SPAWN 8 GET k:2
SPAWN 4 SET k:2 second

# now the cache is thrashing: two keys, eight writers each
SPAWN 6 GET k:1
GET k:1
INFO
`,
  },
  {
    id: 'zipf',
    name: 'benchmark-zipf.wix',
    group: 'Metrics',
    blurb: 'Zipfian popularity over 64 keys — the classic cache workload',
    source: `# Zipf workload — popularity follows a power law.
# Compare LRU against LFU with the A/B button in the Metrics panel.
!CAPACITY 16
!POLICY LRU
!TICK 100

PATTERN zipf 400 0.8 SEED 7
INFO
`,
  },
  {
    id: 'seq',
    name: 'benchmark-seq.wix',
    group: 'Metrics',
    blurb: 'Sequential scan — the workload where LRU hits 0% and LFU survives',
    source: `# Sequential scan — every access is a key the cache has not seen recently.
# LRU collapses to a 0% hit rate; LFU keeps the tail of the scan alive.
!CAPACITY 8
!POLICY LRU
!TICK 100

PATTERN seq 200 SEED 3
INFO
`,
  },
  {
    id: 'scan-pattern',
    name: 'benchmark-scan.wix',
    group: 'Metrics',
    blurb: 'Interleaved working set and one-shot bursts — the LRU pathology',
    source: `# Working set + a one-shot burst that is longer than the cache itself.
# LRU walks the LRU list straight past the working set; LFU's cold buckets absorb it.
!CAPACITY 12
!POLICY LRU
!TICK 100

PATTERN scan 300 20 SEED 11
INFO
`,
  },
]

export const DEFAULT_SAMPLE = SAMPLES[0]
