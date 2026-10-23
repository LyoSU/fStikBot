// Runs the Studio publish worker (pack-ops/worker.js) end to end: a throwaway
// MongoDB, the real Bot API on a test bot.
//
//   docker run -d --rm --name studio-worker-mongo -p 27098:27017 mongo:7
//   node scripts/check-studio-worker-live.js [owner_user_id]
//
// Seeds a pack (with bot-side sticker docs) and a queued commit with
// studioassets that deletes one sticker, reorders, changes an emoji and adds
// two new files; runs the worker; checks the pack in Telegram and the sticker
// docs. Also checks a commit with an expired asset fails as asset_missing.
//
// Safety: MONGODB_URI from .env is never used (the production one lives
// there) — the database is local, and a non-local STUDIO_LIVE_MONGODB_URI is
// refused. BOT_TOKEN must be a TEST bot (the production bot id is refused),
// the owner defaults to config.mainAdminId and must have started the bot, the
// pack is deleted at the end (also on Ctrl+C). Not part of `npm test`.
require('dotenv').config()

const MONGO_URI = process.env.STUDIO_LIVE_MONGODB_URI || 'mongodb://127.0.0.1:27098/studio_worker_live'
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(MONGO_URI)) throw new Error(`refusing a non-local database: ${MONGO_URI}`)
process.env.MONGODB_URI = MONGO_URI // before the bot's database module reads it

const crypto = require('crypto')
const sharp = require('sharp')
const config = require('../config.json')

const TOKEN = process.env.BOT_TOKEN
const PROD_BOT_ID = parseInt(String(process.env.MAIN_BOT_TOKEN || '').split(':')[0], 10) || null
const OWNER = Number(process.argv[2] || config.mainAdminId)
const API = `https://api.telegram.org/bot${TOKEN}`
const MAX_WAIT_S = 330

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call (method, params = {}, files) {
  for (;;) {
    let body
    let headers
    if (files) {
      body = new FormData()
      for (const [k, v] of Object.entries(params)) body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
      for (const f of files) body.append(f.field, new Blob([f.buffer]), f.name)
    } else {
      body = JSON.stringify(params)
      headers = { 'content-type': 'application/json' }
    }
    const json = await (await fetch(`${API}/${method}`, { method: 'POST', headers, body })).json()
    if (json.ok) return json.result
    const wait = json.parameters?.retry_after
    if (json.error_code === 429 && wait <= MAX_WAIT_S) {
      console.log(`  … 429 on ${method}, waiting ${wait}s`)
      await sleep(wait * 1000 + 500)
      continue
    }
    throw Object.assign(new Error(`${method}: ${json.description}`), { code: json.error_code, description: json.description })
  }
}

const png = (i) => sharp({
  create: { width: 512, height: 512, channels: 4, background: { r: (i * 67) % 256, g: (i * 151) % 256, b: (i * 29) % 256, alpha: 1 } }
}).png().toBuffer()

let packName = null
async function cleanup () {
  if (!packName) return
  const name = packName
  packName = null
  await call('deleteStickerSet', { name }).catch((err) => console.log(`  cleanup failed: ${err.message}`))
}
process.on('SIGINT', () => { cleanup().finally(() => process.exit(130)) })

