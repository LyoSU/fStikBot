// Unit test for Sticker.findLiveBySource: the duplicate check reads a pack's
// live stickers through { stickerSet, deleted } and nothing else, so the uid
// indexes only it used (file.file_unique_id, original.fileUniqueId) can go.

const assert = require('assert')
const stickersSchema = require('../database/models/sticker')

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

// What findOne(...).hint(...).lean() was called with.
function fakeModel () {
  const calls = {}
  const query = {
    hint (index) { calls.hint = index; return query },
    lean () { calls.lean = true; return query }
  }
  return { calls, model: { findOne (filter) { calls.filter = filter; return query } } }
}

const findLiveBySource = stickersSchema.statics.findLiveBySource

test('reads through the stickerSet + deleted index', () => {
  const { calls, model } = fakeModel()
  findLiveBySource.call(model, 'pack', 'uid')
  assert.deepStrictEqual(calls.hint, { stickerSet: 1, deleted: 1 })
  assert.strictEqual(calls.lean, true)
})

test('still matches the source under all three fields, live only', () => {
  const { calls, model } = fakeModel()
  findLiveBySource.call(model, 'pack', 'uid', { except: 'self' })
  assert.deepStrictEqual(calls.filter, {
    stickerSet: 'pack',
    deleted: false,
    _id: { $ne: 'self' },
    $or: [
      { fileUniqueId: 'uid' },
      { 'original.fileUniqueId': 'uid' },
      { 'file.file_unique_id': 'uid' }
    ]
  })
})

test('the hinted index is the one the schema declares', () => {
  const declared = stickersSchema.indexes().map(([key]) => JSON.stringify(key))
  assert.ok(declared.includes(JSON.stringify({ stickerSet: 1, deleted: 1 })))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
