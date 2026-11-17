// Unit tests for the catalog's "Add to my pack" links (handlers/sticker-link.js):
// the /start payload grammar, picking the sticker out of the pack, what the
// user is sent, and the deep-link stats name. No network, no DB — ctx and
// telegram are hand-rolled stubs.

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const I18n = require('telegraf-i18n')
const handleStickerLink = require('../handlers/sticker-link')
const { deepLinkName } = require('../handlers/stats')

const { parsePayload, pickSticker, stickerCheck, show } = handleStickerLink

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'en'
})

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

const BOT = 'fStikBot'

// What the catalog is expected to do, written out once so the length budget
// is tested against the same rule the contract states.
const buildPayload = (name, index, fileUniqueId) => {
  const suffix = `_by_${BOT}`
  const head = name.toLowerCase().endsWith(suffix.toLowerCase())
    ? `b_${name.slice(0, -suffix.length)}`
    : `a_${name}`
  const bare = `${head}-${index}`
  const checked = fileUniqueId ? `${bare}-${stickerCheck(fileUniqueId)}` : bare
  if (checked.length <= 64) return checked
  return bare.length <= 64 ? bare : null
}

const sticker = (n) => ({ file_id: `file_${n}`, file_unique_id: `AgAD${n}xyzADr8ZRGg` })
const SET = {
  name: 'cats_by_fStikBot',
  title: 'Cats & <Dogs>',
  sticker_type: 'regular',
  stickers: [sticker(0), sticker(1), sticker(2)]
}

const makeCtx = ({ getStickerSet, chatType = 'private', payload = '', fromId = 1 } = {}) => {
  const sent = []
  return {
    sent,
    chat: { id: fromId, type: chatType },
    from: { id: fromId },
    startPayload: payload,
    options: { username: BOT },
    i18n: { t: (key, vars) => i18n.t('en', key, vars) },
    telegram: { getStickerSet: getStickerSet || (async () => SET) },
    replyWithHTML: async (text, extra) => { sent.push({ kind: 'html', text, extra }) },
    replyWithSticker: async (fileId, extra) => { sent.push({ kind: 'sticker', fileId, extra }) }
  }
}

