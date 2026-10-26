// Unit tests for pack-ops/fresh.js: reading a set past the Bot API's copy,
// over a fake MTProto client, and falling back to the Bot API.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const { createFreshReader } = require('../pack-ops/fresh')

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

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
  console.log('pack-ops fresh read test OK')
})()
