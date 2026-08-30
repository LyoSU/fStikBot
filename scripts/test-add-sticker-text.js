// Unit tests for utils/add-sticker-text.js — the user-facing text built from
// an addSticker result. No network, no DB; locales are read from disk.

const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const addStickerText = require('../utils/add-sticker-text')

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'en',
  allowMissing: false
})

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

const okResult = (extra = {}) => ({
  ok: { title: 'My pack', link: 't.me/addstickers/my_pack', ...extra }
})

test('plain success has no monochrome notice', () => {
  const { messageText } = addStickerText(okResult(), 'en')
  assert.ok(messageText.includes('My pack'))
  assert.ok(!messageText.includes(i18n.t('en', 'sticker.add.ok_repainting_notice')))
})

test('success with repainting=true appends the monochrome notice', () => {
  const notice = i18n.t('en', 'sticker.add.ok_repainting_notice')
  assert.notStrictEqual(notice, 'sticker.add.ok_repainting_notice', 'key must exist in en.yaml')
  const { messageText } = addStickerText(okResult({ repainting: true }), 'en')
  assert.ok(messageText.includes(notice), `expected notice in:\n${messageText}`)
})

test('the notice exists in uk and ru too', () => {
  for (const lang of ['uk', 'ru']) {
    const notice = i18n.t(lang, 'sticker.add.ok_repainting_notice')
    assert.notStrictEqual(notice, 'sticker.add.ok_repainting_notice', `missing in ${lang}`)
    const { messageText } = addStickerText(okResult({ repainting: true }), lang)
    assert.ok(messageText.includes(notice), `notice missing for ${lang}`)
  }
})

test('animated_too_big i18n error renders a real message, not the key', () => {
  const { messageText } = addStickerText({ error: { i18nKey: 'sticker.add.error.animated_too_big' } }, 'en')
  assert.notStrictEqual(messageText, 'sticker.add.error.animated_too_big')
  assert.ok(messageText.length > 10)
})

test('429 from addStickerToSet renders "wait N seconds", not the raw Telegram dump', () => {
  const err = new Error('429: Too Many Requests: retry after 10')
  err.code = 429
  err.description = 'Too Many Requests: retry after 10'
  err.parameters = { retry_after: 10 }
  const { messageText } = addStickerText({ error: { telegram: err } }, 'en')
  const expected = i18n.t('en', 'error.rate_limit_seconds', { seconds: 10 })
  assert.strictEqual(messageText, expected)
  assert.ok(!messageText.includes('Too Many Requests'))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('add-sticker-text test OK')