async function main () {
  console.log('\nsticker link\n')

  await test('the a_ form carries the full name, the index and an optional check', () => {
    assert.deepStrictEqual(parsePayload('a_Cats_Pack-0', BOT), { name: 'Cats_Pack', index: 0, check: null })
    assert.deepStrictEqual(parsePayload('a_Cats_Pack-119-Ab_-9', BOT), { name: 'Cats_Pack', index: 119, check: 'Ab_-9' })
  })

  await test('the b_ form appends this bot\'s suffix', () => {
    assert.deepStrictEqual(parsePayload('b_cats-3', BOT), { name: 'cats_by_fStikBot', index: 3, check: null })
  })

  await test('anything off the grammar is not a sticker link', () => {
    for (const bad of [
      '', 'a_', 'a_cats', 'a_cats-', 'a_-1', 'a_cats-01', 'a_cats-1000', 'a_cats--1',
      'a_cats-1-abcd', 'a_cats-1-abcdef', 'a_cats-1-ab cd', 'a_ca.ts-1', 'a_ca%74s-1',
      'c_cats-1', 'A_cats-1', 's_passcode', 'a_cats-1\n', `a_${'x'.repeat(62)}-1`,
      null, undefined, 42
    ]) {
      assert.strictEqual(parsePayload(bad, BOT), null, `accepted ${JSON.stringify(bad)}`)
    }
  })

  await test('a b_ stem that would make a name over 64 characters is refused', () => {
    // 53 + "_by_fStikBot" = 65
    assert.strictEqual(parsePayload(`b_${'x'.repeat(53)}-1`, BOT), null)
    assert.ok(parsePayload(`b_${'x'.repeat(52)}-1`, BOT))
  })

  await test('every pack of this bot fits, with the check, at its longest', () => {
    const longest = `${'x'.repeat(52)}_by_${BOT}`
    assert.strictEqual(longest.length, 64)
    const payload = buildPayload(longest, 199, 'AgADBQADr8ZRGg')
    assert.strictEqual(payload.length, 64)
    assert.deepStrictEqual(parsePayload(payload, BOT), {
      name: longest, index: 199, check: stickerCheck('AgADBQADr8ZRGg')
    })
  })

  await test('a foreign name fits up to 61 - digits of the index, without the check', () => {
    // 58 always fits, whatever the index.
    assert.strictEqual(buildPayload('y'.repeat(58), 199, 'AgADBQADr8ZRGg'), `a_${'y'.repeat(58)}-199`)
    assert.strictEqual(buildPayload('y'.repeat(60), 9, 'AgADBQADr8ZRGg'), `a_${'y'.repeat(60)}-9`)
    assert.strictEqual(buildPayload('y'.repeat(59), 199, 'AgADBQADr8ZRGg'), null)
    assert.strictEqual(buildPayload('y'.repeat(62), 0, null), null)
    // With room, the check goes along.
    assert.strictEqual(buildPayload('y'.repeat(20), 5, 'AgADBQADr8ZRGg'), `a_${'y'.repeat(20)}-5-${stickerCheck('AgADBQADr8ZRGg')}`)
  })

  await test('the check is base64url(sha256(file_unique_id)), first 5 characters', () => {
    const expected = crypto.createHash('sha256').update('AgADBQADr8ZRGg').digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').slice(0, 5)
    assert.strictEqual(stickerCheck('AgADBQADr8ZRGg'), expected)
    assert.match(stickerCheck('anything'), /^[A-Za-z0-9_-]{5}$/)
  })

  await test('the sticker at the index is picked; out of range is nothing', () => {
    assert.strictEqual(pickSticker(SET.stickers, 1, null), SET.stickers[1])
    assert.strictEqual(pickSticker(SET.stickers, 3, null), null)
    assert.strictEqual(pickSticker(null, 0, null), null)
  })

  await test('a check that matches the index keeps it; a moved sticker is found by its check', () => {
    assert.strictEqual(pickSticker(SET.stickers, 2, stickerCheck(SET.stickers[2].file_unique_id)), SET.stickers[2])
    // The pack was reordered: the link's sticker now sits at 0.
    assert.strictEqual(pickSticker(SET.stickers, 2, stickerCheck(SET.stickers[0].file_unique_id)), SET.stickers[0])
    // Index out of range, sticker still there.
    assert.strictEqual(pickSticker(SET.stickers, 50, stickerCheck(SET.stickers[1].file_unique_id)), SET.stickers[1])
  })

  await test('a check that matches nothing means the sticker left the pack', () => {
    assert.strictEqual(pickSticker(SET.stickers, 0, stickerCheck('gone')), null)
  })

  await test('the user gets the sticker with the add button and a link to the pack', async () => {
    const ctx = makeCtx()
    await show(ctx, { name: SET.name, index: 1, check: null })
    assert.strictEqual(ctx.sent.length, 1)
    const [msg] = ctx.sent
    assert.strictEqual(msg.kind, 'sticker')
    assert.strictEqual(msg.fileId, 'file_1')
    const rows = msg.extra.reply_markup.inline_keyboard
    assert.strictEqual(rows[0][0].callback_data, 'add_sticker')
    assert.strictEqual(rows[0][0].text, i18n.t('en', 'sticker.link.btn_add'))
    assert.match(rows[1][0].url, /^https:\/\/t\.me\/addstickers\/cats_by_fStikBot$/)
  })

  await test('an emoji pack links to addemoji', async () => {
    const ctx = makeCtx({ getStickerSet: async () => ({ ...SET, sticker_type: 'custom_emoji' }) })
    await show(ctx, { name: SET.name, index: 0, check: null })
    assert.match(ctx.sent[0].extra.reply_markup.inline_keyboard[1][0].url, /\/addemoji\//)
  })

  await test('a pack Telegram does not know gets the not-found text', async () => {
    const ctx = makeCtx({
      getStickerSet: async () => { throw Object.assign(new Error('400: Bad Request: STICKERSET_INVALID'), { code: 400 }) }
    })
    await show(ctx, { name: 'nope', index: 0, check: null })
    assert.strictEqual(ctx.sent[0].kind, 'html')
    assert.strictEqual(ctx.sent[0].text, i18n.t('en', 'sticker.link.pack_not_found'))
  })

  await test('a Telegram failure that is not about the name is thrown to the error handler', async () => {
    const ctx = makeCtx({
      getStickerSet: async () => { throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
    })
    await assert.rejects(show(ctx, { name: SET.name, index: 0, check: null }), /ETIMEDOUT/)
    assert.strictEqual(ctx.sent.length, 0)
  })

  await test('a sticker no longer in the pack is said so, with the pack title escaped', async () => {
    const ctx = makeCtx()
    await show(ctx, { name: SET.name, index: 9, check: null })
    assert.strictEqual(ctx.sent[0].kind, 'html')
    assert.ok(ctx.sent[0].text.includes('Cats &amp; &lt;Dogs&gt;'), ctx.sent[0].text)
    assert.ok(ctx.sent[0].text.includes('href="t.me/addstickers/cats_by_fStikBot"'), ctx.sent[0].text)
  })

  await test('an invalid payload and a group chat fall back to the welcome screen', async () => {
    const fallbacks = []
    const handler = handleStickerLink((ctx) => fallbacks.push(ctx))

    const bad = makeCtx({ payload: 'a_cats' })
    await handler(bad)
    const group = makeCtx({ payload: 'b_cats-1', chatType: 'supergroup' })
    await handler(group)

    assert.strictEqual(fallbacks.length, 2)
    assert.strictEqual(bad.sent.length + group.sent.length, 0)
  })

  await test('the fourth link within ten seconds is told to slow down', async () => {
    const handler = handleStickerLink(() => assert.fail('fallback'))
    const calls = []
    for (let i = 0; i < 4; i++) {
      const ctx = makeCtx({ payload: 'b_cats-0', fromId: 777 })
      await handler(ctx)
      calls.push(ctx.sent[0])
    }
    assert.deepStrictEqual(calls.slice(0, 3).map((m) => m.kind), ['sticker', 'sticker', 'sticker'])
    assert.strictEqual(calls[3].text, i18n.t('en', 'error.rate_limit'))

    // Someone else is not affected.
    const other = makeCtx({ payload: 'b_cats-0', fromId: 778 })
    await handler(other)
    assert.strictEqual(other.sent[0].kind, 'sticker')
  })

  await test('/start routes a_ and b_ payloads to the sticker link before the payload table', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../bot/commands.js'), 'utf8')
    const route = src.indexOf('if (/^[ab]_./.test(payload)) return openStickerLink(ctx)')
    assert.ok(route > 0, 'route missing')
    assert.ok(route < src.indexOf('return (startRoutes[payload] || handleStart)(ctx)'))
    // The add button it sends is still handled.
    assert.ok(src.includes('privateMessage.action(/^add_sticker$/, handleSticker)'))
  })

  await test('deep-link stats keep the pack and drop the sticker', () => {
    assert.strictEqual(deepLinkName('b_cats-12-Ab_-9'), 'b_cats')
    assert.strictEqual(deepLinkName('a_Some_Pack-0'), 'a_Some_Pack')
    assert.strictEqual(deepLinkName('s_passcode'), 's_passcode')
    assert.strictEqual(deepLinkName('catalog'), 'catalog')
  })

  await test('every locale has the sticker link texts', () => {
    const dir = path.resolve(__dirname, '../locales')
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
      const lang = file.replace('.yaml', '')
      for (const key of ['btn_add', 'btn_pack', 'pack_not_found', 'sticker_not_found']) {
        const vars = { link: 't.me/addstickers/x', title: 'x' }
        const text = i18n.t(lang, `sticker.link.${key}`, vars)
        assert.ok(text && text !== `sticker.link.${key}`, `${lang}: sticker.link.${key} missing`)
        if (lang !== 'en') {
          assert.notStrictEqual(text, i18n.t('en', `sticker.link.${key}`, vars), `${lang}: sticker.link.${key} untranslated`)
        }
      }
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  // telegraf-ratelimit's store keeps a timer running, and requiring the
  // handler opens the (unconfigured) database handle: exit explicitly.
  process.exit(failed ? 1 : 0)
}

main()
