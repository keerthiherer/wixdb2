# Cacheulator — WIX, visualised as a chip

**A custom in-memory key-value database, and a CPulator-style simulator that shows you exactly how it thinks.**

WIX is a thread-safe in-memory database with pluggable eviction, per-entry TTL and live stats, written from scratch in Java and speaking RESP so `redis-cli` can talk to it. Cacheulator takes that same cache core and renders it as a processor: a silicon die, a program counter, one clock tick per animation frame, and a debugger that lets you single-step *through* a cache lookup — hash map probe, TTL guard, policy chain, eviction guard, unlock.

```
hackforge/
├── wixdb/                  the database
│   ├── cache-server/       Java 23 + Maven — WIX itself (LRU/LFU, TTL, RESP server)
│   ├── metrics/            Next.js 16 metrics dashboard
│   └── cache_demo.py       the behavioural reference for all simulator scenarios
└── cacheulator/            the simulator — Vite + React 19 + TypeScript
```

---

## Quick start

**The simulator** (no Java needed — the cache core is ported to TypeScript):

```bash
cd cacheulator
npm install
npm run dev      # http://localhost:5173
```

**The real server:**

```bash
cd wixdb/cache-server
mvn compile
mvn package
java -jar target/custom-cache.jar --port 6379 --capacity 100 --eviction LRU
redis-cli -p 6379        # or any RESP client
```

```
java cache.Main [--port PORT] [--capacity CAPACITY] [--eviction LRU|LFU]
Defaults: port=6379, capacity=100, eviction=LRU
```

---

## What Cacheulator shows you

| | |
| --- | --- |
| **Die view** | live cache slots, pins, and the policy chain (LRU list / LFU buckets + `minFrequency`) with flash pulses on every read, write and eviction |
| **Clock-tick debugger** | Step Into / Over / Out / Continue, breakpoints in the gutter, watchpoints, speed dial |
| **Virtual threads** | `SPAWN` shows real `ReentrantLock` contention — threads block on `acquire()` until the holder unlocks |
| **Terminal** | RESP-ish output: `OK`, `nil`, `INFO`, lock acquisitions, eviction reasons |
| **Devices / Metrics** | hit rate, misses, evictions, expirations, per-policy breakdown, live occupancy |
| **A/B compare** | runs the same program under LRU and LFU and reports both hit rates side by side |

### The instruction language

The editor runs small `.wix` programs:

```
!CAPACITY 5        !POLICY LRU|LFU     !TICK 100        !AUTOFILL on|off
SET key value [EX <ttl>]      GET key            DEL key        EXISTS key
KEYS [pattern]     DBSIZE     TTL key            FLUSHDB        CLEAN
CONFIG GET|SET <k> <v>         INFO              SLEEP 500ms
SPAWN <n> <GET key|SET k v>    PATTERN zipf|seq|hot|scan <count> [size] [SEED n]
```

`PATTERN` expands to a deterministic, seeded key sequence, so the LRU run and
the LFU run see **identical** requests — every difference in the numbers is
attributable to the policy alone. A miss can simulate cache-aside: the backing
store is read and written back (this is what the raw WIX server does *not* do —
it returns `nil` and leaves the refetch to the application).

The command set is the server's (`SET GET DEL EXISTS KEYS DBSIZE FLUSHDB INFO
CONFIG`) plus four debugging affordances that have no RESP equivalent because
the server does them implicitly: `TTL` (inspect a deadline), `CLEAN` (trigger
`cleanExpired()` by hand), `SLEEP` (advance the simulated clock) and `SPAWN` /
`PATTERN` (drive concurrency and access patterns).

### Built-in scenarios

All eight scenarios from `wixdb/cache_demo.py` are ported: capacity overflow,
frequency vs recency, scan resistance, per-entry TTL, and thread safety — plus
zipf, sequential and hot-key access patterns. `untitled.wix` is the guided tour.

---

## Fidelity

The TypeScript core is a port of `InMemoryCache.java`, not a re-implementation
with different trade-offs:

```
cd cacheulator
npm run verify
```

60 checks covering which key each policy evicts, TTL sweep and lazy expiry,
lock interleaving, `hits + misses == requests`, capacity never exceeded,
deterministic pattern generation, and the documented outcome of every scenario
in `cache_demo.py`. If the simulator and the Java disagree, the harness fails.

---

## Stack

- **WIX** — Java 23, Maven, zero runtime dependencies, Virtual Threads, RESP wire protocol
- **Cacheulator** — Vite 8, React 19, TypeScript 6, oxlint, zero UI dependencies (hand-rolled CSS design system)

## License

MIT
