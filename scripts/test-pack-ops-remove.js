// Unit tests for deleting a whole pack from Studio (pack-ops/execute.js
// removePack, the worker's sync of a remove commit) against an in-memory
// Telegram: faults before and after the call, a set Telegram already lost, a
// set this bot can't delete, and what a worker that predates removes does.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const { runCommit } = require('../pack-ops/execute')
const { createWorker } = require('../pack-ops/worker')
const { uniqueIdOf } = require('../pack-ops/fresh')

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

const networkError = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
const telegramError = (code, description) => Object.assign(new Error(description), { code, description })
const invalid = () => telegramError(400, 'Bad Request: STICKERSET_INVALID')

// One set; `ours: false` is a set some other bot made: deleting it answers
// STICKERSET_INVALID although it is there. A set this bot deleted answers a
// second delete with STICKERPACK_NOT_FOUND (measured). `stale`: the set was
// deleted in a Telegram app and getStickerSet still serves the Bot API's old
// copy of it.
function fakeTelegram ({ exists = true, ours = true, stale = false, faults = {} } = {}) {
  let deletedByUs = false
  const t = {
    exists,
    calls: [],
    async callApi (method, params) {
      const n = t.calls.length
      t.calls.push(method)
      if (faults[n] === 'lost') throw networkError()
      let result
      if (method === 'getStickerSet') {
        if (!t.exists && !stale) throw invalid()
        result = { name: params.name, stickers: [{ file_unique_id: 'a', file_id: 'fa' }] }
      } else if (method === 'deleteStickerSet') {
        if (deletedByUs) throw telegramError(400, 'Bad Request: STICKERPACK_NOT_FOUND')
        if (!t.exists || !ours) throw invalid()
        t.exists = false
        deletedByUs = true
        result = true
      } else {
        throw new Error(`unexpected ${method}`)
      }
      if (faults[n] === 'noreply') throw networkError()
      return result
    }
  }
  return t
}

const fakeStore = () => ({ saved: null, async save (commit) { this.saved = structuredClone(commit) } })
const fakeLock = () => ({ async acquire () { return 'token' }, async extend () { return true }, async release () {} })

const removeCommit = () => ({
  _id: 'c1',
  name: 'cats_by_bot',
  ownerTelegramId: 1,
  remove: true,
  base: [],
  draft: [],
  status: 'pending',
  phase: null,
  steps: [],
  mapping: null
})

const run = (commit, telegram, deps = {}) => runCommit(commit, { telegram, store: fakeStore(), lock: fakeLock(), ...deps })

