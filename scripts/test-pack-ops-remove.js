// Unit tests for deleting a whole pack from Studio (pack-ops/execute.js
// removePack, the worker's sync of a remove commit) against an in-memory
// Telegram: faults before and after the call, a set Telegram already lost, a
// set this bot can't delete, and what a worker that predates removes does.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const { runCommit } = require('../pack-ops/execute')
const { createWorker } = require('../pack-ops/worker')

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
    assert.deepStrictEqual(telegram.calls, ['deleteStickerSet'])
    assert.deepStrictEqual(commit.steps.map((s) => [s.kind, s.state]), [['remove', 'succeeded']])
  })

  await test('a request that never reached Telegram is interrupted, then finished', async () => {
    const telegram = fakeTelegram({ faults: { 0: 'lost' } })
    let commit = await run(removeCommit(), telegram)
    assert.strictEqual(commit.status, 'interrupted')
    assert.strictEqual(telegram.exists, true)
    commit = await run(commit, telegram)
    assert.strictEqual(commit.status, 'succeeded')
    assert.strictEqual(telegram.exists, false)
  })

  await test('a lost answer is settled by the second delete and getStickerSet', async () => {
    const telegram = fakeTelegram({ faults: { 0: 'noreply' } })
    let commit = await run(removeCommit(), telegram)
    assert.strictEqual(commit.status, 'interrupted')
    assert.strictEqual(telegram.exists, false)
    commit = await run(commit, telegram)
    assert.strictEqual(commit.status, 'succeeded')
    assert.deepStrictEqual(telegram.calls, ['deleteStickerSet', 'deleteStickerSet', 'getStickerSet'])
  })

  await test('a set Telegram already lost counts as deleted', async () => {
    const commit = await run(removeCommit(), fakeTelegram({ exists: false }))
    assert.strictEqual(commit.status, 'succeeded')
  })

  await test('a set deleted in a Telegram app while getStickerSet still shows it: a fresh read settles it', async () => {
    const telegram = fakeTelegram({ exists: false, stale: true })
    const stuck = await run(removeCommit(), telegram)
    assert.strictEqual(stuck.status, 'failed', 'without a fresh read the old copy wins')
    const readFresh = async () => { throw invalid() }
    const commit = await run(removeCommit(), telegram, { readFresh })
    assert.strictEqual(commit.status, 'succeeded')
  })

  await test('STICKERSET_INVALID for a set that is still there fails the commit', async () => {
    const telegram = fakeTelegram({ ours: false })
    const commit = await run(removeCommit(), telegram)
    assert.strictEqual(commit.status, 'failed')
    assert.match(commit.error, /STICKERSET_INVALID/)
    assert.strictEqual(telegram.exists, true)
  })

  await test('a worker that predates removes stops at a conflict and deletes nothing', async () => {
    // What an older runCommit sees: no `remove`, an empty base and draft.
    const telegram = fakeTelegram()
    const { remove: _ignored, ...old } = removeCommit()
    const commit = await run(old, telegram)
    assert.strictEqual(commit.status, 'conflict')
    assert.strictEqual(telegram.exists, true)
    assert.deepStrictEqual(telegram.calls, ['getStickerSet'])
  })

  await test('the worker marks a removed pack deleted instead of syncing stickers', async () => {
    const writes = []
    const commit = { ...removeCommit(), stickerSet: 'p1', status: 'succeeded' }
    const pack = { _id: 'p1', owner: 'u1', editors: [{ telegramId: 7 }], packType: 'regular' }
    const worker = createWorker({
      repo: {
        findPack: async () => pack,
        writeRemoved: async (doc) => { writes.push(['removed', doc._id]) },
        writeSync: async () => { writes.push(['sync']) },
        markSynced: async (id) => { writes.push(['synced', id]) }
      },
      store: { save: async () => {} },
      telegram: { callApi: async (method) => { throw new Error(`unexpected ${method}`) } },
      publish: async () => commit
    })
    await worker.sync(commit)
    assert.deepStrictEqual(writes, [['removed', 'p1'], ['synced', 'c1']])
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
