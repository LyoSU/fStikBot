// Unit tests for banRefusal (handlers/admin/_helpers.js): who an admin may ban.

const assert = require('assert')
const { banRefusal } = require('../handlers/admin/_helpers')

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

const MAIN = 1
const ctxOf = (fromId) => ({ from: { id: fromId }, config: { mainAdminId: MAIN } })
const user = (telegramId, adminRights = []) => ({ telegram_id: telegramId, adminRights })

test('nobody can ban the main admin', () => {
  assert.ok(banRefusal(ctxOf(2), user(MAIN)))
  assert.ok(banRefusal(ctxOf(MAIN), user(MAIN)))
})

test('an admin cannot ban themselves', () => {
  assert.ok(banRefusal(ctxOf(2), user(2, ['users'])))
})

test('a sub-admin cannot ban another admin', () => {
  assert.ok(banRefusal(ctxOf(2), user(3, ['pack'])))
})

test('the main admin can ban a sub-admin', () => {
  assert.strictEqual(banRefusal(ctxOf(MAIN), user(3, ['pack'])), null)
})

test('a sub-admin can ban a regular user', () => {
  assert.strictEqual(banRefusal(ctxOf(2), user(4)), null)
  assert.strictEqual(banRefusal(ctxOf(2), { telegram_id: 4 }), null)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
