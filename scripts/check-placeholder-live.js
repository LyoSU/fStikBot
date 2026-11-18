// Runs utils/placeholder-sweeper.js against the real Telegram API: creates a
// pack the way /new does (one placeholder), adds a sticker straight through
// the Bot API — as a Telegram app would, with the bot's add path never
// involved — and checks that one sweep removes the placeholder and nothing else.
// A second pack holding only the placeholder must be left untouched.
//
//   node scripts/check-placeholder-live.js [owner_user_id]
//
// BOT_TOKEN must be a TEST bot (the production bot id is refused); the owner
// defaults to config.mainAdminId and must have started the bot. Both packs are
// deleted at the end. Not part of `npm test`.
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const config = require('../config.json')

const TOKEN = process.env.BOT_TOKEN
const PROD_BOT_ID = parseInt(String(process.env.MAIN_BOT_TOKEN || '').split(':')[0], 10) || null
const OWNER = Number(process.argv[2] || config.mainAdminId)

const telegram = require('../utils/telegram')
const { createPlaceholderSweeper } = require('../utils/placeholder-sweeper')

const png = () => sharp({
  create: { width: 512, height: 512, channels: 4, background: { r: 30, g: 160, b: 90, alpha: 1 } }
}).png().toBuffer()

const created = []

async function createWithPlaceholder (suffix, username) {
  const name = `phlive_${suffix}_${Date.now().toString(36)}_by_${username}`
  const placeholder = await telegram.callApi('uploadStickerFile', {
    user_id: OWNER,
    sticker_format: 'video',
    sticker: { source: fs.readFileSync(path.join(__dirname, '..', 'sticker_placeholder.webm')) }
  })
  await telegram.callApi('createNewStickerSet', {
    user_id: OWNER,
    name,
    title: 'placeholder live check',
    sticker_type: 'regular',
    stickers: [{ sticker: placeholder.file_id, format: 'video', emoji_list: ['🌟'] }]
  })
  created.push(name)
  const set = await telegram.getStickerSet(name)
  return { name, placeholderUid: set.stickers[0].file_unique_id }
}

// The sweeper's view of a pack: a doc with save(), like a Mongoose document.
const packDoc = ({ name, placeholderUid }) => {
  const doc = { _id: name, name, placeholderFileUniqueId: placeholderUid, placeholderCheckAt: new Date(0), placeholderChecks: 0, saves: 0 }
  doc.save = async () => { doc.saves++ }
  return doc
}

const memoryRepo = (packs) => ({
  rescheduled: [],
  due: async () => packs,
  async reschedule (pack, at, checks) { this.rescheduled.push({ name: pack.name, at, checks }) },
  clear: async () => {}
})

const check = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) process.exitCode = 1
}

async function cleanup () {
  for (const name of created.splice(0)) {
    await telegram.callApi('deleteStickerSet', { name }).catch((err) => console.log(`  could not delete ${name}: ${err.description || err.message}`))
  }
}

async function main () {
  if (!TOKEN) throw new Error('BOT_TOKEN is not set')
  const me = await telegram.getMe()
  if (PROD_BOT_ID && me.id === PROD_BOT_ID) throw new Error('BOT_TOKEN is the production bot — use a test bot')
  console.log(`bot @${me.username}, owner ${OWNER}`)

  const filled = await createWithPlaceholder('filled', me.username)
  const empty = await createWithPlaceholder('empty', me.username)

  // "Added from a Telegram app": straight through the API, no bot add path.
  const file = await telegram.callApi('uploadStickerFile', { user_id: OWNER, sticker_format: 'static', sticker: { source: await png() } })
  await telegram.callApi('addStickerToSet', { user_id: OWNER, name: filled.name, sticker: { sticker: file.file_id, format: 'static', emoji_list: ['🟢'] } })

  const filledDoc = packDoc(filled)
  const emptyDoc = packDoc(empty)
  const repo = memoryRepo([filledDoc, emptyDoc])
  const sweeper = createPlaceholderSweeper({ repo, telegram, gapMs: 300, log: console })
  const outcome = await sweeper.tick()
  console.log('  sweep:', JSON.stringify(outcome))

  const after = await telegram.getStickerSet(filled.name)
  check(after.stickers.length === 1, 'filled pack: one sticker left')
  check(!after.stickers.some((s) => s.file_unique_id === filled.placeholderUid), 'filled pack: the placeholder is gone')
  check(filledDoc.placeholderFileUniqueId === undefined && filledDoc.saves === 1, 'filled pack: marker cleared')

  const emptyAfter = await telegram.getStickerSet(empty.name)
  check(emptyAfter.stickers.length === 1 && emptyAfter.stickers[0].file_unique_id === empty.placeholderUid, 'placeholder-only pack: untouched')
  check(repo.rescheduled.some((r) => r.name === empty.name && r.checks === 1 && r.at), 'placeholder-only pack: next look scheduled')
}

process.on('SIGINT', () => { cleanup().finally(() => process.exit(130)) })

main()
  .catch((err) => {
    console.error(err.description || err.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await cleanup()
    process.exit()
  })
