// Unit tests for utils/session-balance.js on a real (unsaved) Mongoose doc:
// mirroring the balance into the session must not make save() write it.

const assert = require('assert')
const mongoose = require('mongoose')
const { syncBalance } = require('../utils/session-balance')

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

const User = mongoose.model('BalanceTestUser', new mongoose.Schema({ balance: Number, locale: String }))

// A doc as it comes from the database: nothing modified.
const loaded = (fields) => {
  const doc = User.hydrate({ _id: new mongoose.Types.ObjectId(), ...fields })
  assert.strictEqual(doc.isModified(), false)
  return doc
}

test('mirrors the balance without marking the doc dirty', () => {
  const user = loaded({ balance: 5 })
  syncBalance(user, 14)
  assert.strictEqual(user.balance, 14)
  assert.strictEqual(user.isModified('balance'), false)
  assert.strictEqual(user.isModified(), false)
})

test('other modified fields stay modified, balance is left out of the save', () => {
  const user = loaded({ balance: 5, locale: 'en' })
  user.locale = 'uk'
  syncBalance(user, 14)
  assert.deepStrictEqual(user.modifiedPaths(), ['locale'])
})

test('ignores a missing user or balance', () => {
  syncBalance(null, 3)
  const user = loaded({ balance: 5 })
  syncBalance(user, undefined)
  assert.strictEqual(user.balance, 5)
})

test('works on a plain object (sessions without a Mongoose doc)', () => {
  const user = { balance: 1 }
  syncBalance(user, 2)
  assert.strictEqual(user.balance, 2)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
