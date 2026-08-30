// Unit tests for handlers/sticker-update.js — changing a sticker's emoji by
// sending emoji as text. Runs the handler against a fake ctx; no DB, no Telegram.

const assert = require('assert')
const handler = require('../handlers/sticker-update')

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

const fakeSticker = (id, fileId, extra = {}) => {
  const s = {
    _id: id,
    id,
    fileUniqueId: `u_${id}`,
    deleted: false,
    emojis: '',
    saved: 0,
    getFileId () { return fileId },
    async save () { this.saved++ },
    ...extra
  }
  return s
}

const makeCtx = ({ previousSticker, byId, setStickers, fromDb, callApi }) => {
  const ctx = {
    message: { text: '😀', message_id: 1 },
    session: {
      previousSticker,
      userInfo: { stickerSet: { name: 'set_by_bot', inline: false } }
    },
    db: {
      Sticker: {
        async findById () { return byId },
        async findOne () { return fromDb }
      }
    },
    tg: {
      async getStickerSet () { return { stickers: setStickers } },
      callApi
    },
    i18n: { t: (k) => k },
    replies: [],
    async replyWithHTML (text) { this.replies.push(text) }
  }
  return ctx
}

const tgError = (description) => {
  const err = new Error(`400: ${description}`)
  err.code = 400
  err.description = description
  return err
}

;(async () => {
  await test('previousSticker that is already deleted is skipped; last sticker in the set is used instead', async () => {
    const deletedOne = fakeSticker('old', 'file_old', { deleted: true })
    const lastInSet = fakeSticker('last', 'file_last')
    const calls = []
    const ctx = makeCtx({
      previousSticker: { id: 'old' },
      byId: deletedOne,
      setStickers: [{ file_unique_id: 'u_last' }],
      fromDb: lastInSet,
      callApi: async (method, data) => { calls.push({ method, data }); return true }
    })

    await handler(ctx, async () => { throw new Error('next() must not be called') })

    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].method, 'setStickerEmojiList')
    assert.strictEqual(calls[0].data.sticker, 'file_last', 'must target the live sticker, not the deleted one')
    assert.strictEqual(ctx.session.previousSticker, null)
    assert.deepStrictEqual(ctx.replies, ['cmd.emoji.done'])
    assert.strictEqual(lastInSet.emojis, '😀')
  })

  await test('STICKER_ALREADY_DELETED from Telegram marks our row deleted and reports the error once', async () => {
    const ghost = fakeSticker('ghost', 'file_ghost')
    const ctx = makeCtx({
      previousSticker: { id: 'ghost' },
      byId: ghost,
      setStickers: [],
      fromDb: null,
      callApi: async () => { throw tgError('Bad Request: STICKER_ALREADY_DELETED') }
    })
    const origError = console.error
    console.error = () => {}
    try {
      await handler(ctx, async () => {})
    } finally {
      console.error = origError
    }

    assert.strictEqual(ghost.deleted, true)
    assert.ok(ghost.deletedAt instanceof Date)
    assert.strictEqual(ghost.saved, 1)
    assert.strictEqual(ctx.session.previousSticker, null)
    assert.deepStrictEqual(ctx.replies, ['cmd.emoji.error'])
  })

  await test('happy path: live previousSticker gets the new emoji', async () => {
    const live = fakeSticker('live', 'file_live')
    const ctx = makeCtx({
      previousSticker: { id: 'live' },
      byId: live,
      setStickers: [],
      fromDb: null,
      callApi: async () => true
    })
    await handler(ctx, async () => { throw new Error('next() must not be called') })
    assert.strictEqual(live.emojis, '😀')
    assert.deepStrictEqual(ctx.replies, ['cmd.emoji.done'])
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('sticker-update test OK')
})()
