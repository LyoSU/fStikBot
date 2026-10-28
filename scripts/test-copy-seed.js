// Unit tests for the copy seed built by file_id (utils/file-id-reuse.js) and
// the retry-api copy-scope overrides the placeholder upload relies on.
// No DB or Telegram connection needed.

const assert = require('assert')
const { buildSeedPlan, isFileRejectionError, canAddByFileId } = require('../utils/file-id-reuse')

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

const sticker = (extra) => ({ file_id: 'F', set_name: 'src', type: 'regular', emoji: '😀', ...extra })

test('same-type sticker is seeded by file_id, order kept', () => {
  const batch = [sticker({ file_id: 'A' }), sticker({ file_id: 'B', is_video: true }), sticker({ file_id: 'C', is_animated: true })]
  const plan = buildSeedPlan(batch, 'regular')
  assert.deepStrictEqual(plan.map((p) => p.entry), [
    { sticker: 'A', format: 'static', emoji_list: ['😀'] },
    { sticker: 'B', format: 'video', emoji_list: ['😀'] },
    { sticker: 'C', format: 'animated', emoji_list: ['😀'] }
  ])
  assert.deepStrictEqual(plan.map((p) => p.source.file_id), ['A', 'B', 'C'])
})

test('emojis array wins over the single emoji', () => {
  const [item] = buildSeedPlan([sticker({ emojis: ['🙂', '🙃'] })], 'regular')
  assert.deepStrictEqual(item.entry.emoji_list, ['🙂', '🙃'])
})

test('a sticker of another type needs a re-upload, a TGS does not', () => {
  const emoji = sticker({ type: 'custom_emoji' })
  const tgs = sticker({ type: 'custom_emoji', is_animated: true })
  const [a, b] = buildSeedPlan([emoji, tgs], 'regular')
  assert.strictEqual(a.entry, null)
  assert.strictEqual(b.entry.format, 'animated')
})

test('a sticker without set_name or file_id is not reusable', () => {
  assert.strictEqual(canAddByFileId({ type: 'regular', file_id: 'X' }, { packType: 'regular' }), false)
  assert.strictEqual(buildSeedPlan([sticker({ file_id: '' })], 'regular')[0].entry, null)
})

test('file rejection is told from name and other errors', () => {
  assert.strictEqual(isFileRejectionError({ code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' }), true)
  assert.strictEqual(isFileRejectionError({ code: 400, description: 'Bad Request: STICKER_INVALID' }), true)
  assert.strictEqual(isFileRejectionError({ code: 429, description: 'Too Many Requests: retry after 5' }), false)
  assert.strictEqual(isFileRejectionError({ code: 400, description: 'Bad Request: USER_NOT_FOUND' }), false)
  assert.strictEqual(isFileRejectionError(null), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