let failures = 0
const check = (ok, title, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}${!ok && detail ? ` — ${detail}` : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

;(async () => {
  if (!TOKEN) throw new Error('BOT_TOKEN is not set')
  const me = await call('getMe')
  if (PROD_BOT_ID && me.id === PROD_BOT_ID) throw new Error('BOT_TOKEN is the production bot — use a test bot')
  console.log(`bot @${me.username}, owner ${OWNER}, database ${MONGO_URI}`)

  const { db } = require('../database')
  await db.connection.asPromise()
  await db.connection.dropDatabase() // throwaway: a fresh slate
  const { getWorker } = require('../pack-ops/worker')
  const worker = getWorker()

  // The pack: five stickers, made directly with the Bot API.
  const fileIds = []
  for (let i = 0; i < 5; i++) {
    const file = await call('uploadStickerFile', { user_id: OWNER, sticker_format: 'static' }, [{ field: 'sticker', buffer: await png(i), name: `${i}.png` }])
    fileIds.push(file.file_id)
  }
  packName = `packops_${Date.now().toString(36)}_by_${me.username}`
  await call('createNewStickerSet', {
    user_id: OWNER,
    name: packName,
    title: 'studio worker live check',
    sticker_type: 'regular',
    stickers: fileIds.map((sticker) => ({ sticker, format: 'static', emoji_list: ['🧪'] }))
  })
  const set0 = await call('getStickerSet', { name: packName })
  const base = set0.stickers.map((s) => s.file_unique_id)
  console.log(`created ${packName} with ${base.length} stickers`)

  // The bot's side of it: user, pack (the first sticker plays the placeholder
  // that the publish deletes) and sticker docs in the old shape.
  const user = await db.User.create({ telegram_id: OWNER })
  const pack = await db.StickerSet.create({ owner: user._id, ownerTelegramId: OWNER, name: packName, title: 'studio worker live check', packType: 'regular', placeholderFileUniqueId: base[1] })
  await db.Sticker.insertMany(set0.stickers.map((s) => ({ stickerSet: pack._id, fileUniqueId: s.file_unique_id, emojis: '🧪', fileId: s.file_id, stickerType: 'sticker' })))

  // The draft: delete base[1]; keep base[0] with another emoji and keywords;
  // move base[4] to the front; two new files, one between.
  const assets = []
  for (const i of [10, 11]) {
    const data = await png(i)
    assets.push(await db.StudioAsset.create({
      telegramId: OWNER, sha256: crypto.createHash('sha256').update(data).digest('hex'), format: 'static', width: 512, height: 512, size: data.length, data
    }))
  }
  const kept = (uid, extra = {}) => ({ assetId: `k:${uid}`, fileUniqueId: uid, emojiList: ['🧪'], ...extra })
  const fresh = (asset, emojiList) => ({ assetId: `a:${asset._id}`, file: { studioAssetId: String(asset._id), format: 'static', fileId: null }, emojiList })
  const draft = [
    kept(base[4]),
    fresh(assets[0], ['😀', '😁']),
    kept(base[2]),
    kept(base[0], { emojiList: ['😎'], keywords: ['cool'] }),
    fresh(assets[1], ['🤖']),
    kept(base[3])
  ]
  const known = Object.fromEntries(base.map((uid) => [uid, { emojiList: ['🧪'] }]))
  const now = new Date()
  const queued = await db.PackCommit.create({
    name: packName,
    stickerSet: pack._id,
    ownerTelegramId: OWNER,
    actorTelegramId: OWNER,
    idempotencyKey: 'live-1',
    packType: 'regular',
    status: 'queued',
    phase: null,
    steps: [],
    mapping: null,
    error: null,
    base,
    draft,
    known,
    createdAt: now,
    updatedAt: now
  })

  // A second commit whose asset has expired.
  const lost = await db.PackCommit.create({
    name: `${packName}_none`,
    ownerTelegramId: OWNER,
    status: 'queued',
    base: [],
    known: {},
    createdAt: new Date(now.getTime() + 1),
    updatedAt: now,
    draft: [{ assetId: 'a:gone', file: { studioAssetId: String(new db.connection.base.Types.ObjectId()), format: 'static', fileId: null }, emojiList: ['🧪'] }]
  })

  for (let i = 0; i < 5; i++) {
    await worker.tick()
    const states = await db.PackCommit.find({ _id: { $in: [queued._id, lost._id] } }).lean()
    if (states.every((c) => ['succeeded', 'failed', 'conflict'].includes(c.status) && (c.status !== 'succeeded' || c.synced))) break
    await sleep(2000)
  }

  const commit = await db.PackCommit.findById(queued._id).lean()
  check(commit.status === 'succeeded', 'the commit succeeded', `${commit.status}: ${commit.error}`)
  check(commit.synced === true, 'the commit is marked synced')
  check(commit.draft.every((item) => !item.file || item.file.fileId), 'every new file got a file_id')
  const stored = await db.StudioAsset.find({ _id: { $in: assets.map((a) => a._id) } }).lean()
  check(stored.every((a) => a.fileId && a.fileOwner === OWNER), 'the assets remember their file_id and owner')

  const set = await call('getStickerSet', { name: packName })
  const want = draft.map((item) => commit.mapping[item.assetId])
  const got = set.stickers.map((s) => s.file_unique_id)
  check(same(got, want), 'the pack in Telegram matches the draft order', `want ${want.join(',')} got ${got.join(',')}`)
  check(!got.includes(base[1]), 'the deleted sticker is gone')
  check(same(set.stickers.map((s) => s.emoji), ['🧪', '😀', '🧪', '😎', '🤖', '🧪']), 'first emoji of every sticker', set.stickers.map((s) => s.emoji).join(' '))

  const docs = await db.Sticker.find({ stickerSet: pack._id }).lean()
  const doc = (uid) => docs.find((d) => d.fileUniqueId === uid)
  const live = docs.filter((d) => !d.deleted)
  check(same(live.map((d) => d.fileUniqueId).sort(), [...got].sort()), 'live sticker docs are exactly the final pack', `${live.length} live`)
  check(doc(base[1])?.deleted === true && doc(base[1]).deletedAt, 'the deleted sticker\'s doc is marked deleted')
  const withFileId = set.stickers.every((s) => doc(s.file_unique_id)?.fileId === s.file_id)
  check(withFileId, 'docs carry the file_ids from getStickerSet')
  check(same(doc(want[1])?.emojiList, ['😀', '😁']) && doc(want[1]).emojis === '😀 😁', 'new sticker doc: emojiList and emojis', JSON.stringify(doc(want[1])))
  check(same(doc(base[0])?.emojiList, ['😎']) && same(doc(base[0]).keywords, ['cool']), 'changed sticker doc: emojiList and keywords')
  check(live.filter((d) => d.fileUniqueId !== base[0]).every((d) => !('keywords' in d)), 'keywords stay absent where nobody set them')
  check(live.every((d) => d.stickerType === 'sticker' && d.deleted === false), 'stickerType and deleted are set')
  const packDoc = await db.StickerSet.findById(pack._id).lean()
  check(!('placeholderFileUniqueId' in packDoc), 'the removed placeholder is unset on the pack')
  check(packDoc.updatedAt > pack.updatedAt, 'the pack\'s updatedAt moved')

  const missing = await db.PackCommit.findById(lost._id).lean()
  check(missing.status === 'failed' && missing.error === 'asset_missing', 'an expired asset fails the commit as asset_missing', `${missing.status}: ${missing.error}`)

  await cleanup()
  await db.connection.dropDatabase()
  await db.connection.close()
  console.log(failures ? `\n${failures} check(s) failed` : '\nall live checks passed')
  process.exit(failures ? 1 : 0)
})().catch(async (err) => {
  console.error('FATAL', err.stack || err.message)
  await cleanup()
  process.exit(1)
})
