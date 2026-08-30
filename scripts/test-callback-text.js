// Unit tests for utils/callback-text.js — clamping text for answerCallbackQuery.
// Telegram caps the alert text at 200 chars and renders no HTML; several
// locales have i18n strings over that (sticker.add.error.convert in fr is
// 294 chars) which surfaced as MESSAGE_TOO_LONG on restore_sticker.

const assert = require('assert')
const { clampCallbackText, CALLBACK_TEXT_MAX, wrapAnswerCbQuery } = require('../utils/callback-text')

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

test('limit is Telegram\'s 200', () => {
  assert.strictEqual(CALLBACK_TEXT_MAX, 200)
})

test('short plain text passes through untouched', () => {
  assert.strictEqual(clampCallbackText('Restored ✅'), 'Restored ✅')
})

test('HTML tags are stripped — alerts render no markup', () => {
  assert.strictEqual(clampCallbackText('<b>Error!</b>\nPlease <i>wait</i>'), 'Error!\nPlease wait')
})

test('HTML entities are decoded so the user does not read &lt;', () => {
  assert.strictEqual(clampCallbackText('a &lt;b&gt; &amp; c &quot;d&quot;'), 'a <b> & c "d"')
})

test('over-long text is cut to 200 chars (by code point) ending in an ellipsis', () => {
  const long = 'й'.repeat(300)
  const out = clampCallbackText(long)
  assert.strictEqual([...out].length, 200)
  assert.ok(out.endsWith('…'))
})

test('a 294-char fr string is clamped to exactly the limit', () => {
  const out = clampCallbackText('x'.repeat(294))
  assert.strictEqual(out.length, 200)
})

test('non-string input is returned as is', () => {
  assert.strictEqual(clampCallbackText(undefined), undefined)
  assert.strictEqual(clampCallbackText(null), null)
})

test('wrapAnswerCbQuery clamps the text and forwards the other args', () => {
  const calls = []
  const ctx = {
    callbackQuery: { id: '1' },
    answerCbQuery (...args) { calls.push(args); return Promise.resolve(true) }
  }
  wrapAnswerCbQuery(ctx)
  return ctx.answerCbQuery('<b>' + 'x'.repeat(250) + '</b>', true, { cache_time: 5 }).then(() => {
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0][0].length, 200)
    assert.strictEqual(calls[0][1], true)
    assert.deepStrictEqual(calls[0][2], { cache_time: 5 })
  })
})

test('wrapAnswerCbQuery is a no-op on a ctx without callbackQuery', () => {
  const ctx = { answerCbQuery: null }
  wrapAnswerCbQuery(ctx)
  assert.strictEqual(ctx.answerCbQuery, null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('callback-text test OK')
