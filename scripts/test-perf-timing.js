// Standalone smoke test for utils/perf-timing.js
// Run: node scripts/test-perf-timing.js
//
// Verifies:
//   1. perfStage wraps a middleware and records SELF time (not downstream)
//   2. perfSnapshot returns reasonable p50s matching the known delays
//   3. The summary log fires exactly once at the 50-update boundary
//      when PERF_TIMING_INTERVAL=50 and we run 60 cycles

process.env.PERF_TIMING = '1'
process.env.PERF_TIMING_INTERVAL = '50'

const assert = require('assert')

// Require AFTER env is set — module reads env at load time.
const { perfStage, perfSnapshot } = require('../utils/perf-timing')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function run () {
  console.log('perf-timing.js smoke test')

  // Capture console.log output so we can count "[perf]" lines.
  const perfLogs = []
  const origLog = console.log
  console.log = function (...args) {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
    if (line.startsWith('[perf]')) {
      perfLogs.push(line)
    } else {
      origLog.apply(console, args)
    }
  }

  // Build a 3-stage chain with known per-stage self-time delays.
  // stageA waits 5ms BEFORE next, stageB waits 10ms BEFORE next,
  // stageC is the terminal (tick=true) and waits 20ms with no next call.
  const stageA = perfStage('stageA', async (ctx, next) => {
    await sleep(5)
    await next()
  })
  const stageB = perfStage('stageB', async (ctx, next) => {
    await sleep(10)
    await next()
  })
  const stageC = perfStage('stageC', async (ctx) => {
    // terminal — simulate handler body
    await sleep(20)
    ctx.done = true
  }, { tick: true })

  // Compose manually: stageA(stageB(stageC))
  async function runOnce () {
    const ctx = {}
    await stageA(ctx, () => stageB(ctx, () => stageC(ctx, async () => {})))
    return ctx
  }

  const CYCLES = 60
  for (let i = 0; i < CYCLES; i++) {
    // eslint-disable-next-line no-await-in-loop
    await runOnce()
  }

  // Restore console.log
  console.log = origLog

  const snap = perfSnapshot()
  console.log('snapshot:', JSON.stringify(snap))
  console.log(`perf log lines captured: ${perfLogs.length}`)
  perfLogs.forEach(l => console.log('  >', l))

  // Assertions: p50s should be within a tolerance window around the
  // known delays. setTimeout is not precise — allow +/- 15ms plus some
  // headroom for slow CI, but require at least the floor.
  const tol = 15
  assert.ok(snap.stageA, 'stageA recorded')
  assert.ok(snap.stageB, 'stageB recorded')
  assert.ok(snap.stageC, 'stageC recorded')

  assert.ok(snap.stageA.p50 >= 4 && snap.stageA.p50 <= 5 + tol,
    `stageA p50 expected ~5ms, got ${snap.stageA.p50}`)
  assert.ok(snap.stageB.p50 >= 9 && snap.stageB.p50 <= 10 + tol,
    `stageB p50 expected ~10ms, got ${snap.stageB.p50}`)
  assert.ok(snap.stageC.p50 >= 19 && snap.stageC.p50 <= 20 + tol,
    `stageC p50 expected ~20ms, got ${snap.stageC.p50}`)

  assert.strictEqual(snap.stageA.total, CYCLES, 'stageA total == CYCLES')
  assert.strictEqual(snap.stageB.total, CYCLES, 'stageB total == CYCLES')
  assert.strictEqual(snap.stageC.total, CYCLES, 'stageC total == CYCLES')

  // With INTERVAL=50 and 60 cycles, the summary should fire exactly once
  // (at cycle 50). Cycle 100 won't happen.
  assert.strictEqual(perfLogs.length, 1,
    `expected exactly 1 [perf] log line, got ${perfLogs.length}`)
  assert.ok(perfLogs[0].includes('stageA='), 'log mentions stageA')
  assert.ok(perfLogs[0].includes('stageB='), 'log mentions stageB')
  assert.ok(perfLogs[0].includes('stageC='), 'log mentions stageC')
  assert.ok(perfLogs[0].includes('(n=50)'), 'log includes (n=50)')

  console.log('\nsmoke test OK')
}

run().catch(err => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
