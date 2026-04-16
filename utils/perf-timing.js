// Per-stage middleware timing — lightweight wall-clock instrumentation so we
// can see where response time is spent across the Telegraf chain without
// pulling in a profiler. Each stage keeps a rolling buffer of SELF-time
// samples (elapsed time MINUS downstream await), and every N updates we
// log a one-liner with the current p50 per stage.
//
// Design notes:
//   - Date.now() only. console.time/timeEnd stacks badly under concurrent
//     updates (Telegraf processes multiple ctx in parallel).
//   - Zero overhead when PERF_TIMING=0 — perfStage returns the fn unchanged.
//   - Fixed-size ring buffer per stage (N=200) to cap memory.

const WINDOW = 200
const DEFAULT_INTERVAL = 50

const ENABLED = process.env.PERF_TIMING !== '0'
const LOG_INTERVAL = Math.max(1, parseInt(process.env.PERF_TIMING_INTERVAL, 10) || DEFAULT_INTERVAL)

// stage name -> { buf: number[], idx: number, count: number }
// buf is a ring; idx is the next write slot; count is total samples seen.
const stages = Object.create(null)

// Global update counter — ticks once per recorded sample on ANY stage with
// the designated "tick" name. To avoid double-counting we tick off the
// LAST stage in the chain (handler), but any stage could drive it. We
// keep a simple independent counter that perfRecord bumps for a nominated
// "primary" stage. Simpler: bump on every record but only for one stage —
// we let the caller explicitly tick via perfTick().
let updateCount = 0

function getStage (name) {
  let s = stages[name]
  if (!s) {
    s = { buf: [], idx: 0, count: 0 }
    stages[name] = s
  }
  return s
}

function perfRecord (name, ms) {
  const s = getStage(name)
  if (s.buf.length < WINDOW) {
    s.buf.push(ms)
  } else {
    s.buf[s.idx] = ms
    s.idx = (s.idx + 1) % WINDOW
  }
  s.count++
}

function median (arr) {
  if (!arr.length) return 0
  // Copy + sort — buffers are small (<=200) so this is cheap.
  const sorted = arr.slice().sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

function fmt (ms) {
  if (ms >= 10) return ms.toFixed(0) + 'ms'
  return ms.toFixed(1) + 'ms'
}

function perfSnapshot () {
  const out = {}
  for (const name of Object.keys(stages)) {
    const s = stages[name]
    out[name] = {
      p50: median(s.buf),
      samples: s.buf.length,
      total: s.count
    }
  }
  return out
}

function logSummary (n) {
  const names = Object.keys(stages)
  if (!names.length) return
  const parts = names.map(name => `${name}=${fmt(median(stages[name].buf))}`)
  console.log(`[perf] ${parts.join(' ')} (n=${n})`)
}

// Tick the update counter. Call ONCE per update — we attach it to the
// handler stage record since that's the last perf-instrumented step to
// finish. This keeps the log cadence stable regardless of which stages
// are wired up.
function perfTick () {
  if (!ENABLED) return
  updateCount++
  if (updateCount % LOG_INTERVAL === 0) {
    logSummary(LOG_INTERVAL)
  }
}

// Wrap a middleware fn so we record its SELF time (elapsed minus downstream
// await). For the terminal stage pass { tick: true } to drive the periodic
// log summary.
function perfStage (name, fn, opts) {
  if (!ENABLED) return fn
  const tick = !!(opts && opts.tick)
  return async function perfStageWrapped (ctx, next) {
    const start = Date.now()
    let downstreamMs = 0
    try {
      await fn(ctx, async () => {
        const nextStart = Date.now()
        try {
          await next()
        } finally {
          downstreamMs = Date.now() - nextStart
        }
      })
    } finally {
      const selfMs = Date.now() - start - downstreamMs
      perfRecord(name, selfMs < 0 ? 0 : selfMs)
      if (tick) perfTick()
    }
  }
}

module.exports = {
  perfStage,
  perfRecord,
  perfTick,
  perfSnapshot,
  ENABLED
}
