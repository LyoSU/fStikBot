// Unit tests for the bootstrap-placeholder removal (utils/placeholder.js).
// Runs without a DB or a real Telegram connection — telegram is injected and
// the sticker-set doc is a plain object with a fake save().

const assert = require('assert')
const { removePlaceholderIfPending } = require('../utils/placeholder')

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
    console.log(`        ${error.message}`)
  }
}

// A fake sticker-set doc: tracks whether save() ran.
function makeSet (placeholderFileUniqueId) {
  let saved = 0
  return {
    placeholderFileUniqueId,
    save: async () => { saved++ },
    savedCount: () => saved
  }
}

// A fake telegram whose callApi records calls and can be scripted to fail.
//   fail: true                → always throw a generic error
//   failTimes: N, retryAfter  → throw a 429 (with retry_after) N times, then succeed
//   failWith: error, failTimes: N → throw the given error N times, then succeed
function makeTelegram ({ fail = false, failTimes = 0, retryAfter = null, failWith = null } = {}) {
  const calls = []
  return {
    calls,
    callApi: async (method, payload) => {
      calls.push({ method, payload })
      if (fail) throw Object.assign(new Error('Too Many Requests'), { description: 'Too Many Requests' })
      if (calls.length <= failTimes) {
        if (failWith) throw failWith
        throw Object.assign(new Error('Too Many Requests'), {
          code: 429,
          parameters: { retry_after: retryAfter }
        })
      }
      return true
    }
  }
}

// A fake Mongoose doc hydrated through a projection that omits the marker:
// the field reads undefined even though the DB still holds `dbMarker`.
// `fresh` is what a re-read through the doc's model returns.
function makeProjectedSet (dbMarker) {
  const fresh = makeSet(dbMarker)
  fresh._id = 'set-id'
  const Model = {
    findById: () => ({
      select: () => Promise.resolve(fresh)
    })
  }
  const projected = {
    _id: 'set-id',
    placeholderFileUniqueId: undefined,
    isSelected: (path) => path !== 'placeholderFileUniqueId',
    save: async () => {},
    constructor: Model
  }
  return { projected, fresh }
}

