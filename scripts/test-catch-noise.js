// Unit tests for utils/expected-noise.js (used by handlers/catch.js) — which Telegram errors
// stay out of the admin log channel because they are the world, not our code.

const assert = require('assert')
const { isExpectedNoise } = require('../utils/expected-noise')

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

const tgError = (code, description, method) => {
  const err = new Error(`${code}: ${description}`)
  err.code = code
  err.description = description
  if (method) err.on = { method }
  return err
}

test('bot without post rights in a group (/ss@bot in a restricted chat) is noise', () => {
  assert.strictEqual(isExpectedNoise(tgError(400, 'Bad Request: not enough rights to send text messages to the chat')), true)
})

test('CHAT_WRITE_FORBIDDEN and kicked/left variants are noise', () => {
  assert.strictEqual(isExpectedNoise(tgError(403, 'Forbidden: CHAT_WRITE_FORBIDDEN')), true)
  assert.strictEqual(isExpectedNoise(tgError(403, 'Forbidden: bot was kicked from the supergroup chat')), true)
  assert.strictEqual(isExpectedNoise(tgError(403, 'Forbidden: bot is not a member of the supergroup chat')), true)
  assert.strictEqual(isExpectedNoise(tgError(403, 'Forbidden: bot was blocked by the user')), true)
  assert.strictEqual(isExpectedNoise(tgError(403, 'Forbidden: user is deactivated')), true)
  assert.strictEqual(isExpectedNoise(tgError(400, 'Bad Request: TOPIC_CLOSED')), true)
})

test('expired callback query is still noise', () => {
  assert.strictEqual(isExpectedNoise(tgError(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid', 'answerCallbackQuery')), true)
})

test('a real bug is NOT noise', () => {
  assert.strictEqual(isExpectedNoise(new TypeError('Cannot read properties of undefined')), false)
  assert.strictEqual(isExpectedNoise(tgError(400, 'Bad Request: MESSAGE_TOO_LONG')), false)
  assert.strictEqual(isExpectedNoise(tgError(400, 'Bad Request: STICKERSET_INVALID')), false)
})

test('no error is not noise', () => {
  assert.strictEqual(isExpectedNoise(null), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('catch-noise test OK')
