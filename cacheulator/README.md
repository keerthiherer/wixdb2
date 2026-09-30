# Cacheulator

A CPulator-style simulator for the **WIX in-memory cache**. The cache is not a
black box any more — it is a chip you can single-step: every `GET` becomes a
clock-tick trace through the hash map probe, the TTL guard, the policy chain and
the eviction guard, with live flash activity on the die.

```
npm install
npm run dev      # http://localhost:5173
npm run verify   # fidelity harness: the TS core vs the Java behaviour
npm run build
npm run lint
```

## What it models

Ported instruction-for-instruction from
`../wixdb/cache-server/src/main/java/cache/InMemoryCache.java`:

| Java | Simulated as |
| --- | --- |
| `WixCache` + `CacheNode` | `src/engine/cache.ts` — `Cache`, `CacheNode` |
| `DoublyLinkedList` | `DoublyLinkedList` with `addFirst/removeLast` |
| LRU chain | one doubly linked list, recency order |
| LFU buckets + `minFrequency` | `Map<number, DoublyLinkedList>` + min-frequency cursor |
| per-entry `expireAtMs` | `NO_EXPIRY = Infinity`, checked on read and swept on write |
| `ReentrantLock` | every operation yields `lock: acquire → work → unlock` |
| `stats` | hits, misses, hit/miss rate, evictions, expirations, per-policy |
| `Map<String,Long> locks` | lock-contention lines in the terminal |

## The instruction language

`src/engine/program.ts` parses the `.wix` programs shown in the editor.

```
!CAPACITY 5        !POLICY LRU|LFU     !TICK 100        !AUTOFILL on|off
SET key value [EX <ttl>]      GET key            DEL key
EXISTS key                     KEYS              DBSIZE
TTL key                        FLUSHDB           CLEAN
CONFIG GET|SET <k> <v>         INFO              SLEEP 500ms
SPAWN <n> <GET key|SET k v>    PATTERN zipf|seq|hot|scan <count> [size] [SEED n]
```

`PATTERN` expands to a deterministic key sequence at parse time (seeded
`mulberry32`), so the LRU run and the LFU run see **exactly** the same requests
and the hit-rate difference is attributable to the policy alone.

`GET` on a miss simulates cache-aside: the backing store is read and the value
is written back (`!AUTOFILL off` turns that off, which is what the raw WIX
server does — it just returns `nil`).

## Debugger

- **Step Into** — one clock tick, including inside `SET`/`GET`
- **Step Over** — runs the instruction to completion
- **Step Out** — jumps to the next source line
- **Continue** — runs to the next breakpoint/watchpoint/end
- Breakpoints (line margin), watchpoints (`CONFIG SET watch ...`), speed dial
- Live terminal (RESP-ish `OK`/`nil` output), devices table, metrics panel
- **Compare** runs the same program under LRU and LFU and reports both hit rates

## Samples

All eight scenarios from `../wixdb/cache_demo.py` are ported in
`src/engine/samples.ts`: capacity overflow, frequency vs recency, scan
resistance, per-entry TTL, thread safety, plus zipf/sequential/hot access
patterns. `untitled.wix` is the guided tour that boots with `HELP`.

## Verification

`npm run verify` checks the simulator against the behaviour documented in
`cache_demo.py`: which key each policy evicts, TTL sweeps, thread interleaving,
capacity never exceeded, `hits + misses == requests`, and deterministic
patterns. It is the reason the port can be trusted as a teaching artefact.