async function main () {
  console.log('placeholder removal tests\n')

  await test('no marker → nothing to do, returns resolved', async () => {
    const tg = makeTelegram()
    const set = makeSet(undefined)
    const result = await removePlaceholderIfPending(tg, set, { stickers: [{ file_unique_id: 'a' }, { file_unique_id: 'b' }] })
    assert.strictEqual(result, true)
    assert.strictEqual(tg.calls.length, 0, 'must not call Telegram')
  })

  await test('only placeholder in set → not resolved (never delete last sticker)', async () => {
    const tg = makeTelegram()
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, { stickers: [{ file_unique_id: 'ph', file_id: 'PH' }] })
    assert.strictEqual(result, false, 'must defer until a real sticker exists')
    assert.strictEqual(tg.calls.length, 0, 'must not attempt deletion of the last sticker')
    assert.strictEqual(set.placeholderFileUniqueId, 'ph', 'marker kept for retry')
  })

  await test('allowEmpty: lone placeholder → deleted, set may become empty', async () => {
    const tg = makeTelegram()
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [{ file_unique_id: 'ph', file_id: 'PH_FILE_ID' }]
    }, { allowEmpty: true })
    assert.strictEqual(result, true)
    assert.strictEqual(tg.calls.length, 1)
    assert.strictEqual(tg.calls[0].payload.sticker, 'PH_FILE_ID')
    assert.strictEqual(set.placeholderFileUniqueId, undefined, 'marker cleared')
  })

  await test('allowEmpty: set already empty → stale marker cleared, no API call', async () => {
    const tg = makeTelegram()
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, { stickers: [] }, { allowEmpty: true })
    assert.strictEqual(result, true, 'nothing left to delete — resolved')
    assert.strictEqual(tg.calls.length, 0)
    assert.strictEqual(set.placeholderFileUniqueId, undefined, 'stale marker cleared')
  })

  await test('placeholder + real sticker → deletes by file_id, clears marker, saves', async () => {
    const tg = makeTelegram()
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [
        { file_unique_id: 'ph', file_id: 'PH_FILE_ID' },
        { file_unique_id: 'real', file_id: 'REAL_FILE_ID' }
      ]
    })
    assert.strictEqual(result, true)
    assert.strictEqual(tg.calls.length, 1)
    assert.strictEqual(tg.calls[0].method, 'deleteStickerFromSet')
    assert.strictEqual(tg.calls[0].payload.sticker, 'PH_FILE_ID', 'must delete the placeholder file_id, not the real one')
    assert.strictEqual(set.placeholderFileUniqueId, undefined, 'marker cleared')
    assert.ok(set.savedCount() >= 1, 'set persisted')
  })

  await test('never deletes a real sticker even if placeholder already gone', async () => {
    const tg = makeTelegram()
    const set = makeSet('ph')
    // placeholder no longer present — only real stickers remain
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [
        { file_unique_id: 'real1', file_id: 'R1' },
        { file_unique_id: 'real2', file_id: 'R2' }
      ]
    })
    assert.strictEqual(result, true, 'resolved — nothing to delete')
    assert.strictEqual(tg.calls.length, 0, 'must not delete any real sticker')
    assert.strictEqual(set.placeholderFileUniqueId, undefined, 'stale marker cleared')
  })

  await test('non-retriable failure → marker kept, returns false (self-healing retry)', async () => {
    const tg = makeTelegram({ fail: true })
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [
        { file_unique_id: 'ph', file_id: 'PH_FILE_ID' },
        { file_unique_id: 'real', file_id: 'REAL_FILE_ID' }
      ]
    })
    assert.strictEqual(result, false)
    assert.strictEqual(tg.calls.length, 1, 'no retry without a retry_after')
    assert.strictEqual(set.placeholderFileUniqueId, 'ph', 'marker kept so the next add retries')
  })

  await test('429 with retry_after → waits and retries, then deletes', async () => {
    // Fail once with a tiny retry_after (keeps the test fast), then succeed.
    const tg = makeTelegram({ failTimes: 1, retryAfter: 0.01 })
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [
        { file_unique_id: 'ph', file_id: 'PH_FILE_ID' },
        { file_unique_id: 'real', file_id: 'REAL_FILE_ID' }
      ]
    })
    assert.strictEqual(result, true, 'eventually deleted after waiting out the 429')
    assert.strictEqual(tg.calls.length, 2, 'retried once')
    assert.strictEqual(set.placeholderFileUniqueId, undefined, 'marker cleared after success')
  })

  await test('marker hidden by projection → re-reads it via the model and deletes', async () => {
    const tg = makeTelegram()
    const { projected, fresh } = makeProjectedSet('ph')
    const result = await removePlaceholderIfPending(tg, projected, {
      stickers: [
        { file_unique_id: 'ph', file_id: 'PH_FILE_ID' },
        { file_unique_id: 'real', file_id: 'REAL_FILE_ID' }
      ]
    })
    assert.strictEqual(result, true)
    assert.strictEqual(tg.calls.length, 1, 'must delete despite the projected doc')
    assert.strictEqual(tg.calls[0].payload.sticker, 'PH_FILE_ID')
    assert.strictEqual(fresh.placeholderFileUniqueId, undefined, 'marker cleared on the re-read doc')
  })

  await test('marker selected and truly absent → no re-read, nothing to do', async () => {
    const tg = makeTelegram()
    const set = makeSet(undefined)
    set.isSelected = () => true // full doc — absence means "already removed"
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [{ file_unique_id: 'a' }, { file_unique_id: 'b' }]
    })
    assert.strictEqual(result, true)
    assert.strictEqual(tg.calls.length, 0)
  })

  await test('network error (no Telegram description) → retried, then deletes', async () => {
    const tg = makeTelegram({ failTimes: 1, failWith: new Error('socket hang up') })
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [
        { file_unique_id: 'ph', file_id: 'PH_FILE_ID' },
        { file_unique_id: 'real', file_id: 'REAL_FILE_ID' }
      ]
    })
    assert.strictEqual(result, true, 'transient failure must be retried')
    assert.strictEqual(tg.calls.length, 2, 'retried once')
    assert.strictEqual(set.placeholderFileUniqueId, undefined)
  })

  await test('Telegram 5xx → retried, then deletes', async () => {
    const tg = makeTelegram({
      failTimes: 1,
      failWith: Object.assign(new Error('Internal Server Error'), { code: 502, description: 'Bad Gateway' })
    })
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [
        { file_unique_id: 'ph', file_id: 'PH_FILE_ID' },
        { file_unique_id: 'real', file_id: 'REAL_FILE_ID' }
      ]
    })
    assert.strictEqual(result, true)
    assert.strictEqual(tg.calls.length, 2)
  })

  await test('400 Bad Request → NOT retried (deterministic error)', async () => {
    const tg = makeTelegram({
      fail: false,
      failTimes: 99,
      failWith: Object.assign(new Error('Bad Request: STICKERSET_INVALID'), { code: 400, description: 'Bad Request: STICKERSET_INVALID' })
    })
    const set = makeSet('ph')
    const result = await removePlaceholderIfPending(tg, set, {
      stickers: [
        { file_unique_id: 'ph', file_id: 'PH_FILE_ID' },
        { file_unique_id: 'real', file_id: 'REAL_FILE_ID' }
      ]
    })
    assert.strictEqual(result, false)
    assert.strictEqual(tg.calls.length, 1, 'a 400 must not be retried')
    assert.strictEqual(set.placeholderFileUniqueId, 'ph', 'marker kept for the next add')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('smoke test OK')
}

main()
