// Unit tests for applyBatchResults (broadcast/runner.js): what a batch of
// send results does to the counters, the checkpoint and the campaign status.
// The database and the sender are stubbed through require.cache.

const assert = require('assert')
const path = require('path')

const calls = []
const stub = (file, exports) => {
  const id = require.resolve(path.join(__dirname, '..', file))
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub('database', {
  db: {
    Broadcast: { updateOne: async (filter, update) => { calls.push({ model: 'Broadcast', update }) } },
    BroadcastRecipient: { updateMany: async (filter, update) => { calls.push({ model: 'BroadcastRecipient', filter, update }) } },
    User: { updateMany: async (filter, update) => { calls.push({ model: 'User', filter, update }) } }
  }
})
stub('broadcast/send', { sendToRecipient: async () => {}, SHORT_RETRY_AFTER_S: 30 })

const { applyBatchResults } = require('../broadcast/runner')
const { shared: rateLimiter } = require('../broadcast/rate-limiter')

let passed = 0
let failed = 0

async function test (name, fn) {
  calls.length = 0
  rateLimiter.nextAvailable = 0
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

const broadcast = { _id: 'b1', progress: { lastRecipientId: 'r0' } }
const recipients = (n) => Array.from({ length: n }, (_, i) => ({ _id: `r${i + 1}`, telegram_id: 100 + i }))
const ok = (i) => ({ telegramId: 100 + i, ok: true })
const rateLimited = (i, seconds) => ({ telegramId: 100 + i, ok: false, err: { code: 429, parameters: { retry_after: seconds } } })
const blocked = (i) => ({ telegramId: 100 + i, ok: false, err: { code: 403, description: 'Forbidden: bot was blocked by the user' } })
const badMedia = (i) => ({ telegramId: 100 + i, ok: false, err: { code: 400, description: 'Bad Request: wrong file_id' } })

const broadcastUpdate = () => calls.find((c) => c.model === 'Broadcast').update
const markedDone = () => calls.filter((c) => c.model === 'BroadcastRecipient').flatMap((c) => c.filter._id.$in)

;(async () => {
  await test('a clean batch advances the checkpoint to its last recipient', async () => {
    const result = await applyBatchResults(broadcast, recipients(3), [ok(0), ok(1), ok(2)])
    assert.strictEqual(result.nextLastRecipientId, 'r3')
    assert.strictEqual(result.pauseReason, null)
    assert.strictEqual(broadcastUpdate().$inc['progress.sent'], 3)
  })

  await test('a short 429 is retried: checkpoint stops before it, not counted failed', async () => {
    const result = await applyBatchResults(broadcast, recipients(4), [ok(0), rateLimited(1, 5), ok(2), blocked(3)])
    assert.strictEqual(result.pauseReason, null, 'must not pause')
    assert.strictEqual(result.nextLastRecipientId, 'r1')
    const { $inc } = broadcastUpdate()
    assert.strictEqual($inc['progress.sent'], 2)
    assert.strictEqual($inc['progress.failed'], 1, 'only the blocked user failed')
    assert.deepStrictEqual(markedDone(), ['r3', 'r4'])
  })

  await test('a short 429 cools the shared limiter', async () => {
    const before = Date.now()
    await applyBatchResults(broadcast, recipients(1), [rateLimited(0, 7)])
    assert.ok(rateLimiter.nextAvailable >= before + 7000)
  })

  await test('a short 429 on the first recipient keeps the old checkpoint', async () => {
    const result = await applyBatchResults(broadcast, recipients(2), [rateLimited(0, 5), ok(1)])
    assert.strictEqual(result.nextLastRecipientId, 'r0')
    assert.deepStrictEqual(markedDone(), ['r2'])
  })

  await test('invalid media still pauses the campaign', async () => {
    const result = await applyBatchResults(broadcast, recipients(3), [ok(0), badMedia(1), ok(2)])
    assert.ok(result.pauseReason)
    assert.strictEqual(broadcastUpdate().$set.status, 'paused')
    assert.strictEqual(result.nextLastRecipientId, 'r1')
  })

  await test('a long 429 still pauses the campaign', async () => {
    const result = await applyBatchResults(broadcast, recipients(2), [ok(0), rateLimited(1, 120)])
    assert.ok(/rate limit/i.test(result.pauseReason))
  })

  await test('a pause after a short 429 pauses, checkpoint at the earlier stop', async () => {
    const result = await applyBatchResults(broadcast, recipients(4), [ok(0), rateLimited(1, 5), ok(2), badMedia(3)])
    assert.ok(result.pauseReason)
    assert.strictEqual(result.nextLastRecipientId, 'r1')
    assert.deepStrictEqual(markedDone(), ['r3'])
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
