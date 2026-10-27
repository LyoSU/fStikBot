// Unit tests for pack-ops/emoji.js: which sticker's emoji a refused commit
// carried, for its failure line.

const assert = require('assert')
const { emojiContext, isEmoji, codePoints } = require('../pack-ops/emoji')

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
    console.log(`        ${error.stack}`)
  }
}

const REFUSED = "Bad Request: can't parse InputSticker: expected a Unicode emoji"

test('emoji Telegram takes, with or without selectors', () => {
  for (const emoji of ['❤', '❤️', '☺', '1⃣', '1️⃣', '#️⃣', '🇺🇦', '👍🏻', '✌🏻', '👨‍👩‍👧', '©', '™', '🏳️‍🌈', '🏳‍🌈', '❤️‍🔥', '🙂‍↔️', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '👁‍🗨']) {
    assert.strictEqual(isEmoji(emoji), true, emoji)
  }
  for (const symbol of ['♡', '★', '♪', '⚘', '🀀', '1', 'a', '', '😀😀', ' 😀', '🇦🇦']) {
    assert.strictEqual(isEmoji(symbol), false, symbol)
  }
})

test('code points name the symbol and nothing else', () => {
  assert.strictEqual(codePoints('❤️'), 'U+2764 U+FE0F')
  assert.strictEqual(codePoints('♡'), 'U+2661')
  assert.strictEqual(codePoints('🫠'), 'U+1FAE0')
})

test('a refused emoji: the first sticker with one and the emoji', () => {
  const commit = {
    error: REFUSED,
    draft: [{ emojiList: ['😀'] }, { emojiList: ['🔥', '♡'] }, { emojiList: ['★'] }]
  }
  assert.deepStrictEqual(emojiContext(commit), { sticker: 1, emoji: 'U+2661' })
})

test('a sticker with no emoji at all is the one', () => {
  assert.deepStrictEqual(emojiContext({ error: REFUSED, draft: [{ emojiList: ['😀'] }, { emojiList: [] }] }), { sticker: 1, emoji: 'none' })
})

test('nothing for another failure, or when every emoji looks right', () => {
  assert.deepStrictEqual(emojiContext({ error: 'STICKERSET_INVALID', draft: [{ emojiList: ['♡'] }] }), {})
  assert.deepStrictEqual(emojiContext({ error: REFUSED, draft: [{ emojiList: ['😀'] }] }), {})
  assert.deepStrictEqual(emojiContext({ error: REFUSED }), {})
  assert.deepStrictEqual(emojiContext(null), {})
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
