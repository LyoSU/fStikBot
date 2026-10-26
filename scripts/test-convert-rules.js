// Unit tests for utils/video-convert-rules.js and the queue helpers it feeds:
// the convert queue keeps the policy's order (Boost first, ru and heavy owners
// later) without letting any wait grow unbounded, "too busy" is decided at
// enqueue on the same rank as before, and a job the converter dropped as too
// old reads as load, not as a broken video.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const {
  convertRank, convertDelay, convertPriority, queueTooBusy, isTooOld, convertFailure, jobFields
} = require('../utils/video-convert-rules')
const { runQueueJob, followQueueJob } = require('../utils/queue-job')

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.stack}`)
  }
}

const T = Date.UTC(2026, 9, 26, 19, 0, 0)
const SECOND = 1000
const boost = { boost: true, locale: 'ru', videoPacks: 900 }
const plain = { locale: 'uk', videoPacks: 0 }
const heavy = { locale: 'uk', videoPacks: 300 }
const ru = { locale: 'ru', videoPacks: 300 }

// The order Bull serves: lowest priority first, ties by arrival.
const served = (jobs) => [...jobs].sort((a, b) => a.priority - b.priority || a.at - b.at).map((job) => job.name)

;(async () => {
  console.log('convert-rules')

  await test('added together, Boost goes first, then plain, heavy owners, ru', () => {
    const jobs = [
      { name: 'ru', at: T, priority: convertPriority(ru, T) },
      { name: 'heavy', at: T, priority: convertPriority(heavy, T) },
      { name: 'plain', at: T, priority: convertPriority(plain, T) },
      { name: 'boost', at: T, priority: convertPriority(boost, T) }
    ]
    assert.deepStrictEqual(served(jobs), ['boost', 'plain', 'heavy', 'ru'])
  })

  await test('a waiting job is overtaken only by jobs added within its own delay', () => {
    const worst = convertDelay(ru)
    const old = { name: 'old ru', at: T, priority: convertPriority(ru, T) }
    // A Boost video added just after the delay runs out comes after it.
    const late = { name: 'late boost', at: T + (worst + 1) * SECOND, priority: convertPriority(boost, T + (worst + 1) * SECOND) }
    const early = { name: 'early boost', at: T + (worst - 5) * SECOND, priority: convertPriority(boost, T + (worst - 5) * SECOND) }

    assert.deepStrictEqual(served([late, old, early]), ['early boost', 'old ru', 'late boost'])
  })

  await test('no tier waits unbounded: every delay is capped, Boost gives none', () => {
    assert.strictEqual(convertDelay(boost), 0)
    assert.ok(convertDelay({ locale: 'ru', videoPacks: 1e6 }) <= 5 * 60, 'the worst head start is a few minutes')
    assert.strictEqual(convertDelay({ locale: 'uk', videoPacks: 1e6 }), convertDelay({ locale: 'uk', videoPacks: 300 }))
    assert.ok(convertDelay(plain) < convertDelay(heavy) && convertDelay(heavy) < convertDelay(ru))
  })

  await test('priorities are small positive integers, never Bull\'s "no priority" 0', () => {
    const p = convertPriority(boost, T)
    assert.ok(Number.isInteger(p) && p > 0 && p < 2 ** 31)
    assert.strictEqual(convertPriority(boost, Date.UTC(2026, 0, 1)), 1)
  })

  await test('too busy is judged at enqueue on the policy\'s rank, as before', () => {
    assert.strictEqual(convertRank(boost), 5)
    assert.strictEqual(convertRank({ locale: 'ru', videoPacks: 9 }), 43)
    assert.strictEqual(queueTooBusy(201, convertRank(ru)), true)
    assert.strictEqual(queueTooBusy(201, convertRank(heavy)), true)
    assert.strictEqual(queueTooBusy(201, convertRank(plain)), false)
    assert.strictEqual(queueTooBusy(200, convertRank(ru)), false)
  })

  await test('a job dropped as too old is load: high-load text, timeout metric, no log chat', () => {
    for (const reason of ['host ::: too_old: waited 700000 ms, limit 600000 ms', 'host ::: Job timeout - older than 600000ms', 'timeout']) {
      assert.deepStrictEqual(convertFailure(reason), {
        code: 'too_old', level: 'warn', i18nKey: 'sticker.add.error.timeout', metric: 'timeout', logChat: false
      })
    }
    assert.deepStrictEqual(convertFailure('host ::: ffmpeg exited with code 1'), {
      code: 'failed', level: 'error', i18nKey: 'sticker.add.error.convert', metric: 'convert', logChat: true
    })
    assert.strictEqual(isTooOld(undefined), false)
  })

  await test('a queue line names the job, its priority and its wait', () => {
    assert.deepStrictEqual(jobFields({ id: 123456789, opts: { priority: 26000000 }, timestamp: 1000, processedOn: 61000 }), {
      jobId: '123456789', priority: 26000000, waitMs: 60000
    })
    assert.deepStrictEqual(jobFields({ id: 1, opts: {} }), { jobId: '1', priority: undefined, waitMs: undefined })
  })

  await test('a job kept for a returning waiter stays in Redis; others go at once', async () => {
    const added = []
    const done = { id: 1, opts: {}, finished: async () => ({ content: 'x' }) }
    const queue = { name: 'convert', add: async (data, opts) => { added.push(opts); return done } }

    const kept = await runQueueJob(queue, {}, { timeoutMs: 1000, priority: 7, keepSeconds: 600 })
    await runQueueJob(queue, {}, { timeoutMs: 1000 })

    assert.deepStrictEqual(kept, { result: { content: 'x' } })
    assert.deepStrictEqual(added[0], { priority: 7, attempts: 1, removeOnComplete: { age: 600 }, removeOnFail: { age: 600 } })
    assert.strictEqual(added[1].removeOnComplete, true)
    assert.strictEqual(added[1].removeOnFail, true)
  })

  await test('following a found job: its result, or its failure with the converter\'s reason', async () => {
    const queue = { name: 'convert' }
    const ok = await followQueueJob(queue, { id: 2, opts: {}, finished: async () => ({ content: 'y' }) }, { timeoutMs: 1000 })
    assert.deepStrictEqual(ok, { result: { content: 'y' } })

    const old = await followQueueJob(queue, { id: 3, opts: {}, finished: async () => { throw new Error('h ::: too_old: waited') } }, { timeoutMs: 1000 })
    assert.strictEqual(old.error, 'failed')
    assert.ok(isTooOld(old.cause.message))

    const empty = await followQueueJob(queue, { id: 4, opts: {}, finished: async () => ({}) }, { timeoutMs: 1000 })
    assert.deepStrictEqual(empty, { error: 'failed' })
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
})()
