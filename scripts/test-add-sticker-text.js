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

test('an unconfirmed add says to check the pack, not to resend, with a pack button', () => {
  const { messageText, replyMarkup } = addStickerText({ error: { type: 'unconfirmed', link: 'https://t.me/addstickers/a_by_bot' } }, 'en')
  assert.ok(/check the pack/i.test(messageText), messageText)
  assert.ok(JSON.stringify(replyMarkup).includes('https://t.me/addstickers/a_by_bot'))
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

// The user gets plain words; what Telegram said must reach the log.
const captureLogs = (fn) => {
  const lines = []
  const { warn, error } = console
  console.warn = (line) => lines.push(line)
  console.error = (line) => lines.push(line)
  try { fn() } finally { Object.assign(console, { warn, error }) }
  return lines
}

test('an unmapped Telegram error says "unknown" and logs what Telegram said', () => {
  const err = new Error('400: Bad Request: STICKER_SOMETHING_NEW')
  err.code = 400
  err.description = 'Bad Request: STICKER_SOMETHING_NEW'
  let text
  const lines = captureLogs(() => {
    text = addStickerText({ error: { telegram: err } }, 'en', { where: 'queue:convert:add', format: 'video' }).messageText
  })
  assert.strictEqual(text, i18n.t('en', 'error.unknown'))
  assert.strictEqual(lines.length, 1)
  const line = JSON.parse(lines[0])
  assert.strictEqual(line.kind, 'add_unknown')
  assert.strictEqual(line.where, 'queue:convert:add')
  assert.strictEqual(line.tgCode, 400)
  assert.ok(line.tgDescription.includes('STICKER_SOMETHING_NEW'))
  assert.strictEqual(line.format, 'video')
})

test('a mapped Telegram error logs nothing extra', () => {
  const err = new Error('400: Bad Request: STICKERSET_INVALID')
  err.code = 400
  err.description = 'Bad Request: STICKERSET_INVALID'
  const lines = captureLogs(() => addStickerText({ error: { telegram: err } }, 'en'))
  assert.strictEqual(lines.length, 0)
})

const tgError = (code, description, extra = {}) => Object.assign(new Error(`${code}: ${description}`), { code, description, ...extra })

test('a Telegram 502/504 says Telegram is having trouble, logs nothing as unknown', () => {
  for (const code of [502, 504]) {
    let text
    const lines = captureLogs(() => {
      text = addStickerText({ error: { telegram: tgError(code, 'Gateway Timeout') } }, 'ru').messageText
    })
    assert.strictEqual(text, i18n.t('ru', 'error.telegram_reasons.telegram_unavailable'))
    assert.strictEqual(lines.length, 0)
  }
})

test('a dropped connection reads the same as a 5xx', () => {
  const err = Object.assign(new Error('request to https://api.telegram.org/bot<redacted>/getFile failed'), { name: 'FetchError', type: 'system' })
  const { messageText } = addStickerText({ error: { telegram: err } }, 'en')
  assert.strictEqual(messageText, i18n.t('en', 'error.telegram_reasons.telegram_unavailable'))
})

test('a long 429 is told in minutes as Telegram\'s limit, not "wait 2453 seconds"', () => {
  const err = tgError(429, 'Too Many Requests: retry after 2453', { parameters: { retry_after: 2453 } })
  const { messageText } = addStickerText({ error: { telegram: err } }, 'uk')
  assert.strictEqual(messageText, i18n.t('uk', 'sticker.add.error.rate_limit_long', { minutes: 41 }))
  assert.ok(!messageText.includes('2453'))
})

test('the same file still on its way into the pack has its own words', () => {
  const { messageText } = addStickerText({ error: { type: 'in_progress' } }, 'en')
  assert.strictEqual(messageText, i18n.t('en', 'sticker.add.error.in_progress'))
})

test('a full pack offers a new pack and the pack list, in a private chat only', () => {
  const full = { error: { telegram: tgError(400, 'Bad Request: STICKERS_TOO_MUCH') } }
  const inPrivate = addStickerText(full, 'en', { private: true }).replyMarkup
  const callbacks = inPrivate.inline_keyboard.flat().map((b) => b.callback_data)
  assert.deepStrictEqual(callbacks, ['new_pack:null', 'packs:null'])
  assert.deepStrictEqual(addStickerText(full, 'en').replyMarkup, {})
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('add-sticker-text test OK')
