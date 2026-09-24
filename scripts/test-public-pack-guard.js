// Unit tests for the public demo pack guards: the shared 1-per-minute limit
// (utils/public-pack-limit.js) and the checks in deleteSticker, which must
// follow the pack being acted on, not the pack the user has selected.
// No network, no DB — ctx is a hand-rolled stub.

const assert = require('assert')
const path = require('path')
const I18n = require('telegraf-i18n')
const publicPackLimit = require('../utils/public-pack-limit')
const { deleteSticker } = require('../handlers/sticker-delete')

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'en'
})
const t = (key) => i18n.t('en', key)

let passed = 0
let failed = 0

async function test (name, fn) {
  publicPackLimit.reset()
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

const PUBLIC_PACK = { _id: 'pub', name: 'public_by_bot', title: 'Public', owner: 'someone', passcode: 'public' }
const OWN_PACK = { _id: 'own', name: 'own_by_bot', title: 'Mine', owner: 'me' }

// A ctx whose user has `selected` as the current pack and is deleting a
// sticker `fileUniqueId` that belongs to `targetPack`, which holds `stickers`.
const makeCtx = ({ selected, targetPack, fileUniqueId, stickers }) => {
  const deleted = []
  const stickerDoc = {
    fileUniqueId,
    stickerSet: targetPack,
    getFileId: () => `file_${fileUniqueId}`,
    save: async () => {}
  }
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: 'private' },
    options: { username: 'bot' },
    session: { userInfo: { id: 'me', _id: 'me', stickerSet: selected } },
    i18n: { t },
    db: {
      Sticker: { findOne: () => ({ populate: async () => stickerDoc }) },
      // coedit.track looks the pack up; nothing to log for these packs.
      StickerSet: {
        findById: () => ({ select: () => ({ lean: async () => null }) }),
        exists: async () => false
      }
    },
    tg: { getStickerSet: async () => ({ stickers: stickers.map((id) => ({ file_unique_id: id })) }) },
    deleteStickerFromSet: async (fileId) => { deleted.push(fileId) }
  }
  return { ctx, deleted }
}

;(async () => {
  await test('limit: first action passes, second within the window is refused', () => {
    assert.strictEqual(publicPackLimit.take(1), true)
    assert.strictEqual(publicPackLimit.take(1), false)
  })

  await test('limit: users are counted separately', () => {
    assert.strictEqual(publicPackLimit.take(1), true)
    assert.strictEqual(publicPackLimit.take(2), true)
  })

  await test('limit: passes again once the window is over', () => {
    const now = Date.now()
    assert.strictEqual(publicPackLimit.take(1, now), true)
    assert.strictEqual(publicPackLimit.take(1, now + publicPackLimit.WINDOW_MS - 1), false)
    assert.strictEqual(publicPackLimit.take(1, now + publicPackLimit.WINDOW_MS), true)
  })

  await test('first sticker of the public pack is kept with another pack selected', async () => {
    const { ctx, deleted } = makeCtx({
      selected: OWN_PACK, targetPack: PUBLIC_PACK, fileUniqueId: 'first', stickers: ['first', 'second']
    })
    const result = await deleteSticker(ctx, 'first')
    assert.ok(result.error, 'expected an error')
    assert.deepStrictEqual(deleted, [])
  })

  await test('public pack deletes are limited with another pack selected', async () => {
    const first = makeCtx({
      selected: OWN_PACK, targetPack: PUBLIC_PACK, fileUniqueId: 'second', stickers: ['first', 'second', 'third']
    })
    assert.ok((await deleteSticker(first.ctx, 'second')).ok)

    const second = makeCtx({
      selected: OWN_PACK, targetPack: PUBLIC_PACK, fileUniqueId: 'third', stickers: ['first', 'third']
    })
    const result = await deleteSticker(second.ctx, 'third')
    assert.strictEqual(result.error, t('ratelimit'))
    assert.deepStrictEqual(second.deleted, [])
  })

  await test('own pack deletes are not limited with the public pack selected', async () => {
    for (const id of ['a', 'b']) {
      const { ctx, deleted } = makeCtx({
        selected: PUBLIC_PACK, targetPack: OWN_PACK, fileUniqueId: id, stickers: ['a', 'b']
      })
      assert.ok((await deleteSticker(ctx, id)).ok, `delete ${id}`)
      assert.deepStrictEqual(deleted, [`file_${id}`])
    }
  })

  await test('a refused first-sticker delete does not use up the limit', async () => {
    const refused = makeCtx({
      selected: OWN_PACK, targetPack: PUBLIC_PACK, fileUniqueId: 'first', stickers: ['first', 'second']
    })
    assert.ok((await deleteSticker(refused.ctx, 'first')).error)

    const next = makeCtx({
      selected: OWN_PACK, targetPack: PUBLIC_PACK, fileUniqueId: 'second', stickers: ['first', 'second']
    })
    assert.ok((await deleteSticker(next.ctx, 'second')).ok)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
