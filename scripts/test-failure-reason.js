// Unit tests for utils/failure-reason.js — bounded failure names for metrics.

const assert = require('assert')
const { failureReason } = require('../utils/failure-reason')

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

test('known Telegram description maps to its reason', () => {
  assert.strictEqual(failureReason({ error: { telegram: { code: 400, description: 'Bad Request: STICKERS_TOO_MUCH' } } }), 'pack_full')
})

test('429 is rate_limited', () => {
  assert.strictEqual(failureReason({ error: { telegram: { code: 429, description: 'Too Many Requests: retry after 5' } } }), 'rate_limited')
})

test('unknown Telegram description falls back to the code', () => {
  assert.strictEqual(failureReason({ error: { telegram: { code: 400, description: 'Bad Request: something new' } } }), 'telegram_400')
})

test('Telegram error without a code', () => {
  assert.strictEqual(failureReason({ error: { telegram: { message: 'socket hang up' } } }), 'telegram_other')
})

test('i18n key keeps only its last segment', () => {
  assert.strictEqual(failureReason({ error: { i18nKey: 'sticker.add.error.too_big' } }), 'too_big')
  assert.strictEqual(failureReason({ error: { i18nKey: 'error.unknown' } }), 'unknown')
})

test('no error details', () => {
  assert.strictEqual(failureReason({ error: {} }), 'other')
  assert.strictEqual(failureReason(undefined), 'other')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
