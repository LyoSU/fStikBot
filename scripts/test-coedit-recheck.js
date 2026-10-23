// Unit tests for coedit.canStillAdd: the fresh access check the convert
// worker runs before adding a co-editor's sticker that waited in the queue.
// No network, no DB — db is a hand-rolled stub.

const assert = require('assert')
const coedit = require('../utils/coedit')

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

// db.StickerSet.findById(id).select(...).lean() → the pack as stored now.
const dbWith = (pack) => ({
  StickerSet: {
    findById: () => ({ select: () => ({ lean: async () => pack }) })
  }
})

const PACK = { _id: 'p1', owner: 'u-owner', passcode: 'abc', editors: [] }

;(async () => {
  console.log('coedit recheck test')

  await test('an editor still in the pack may add', async () => {
    const db = dbWith({ ...PACK, editors: [{ user: 'u2', telegramId: 202, role: 'editor' }] })
    assert.strictEqual(await coedit.canStillAdd(db, 'p1', 202), true)
  })

  await test('a contributor may add', async () => {
    const db = dbWith({ ...PACK, editors: [{ user: 'u2', telegramId: 202, role: 'contributor' }] })
    assert.strictEqual(await coedit.canStillAdd(db, 'p1', 202), true)
  })

  await test('a member removed while the file waited may not', async () => {
    const db = dbWith({ ...PACK, editors: [{ user: 'u3', telegramId: 303, role: 'editor' }] })
    assert.strictEqual(await coedit.canStillAdd(db, 'p1', 202), false)
  })

  await test('a deleted or missing pack refuses everyone', async () => {
    const editors = [{ user: 'u2', telegramId: 202, role: 'editor' }]
    assert.strictEqual(await coedit.canStillAdd(dbWith({ ...PACK, editors, deleted: true }), 'p1', 202), false)
    assert.strictEqual(await coedit.canStillAdd(dbWith(null), 'p1', 202), false)
  })

  await test('the public demo pack takes anyone', async () => {
    const db = dbWith({ ...PACK, passcode: 'public' })
    assert.strictEqual(await coedit.canStillAdd(db, 'p1', 999), true)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
  console.log('coedit recheck test OK')
})()
