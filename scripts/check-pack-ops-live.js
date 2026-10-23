// Runs pack-ops/plan.js against the real Telegram API: builds a pack, then
// publishes drafts with deletes, replaces, adds and reorders through the
// plan, and checks getStickerSet ends up exactly as planned.
//
//   node scripts/check-pack-ops-live.js [owner_user_id]
//
// Same rules as check-bot-api-contract.js: BOT_TOKEN must be a TEST bot (the
// production bot id is refused), the owner defaults to config.mainAdminId and
// must have started the bot, the pack is deleted at the end (also on Ctrl+C).
// Not part of `npm test`.
require('dotenv').config()
const sharp = require('sharp')
const config = require('../config.json')
const { hasConflict, planContent, mapAfterContent, planMoves } = require('../pack-ops/plan')

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
    throw new Error(`${method}: ${json.description}`)
  }
}

const png = (i) => sharp({
  create: { width: 512, height: 512, channels: 4, background: { r: (i * 67) % 256, g: (i * 151) % 256, b: (i * 29) % 256, alpha: 1 } }
}).png().toBuffer()

// Upload once, then everything goes by file_id: no extra upload quota.
async function uploadPng (i) {
  const file = await call('uploadStickerFile', { user_id: OWNER, sticker_format: 'static' }, [{ field: 'sticker', buffer: await png(i), name: `${i}.png` }])
  return file.file_id
}

const input = (fileId) => ({ sticker: fileId, format: 'static', emoji_list: ['🧪'] })

const getSet = (name) => call('getStickerSet', { name })
const uids = async (name) => (await getSet(name)).stickers.map((s) => s.file_unique_id)

// Executes a draft the way the pack-ops executor will, minus persistence.
async function publish (name, base, draft) {
  const before = await uids(name)
  if (hasConflict(base, before)) throw new Error('pack changed since the draft was opened')

  const content = planContent(draft, before)
  let set = await getSet(name)
  const fileIdOf = (uid) => set.stickers.find((s) => s.file_unique_id === uid).file_id

  for (const uid of content.deletes) await call('deleteStickerFromSet', { sticker: fileIdOf(uid) })
  for (const item of content.replaces) {
    await call('replaceStickerInSet', { user_id: OWNER, name, old_sticker: fileIdOf(item.fileUniqueId), sticker: input(item.file.fileId) })
  }
  for (const item of content.adds) await call('addStickerToSet', { user_id: OWNER, name, sticker: input(item.file.fileId) })

  set = await getSet(name)
  const after = set.stickers.map((s) => s.file_unique_id)
  const mapped = mapAfterContent(draft, before, content, after)
  if (mapped.error) throw new Error(`mapping: ${mapped.error}`)

  const target = draft.map((item) => mapped.ok.get(item.assetId))
  const moves = planMoves(after, target)
  for (const move of moves) await call('setStickerPositionInSet', { sticker: fileIdOf(move.fileUniqueId), position: move.position })

  const final = await uids(name)
  return { ok: final.length === target.length && final.every((id, i) => id === target[i]), content, moves, final, target }
}

function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

let packName = null
async function cleanup () {
  if (!packName) return
  const name = packName
  packName = null
  await call('deleteStickerSet', { name }).catch((err) => console.log(`  cleanup failed: ${err.message}`))
}
process.on('SIGINT', () => { cleanup().finally(() => process.exit(130)) })

;(async () => {
  if (!TOKEN) throw new Error('BOT_TOKEN is not set')
  const me = await call('getMe')
  if (PROD_BOT_ID && me.id === PROD_BOT_ID) throw new Error('BOT_TOKEN is the production bot — use a test bot')
  console.log(`bot @${me.username}, owner ${OWNER}`)

  const files = []
  for (let i = 0; i < 16; i++) files.push(await uploadPng(i))
  console.log(`uploaded ${files.length} files`)

  packName = `packops_${Date.now().toString(36)}_by_${me.username}`
  await call('createNewStickerSet', { user_id: OWNER, name: packName, title: 'pack-ops live check', sticker_type: 'regular', stickers: files.slice(0, 10).map(input) })
  let base = await uids(packName)
  console.log(`created ${packName} with ${base.length} stickers`)

  let failures = 0
  const report = (title, result) => {
    if (!result.ok) failures++
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${title} — ${result.content.deletes.length} del, ${result.content.replaces.length} repl, ${result.content.adds.length} add, ${result.moves.length} moves`)
    if (!result.ok) console.log(`        expected ${result.target.join(',')}\n        got      ${result.final.join(',')}`)
  }

  // 1. Delete two, replace two, add two, and shuffle.
  const rand = rng(1)
  const keep = (uid) => ({ assetId: `a-${uid}`, fileUniqueId: uid, emojiList: ['🧪'] })
  const draft = base.filter((_, i) => i !== 2 && i !== 7).map((uid, i) =>
    i === 0 || i === 5 ? { ...keep(uid), file: { fileId: files[10 + (i ? 1 : 0)] } } : keep(uid))
  draft.push({ assetId: 'new-a', file: { fileId: files[12] }, emojiList: ['🧪'] })
  draft.splice(3, 0, { assetId: 'new-b', file: { fileId: files[13] }, emojiList: ['🧪'] })
  for (let i = draft.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[draft[i], draft[j]] = [draft[j], draft[i]]
  }
  let result = await publish(packName, base, draft)
  report('mixed draft: deletes, replaces, adds, shuffle', result)
  base = result.final

  // 2. Pure reorders: the last to the front (1 call), then a random shuffle.
  result = await publish(packName, base, [base[base.length - 1], ...base.slice(0, -1)].map(keep))
  report('last to the front', result)
  if (result.moves.length !== 1) { failures++; console.log('FAIL  last to the front should take exactly 1 move') }
  base = result.final

  const shuffled = [...base]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  result = await publish(packName, base, shuffled.map(keep))
  report('random shuffle', result)
  base = result.final

  // 3. A stale draft must be refused, not applied.
  await call('addStickerToSet', { user_id: OWNER, name: packName, sticker: input(files[14]) })
  const stale = await publish(packName, base, base.map(keep)).then(() => null, (err) => err.message)
  const refused = stale === 'pack changed since the draft was opened'
  if (!refused) failures++
  console.log(`${refused ? 'PASS' : 'FAIL'}  a sticker added outside the draft stops the publish${refused ? '' : ` (${stale})`}`)
  base = await uids(packName)

  // 4. Delete everything: the pack stays, empty.
  result = await publish(packName, base, [])
  report('delete every sticker', result)

  await cleanup()
  console.log(failures ? `\n${failures} check(s) failed` : '\nall live checks passed')
  process.exit(failures ? 1 : 0)
})().catch(async (err) => {
  console.error('FATAL', err.message)
  await cleanup()
  process.exit(1)
})
