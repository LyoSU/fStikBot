// Unit tests for pack-ops/fresh.js: reading a set past the Bot API's copy,
// over a fake MTProto client, and falling back to the Bot API.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const { createFreshReader, createFreshUids, uniqueIdOf } = require('../pack-ops/fresh')

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

// gram.js-shaped constructors and errors.
const Api = {
  messages: { GetStickerSet: class { constructor (args) { Object.assign(this, args, { method: 'messages.getStickerSet' }) } } },
  InputStickerSetShortName: class { constructor (args) { Object.assign(this, args) } }
}
const rpcError = (code, errorMessage) => Object.assign(new Error(errorMessage), { code, errorMessage })
const botApi = (answer) => ({ calls: [], async callApi (method, params) { this.calls.push([method, params.name]); return answer() } })

;(async () => {
  console.log('pack-ops fresh read test')

  await test('reads the set from the server, by its short name and with no cache hash', async () => {
    const sent = []
    const client = { async invoke (request) { sent.push(request); return { set: { shortName: 'cats' }, documents: [] } } }
    const telegram = botApi(() => { throw new Error('not asked') })
    const set = await createFreshReader(telegram, async () => client, Api)('cats')
    assert.deepStrictEqual(set.set, { shortName: 'cats' })
    assert.strictEqual(sent[0].stickerset.shortName, 'cats')
    assert.strictEqual(sent[0].hash, 0)
    assert.deepStrictEqual(telegram.calls, [])
  })

  await test('a set the server does not know is a 400 in the Bot API\'s words', async () => {
    const client = { async invoke () { throw rpcError(400, 'STICKERSET_INVALID') } }
    const read = createFreshReader(botApi(() => ({})), async () => client, Api)
    await assert.rejects(read('cats'), (err) => err.code === 400 && err.description === 'Bad Request: STICKERSET_INVALID')
  })

  await test('without MTProto, or when it fails otherwise, the Bot API answers', async () => {
    const telegram = botApi(() => ({ name: 'cats', stickers: [] }))
    assert.deepStrictEqual(await createFreshReader(telegram, async () => null, Api)('cats'), { name: 'cats', stickers: [] })
    const flood = { async invoke () { throw rpcError(420, 'FLOOD_WAIT_30') } }
    await createFreshReader(telegram, async () => flood, Api)('cats')
    await createFreshReader(telegram, async () => { throw new Error('connect failed') }, Api)('cats')
    assert.strictEqual(telegram.calls.length, 3)
  })

  // Document ids and the file_unique_ids getStickerSet gave for them (test bot).
  const A = { id: '5402482204490116943', uid: 'AgADT68AAvF4-Uo' }
  const B = { id: '5402496004220037871', uid: 'AgAD76oAAn6F-Uo' }
  const fromServer = (...docs) => async () => ({ documents: docs.map((doc) => ({ id: { toString: () => doc.id } })) })

  await test('a document id gives the file_unique_id the Bot API shows', async () => {
    assert.strictEqual(uniqueIdOf(A.id), A.uid)
    assert.strictEqual(uniqueIdOf(B.id), B.uid)
  })

  await test('the fresh ids: the pack as the server has it, matched against the draft', async () => {
    assert.deepStrictEqual(await createFreshUids(fromServer(A, B))('cats', [A.uid, B.uid]), [A.uid, B.uid])
    // Some match, one is gone: a real difference, for the conflict check.
    assert.deepStrictEqual(await createFreshUids(fromServer(A))('cats', [A.uid, B.uid]), [A.uid])
    assert.deepStrictEqual(await createFreshUids(fromServer())('cats', []), [])
  })

  await test('ids that match none of the draft\'s are unknown, not a conflict', async () => {
    // The encoding changed, or the read is broken: nothing can be told.
    assert.strictEqual(await createFreshUids(fromServer({ id: '1' }, { id: '2' }))('cats', [A.uid, B.uid]), null)
    assert.strictEqual(await createFreshUids(fromServer())('cats', [A.uid]), null)
    assert.strictEqual(await createFreshUids(fromServer(A))('cats', []), null)
  })

  await test('a Bot API answer (no MTProto) is no fresh read', async () => {
    const botApiSet = async () => ({ stickers: [{ file_unique_id: A.uid }] })
    assert.strictEqual(await createFreshUids(botApiSet)('cats', [A.uid]), null)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
  console.log('pack-ops fresh read test OK')
})()