;(async () => {
  await test('a remove commit deletes the set and succeeds', async () => {
    const telegram = fakeTelegram()
    const commit = await run(removeCommit(), telegram)
    assert.strictEqual(commit.status, 'succeeded')
    assert.strictEqual(telegram.exists, false)
    assert.deepStrictEqual(telegram.calls, ['getStickerSet', 'deleteStickerSet'])
    assert.deepStrictEqual(commit.steps.map((s) => [s.kind, s.state]), [['remove', 'succeeded']])
    assert.deepStrictEqual(commit.removedOrder, ['a'], 'the order is read before the delete, base stays empty')
    assert.deepStrictEqual(commit.base, [])
  })

  await test('a request that never reached Telegram is interrupted, then finished', async () => {
    const telegram = fakeTelegram({ faults: { 1: 'lost' } })
    let commit = await run(removeCommit(), telegram)
    assert.strictEqual(commit.status, 'interrupted')
    assert.strictEqual(telegram.exists, true)
    commit = await run(commit, telegram)
    assert.strictEqual(commit.status, 'succeeded')
    assert.strictEqual(telegram.exists, false)
  })

  await test('a lost answer is settled by the second delete and getStickerSet', async () => {
    const telegram = fakeTelegram({ faults: { 1: 'noreply' } })
    let commit = await run(removeCommit(), telegram)
    assert.strictEqual(commit.status, 'interrupted')
    assert.strictEqual(telegram.exists, false)
    commit = await run(commit, telegram)
    assert.strictEqual(commit.status, 'succeeded')
    assert.deepStrictEqual(telegram.calls, ['getStickerSet', 'deleteStickerSet', 'deleteStickerSet', 'getStickerSet'])
    assert.deepStrictEqual(commit.removedOrder, ['a'], 'kept: our own delete went through, only its answer was lost')
  })

  await test('the order comes from the server\'s read when it can be asked, the Bot API\'s copy otherwise', async () => {
    // The Bot API's copy lags: it still has [a]; the server has [a, b] in another order.
    const readFresh = async () => ({ documents: [{ id: 222 }, { id: 111 }] })
    const telegram = fakeTelegram()
    const real = telegram.callApi.bind(telegram)
    telegram.callApi = async (method, params) => {
      const set = await real(method, params)
      if (method === 'getStickerSet') set.stickers = [{ file_unique_id: uniqueIdOf(111), file_id: 'f' }]
      return set
    }
    const commit = await run(removeCommit(), telegram, { readFresh })
    assert.deepStrictEqual(commit.removedOrder, [uniqueIdOf(222), uniqueIdOf(111)])

    const unrelated = await run(removeCommit(), fakeTelegram(), { readFresh })
    assert.deepStrictEqual(unrelated.removedOrder, ['a'], 'shares nothing with the copy: not trusted')
    const failing = await run(removeCommit(), fakeTelegram(), { readFresh: async () => { throw networkError() } })
    assert.deepStrictEqual(failing.removedOrder, ['a'])
  })

  await test('a set Telegram already lost counts as deleted', async () => {
    const commit = await run(removeCommit(), fakeTelegram({ exists: false }))
    assert.strictEqual(commit.status, 'succeeded')
    assert.strictEqual(commit.removedOrder, undefined, 'a pack that was already gone is not restorable')
    assert.strictEqual(commit.steps[0].alreadyGone, true)
  })

  await test('a set deleted in a Telegram app while getStickerSet still shows it: a fresh read settles it', async () => {
    const telegram = fakeTelegram({ exists: false, stale: true })
    const stuck = await run(removeCommit(), telegram)
    assert.strictEqual(stuck.status, 'failed', 'without a fresh read the old copy wins')
    const readFresh = async () => { throw invalid() }
    const commit = await run(removeCommit(), telegram, { readFresh })
    assert.strictEqual(commit.status, 'succeeded')
    assert.strictEqual(commit.removedOrder, undefined, 'the stale read\'s order is dropped: Telegram had removed it')
  })

  await test('STICKERSET_INVALID for a set that is still there fails the commit', async () => {
    const telegram = fakeTelegram({ ours: false })
    const commit = await run(removeCommit(), telegram)
    assert.strictEqual(commit.status, 'failed')
    assert.match(commit.error, /STICKERSET_INVALID/)
    assert.strictEqual(telegram.exists, true)
  })

  await test('without `remove` (as a worker that predates it reads one) nothing is deleted', async () => {
    // An empty base and draft: whatever the pack holds came after the draft
    // and is kept.
    const telegram = fakeTelegram()
    const { remove: _ignored, ...old } = removeCommit()
    await run(old, telegram)
    assert.strictEqual(telegram.exists, true)
    assert.ok(!telegram.calls.includes('deleteStickerSet'))
  })

  await test('the worker marks a removed pack deleted instead of syncing stickers', async () => {
    const writes = []
    const commit = { ...removeCommit(), stickerSet: 'p1', status: 'succeeded', removedOrder: ['ph', 'u1', 'u2'] }
    const pack = { _id: 'p1', owner: 'u1', editors: [{ telegramId: 7 }], packType: 'regular', placeholderFileUniqueId: 'ph' }
    const worker = createWorker({
      repo: {
        findPack: async () => pack,
        writeRemoved: async (doc, _now, opts) => { writes.push(['removed', doc._id, opts.order]) },
        writeSync: async () => { writes.push(['sync']) },
        markSynced: async (id) => { writes.push(['synced', id]) }
      },
      store: { save: async () => {} },
      telegram: { callApi: async (method) => { throw new Error(`unexpected ${method}`) } },
      publish: async () => commit
    })
    await worker.sync(commit)
    assert.deepStrictEqual(writes, [['removed', 'p1', ['u1', 'u2']], ['synced', 'c1']], 'restorable, order without the placeholder')

    writes.length = 0
    await worker.sync({ ...commit, removedOrder: undefined })
    assert.deepStrictEqual(writes, [['removed', 'p1', undefined], ['synced', 'c1']], 'already gone: no order')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
