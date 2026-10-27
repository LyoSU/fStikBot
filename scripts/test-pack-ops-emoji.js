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
  assert.strictEqual(isEmoji('\u{1FC00}'), true, 'a pictograph newer than ICU')
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

test('only stickers whose emoji went to Telegram are looked at', () => {
  const file = { assetId: 'a1' }
  const commit = {
    error: REFUSED,
    known: { kept: { emojiList: ['♡'] }, edited: { emojiList: ['😀'] } },
    draft: [
      // Kept with the emoji it has in the pack: nothing sent for it.
      { assetId: 'k', fileUniqueId: 'kept', emojiList: ['♡'] },
      // Kept, emoji changed: setStickerEmojiList.
      { assetId: 'e', fileUniqueId: 'edited', emojiList: ['★'] }
    ]
  }
  assert.deepStrictEqual(emojiContext(commit), { sticker: 1, emoji: 'U+2605' })

  // A new or replaced sticker carries its emoji in the InputSticker.
  const added = { error: REFUSED, known: commit.known, draft: [commit.draft[0], { assetId: 'n', file, emojiList: ['♪'] }] }
  assert.deepStrictEqual(emojiContext(added), { sticker: 1, emoji: 'U+266A' })
  const replaced = { error: REFUSED, known: commit.known, draft: [{ ...commit.draft[0], file }] }
  assert.deepStrictEqual(emojiContext(replaced), { sticker: 0, emoji: 'U+2661' })

  // Nothing sent looks wrong.
  assert.deepStrictEqual(emojiContext({ error: REFUSED, known: commit.known, draft: [commit.draft[0]] }), {})
})

test('a draft carried over outside changes: its outside stickers are skipped, positions are the draft\'s', () => {
  const draft = [{ assetId: 'a', file: {}, emojiList: ['😀'] }, { assetId: 'b', file: {}, emojiList: ['♡'] }]
  const commit = {
    error: REFUSED,
    draft,
    // Added in Telegram meanwhile: no emoji of ours, and none sent.
    rebased: [{ assetId: 'o:x', fileUniqueId: 'x' }, draft[0], { assetId: 'o:y', fileUniqueId: 'y', emojiList: [] }, draft[1]]
  }
  assert.deepStrictEqual(emojiContext(commit), { sticker: 1, emoji: 'U+2661' })
})

test('nothing for another failure, or when every emoji looks right', () => {
  assert.deepStrictEqual(emojiContext({ error: 'STICKERSET_INVALID', draft: [{ emojiList: ['♡'] }] }), {})
  assert.deepStrictEqual(emojiContext({ error: REFUSED, draft: [{ emojiList: ['😀'] }] }), {})
  assert.deepStrictEqual(emojiContext({ error: REFUSED }), {})
  assert.deepStrictEqual(emojiContext(null), {})
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
