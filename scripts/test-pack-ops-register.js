// Unit tests for mongoRegister (pack-ops/store.js) on a restore commit,
// against a small in-memory database.

const assert = require('assert')
const { mongoRegister } = require('../pack-ops/store')

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
    console.log(`        ${error.stack}`)
  }
}

const chain = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value })

function fakeDb ({ old, extra = [] }) {
  const sets = [old, ...extra]
  const stickers = [
    { stickerSet: 'old1', fileUniqueId: 'a', deleted: true },
    { stickerSet: 'old1', fileUniqueId: 'b', deleted: true },
    { stickerSet: 'old1', fileUniqueId: 'c', deleted: true, restoredAt: new Date() },
    { stickerSet: 'old1', fileUniqueId: 'single', deleted: true } // deleted on its own, before the pack
  ]
  const db = {
    sets,
    stickers,
    User: {
      findOne: () => chain({ _id: 'user1' }),
      updateOne: async () => {}
    },
    StickerSet: {
      findOne: ({ name, deleted }) => chain(sets.find((s) => s.name === name && !(deleted && s.deleted)) || null),
      findById: (id) => chain(sets.find((s) => s._id === id) || null),
      // As database/index.js: a document of the same name goes away.
      async newSet (info) {
        const at = sets.findIndex((s) => s.name === info.name)
        if (at >= 0) sets.splice(at, 1)
        const doc = { _id: 'new1', ...info }
        sets.push(doc)
        return doc
      },
      async updateOne ({ _id }, { $set }) {
        const doc = sets.find((s) => s._id === _id)
        if (!doc) return
        for (const [key, value] of Object.entries($set)) {
          if (key === 'about.safe') doc.about = { ...doc.about, safe: value }
          else doc[key] = value
        }
      }
    },
    Sticker: {
      async updateMany (filter, { $set }) {
        for (const s of stickers) {
          if (s.stickerSet !== filter.stickerSet || !filter.fileUniqueId.$in.includes(s.fileUniqueId)) continue
          if (filter.deleted && !s.deleted) continue
          if (filter.restoredAt && 'restoredAt' in s) continue
          Object.assign(s, $set)
        }
      }
    }
  }
  return db
}

const commit = (name, draft) => ({
  name,
  ownerTelegramId: 1,
  packType: 'regular',
  boost: true,
  draft,
  create: { formattedTitle: 'Old :: @bot', restoreFrom: 'old1', copyBoost: true }
})
const draft = [
  { assetId: 'r:a', restoredUid: 'a', fileUniqueId: 'a2' },
  { assetId: 'r:b', file: { restore: { fileUniqueId: 'b' } } },
  { assetId: 'r:c', file: { restore: { fileUniqueId: 'c' } } }
]

;(async () => {
  await test('a restore under another name moves the archived rows of its draft, marks the old pack and carries moderation', async () => {
    const old = { _id: 'old1', name: 'old_by_bot', deleted: true, moderated: true, aiModeration: { checked: true, isFlagged: true }, about: { safe: true } }
    const db = fakeDb({ old })
    const id = await mongoRegister(db)(commit('new_by_bot', draft))
    assert.strictEqual(id, 'new1')
    assert.ok(old.restoredAt instanceof Date)
    assert.strictEqual(old.restoredTo, 'new1')
    const where = (uid) => db.stickers.find((s) => s.fileUniqueId === uid).stickerSet
    assert.deepStrictEqual(['a', 'b'].map(where), ['new1', 'new1'])
    assert.strictEqual(where('c'), 'old1', 'already restored: stays')
    assert.strictEqual(where('single'), 'old1', 'not in the draft: stays')
    const made = db.sets.find((s) => s._id === 'new1')
    assert.strictEqual(made.moderated, true)
    assert.strictEqual(made.aiModeration.isFlagged, true)
    assert.strictEqual(made.about.safe, true)
  })

  await test('a restore under the old name replaces the deleted document (no reuse of it), and still moves the rows', async () => {
    const old = { _id: 'old1', name: 'old_by_bot', deleted: true, moderated: true }
    const db = fakeDb({ old })
    const id = await mongoRegister(db)(commit('old_by_bot', draft))
    assert.strictEqual(id, 'new1')
    assert.deepStrictEqual(db.sets.map((s) => s._id), ['new1'])
    assert.strictEqual(db.sets[0].moderated, true)
    assert.strictEqual(db.stickers.find((s) => s.fileUniqueId === 'a').stickerSet, 'new1')
  })

  await test('nothing is carried from a clean old pack', async () => {
    const old = { _id: 'old1', name: 'old_by_bot', deleted: true }
    const db = fakeDb({ old })
    await mongoRegister(db)(commit('new_by_bot', draft))
    const made = db.sets.find((s) => s._id === 'new1')
    assert.ok(!('moderated' in made) && !('aiModeration' in made) && !('about' in made))
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
