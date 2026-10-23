// Checks the sticker-related Bot API behaviour the bot (and the planned Studio
// web app) relies on, against the real Telegram API. Each check states the
// expected outcome; a mismatch means Telegram changed and code that leans on
// that behaviour needs a look.
//
//   node scripts/check-bot-api-contract.js [owner_user_id]
//
// Runs on BOT_TOKEN, which must be a TEST bot: it creates two packs and
// deletes them at the end (also on Ctrl+C). Never point it at the production
// bot — every upload eats the bot-wide upload quota real users share.
// The owner defaults to config.mainAdminId and must have started the bot.
// Not part of `npm test` (network, rate limits, minutes of runtime).
require('dotenv').config()
const zlib = require('zlib')
const sharp = require('sharp')
const config = require('../config.json')

const TOKEN = process.env.BOT_TOKEN
const PROD_BOT_ID = parseInt(String(process.env.MAIN_BOT_TOKEN || '').split(':')[0], 10) || null
const OWNER = Number(process.argv[2] || config.mainAdminId)
const API = `https://api.telegram.org/bot${TOKEN}`
const MAX_WAIT_S = 330

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// files: [{ field, buffer, name }] → multipart; otherwise JSON.
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

// Smallest TGS Telegram accepts: shapes inside a group ending with a
// transform; bare shapes on the layer are refused as "wrong file type".
const tgs = (size, fr = 60) => {
  const op = fr
  const c = size / 2
  return zlib.gzipSync(Buffer.from(JSON.stringify({
    v: '5.5.2',
    fr,
    ip: 0,
    op,
    w: size,
    h: size,
    nm: 'contract',
    ddd: 0,
    assets: [],
    layers: [{
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: 'dot',
      sr: 1,
      ip: 0,
      op,
      st: 0,
      bm: 0,
      ao: 0,
      ks: {
        o: { a: 0, k: 100 },
        a: { a: 0, k: [0, 0, 0] },
        s: { a: 0, k: [100, 100, 100] },
        p: { a: 0, k: [c, c, 0] },
        r: { a: 1, k: [{ t: 0, s: [0], i: { x: [0.667], y: [1] }, o: { x: [0.333], y: [0] } }, { t: op, s: [90] }] }
      },
      shapes: [{
        ty: 'gr',
        nm: 'g',
        it: [
          { ty: 'rc', nm: 'r', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [size * 0.6, size * 0.6] }, r: { a: 0, k: size * 0.1 } },
          { ty: 'fl', nm: 'f', c: { a: 0, k: [0.3, 0.6, 1, 1] }, o: { a: 0, k: 100 }, r: 1 },
          { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
        ]
      }]
    }]
  })))
}

const attached = (format, emoji = '🧪') => ({ sticker: 'attach://f0', format, emoji_list: [emoji] })
const file = (buffer, name) => [{ field: 'f0', buffer, name }]
const uids = async (name) => (await call('getStickerSet', { name })).stickers.map((s) => s.file_unique_id)

let failures = 0
// expect: 'ok' | 'rejected'; fn may return a boolean refinement (false → mismatch).
async function check (title, expect, fn) {
  let outcome
  let detail = ''
  try {
    const res = await fn()
    outcome = res === false ? 'mismatch' : 'ok'
    if (typeof res === 'string') detail = res
  } catch (err) {
    outcome = 'rejected'
    detail = err.message
  }
  const pass = outcome === expect
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${title} — expected ${expect}, got ${outcome}${detail ? ` (${detail})` : ''}`)
}

const created = new Set()
let cleaning = null
const cleanup = () => {
  cleaning = cleaning || (async () => {
    for (const name of created) {
      await call('deleteStickerSet', { name }).catch((err) => console.log(`cleanup failed for ${name}: ${err.message}`))
    }
  })()
  return cleaning
}
process.on('SIGINT', () => cleanup().then(() => process.exit(130)))

async function main () {
  if (!TOKEN) throw new Error('BOT_TOKEN is not set')
  if (!OWNER) throw new Error('no owner user id (argument or config.mainAdminId)')
  const me = await call('getMe')
  if (me.id === PROD_BOT_ID) throw new Error('BOT_TOKEN is the production bot — use a test bot')
  console.log(`@${me.username}, owner ${OWNER}\n`)

  const tag = Math.random().toString(36).slice(2, 7)
  const reg = `zz_contract_${tag}_r_by_${me.username}`
  const emo = `zz_contract_${tag}_e_by_${me.username}`

  // Regular pack, created without uploadStickerFile.
  await check('createNewStickerSet with an attach:// file', 'ok', async () => {
    await call('createNewStickerSet', { user_id: OWNER, name: reg, title: 'contract regular', stickers: [attached('static')] }, file(await png(0), 'a.png'))
    created.add(reg)
  })
  if (!created.has(reg)) return

  await check('replaceStickerInSet in a pack with exactly one sticker', 'ok', async () => {
    const [before] = (await call('getStickerSet', { name: reg })).stickers
    await call('replaceStickerInSet', { user_id: OWNER, name: reg, old_sticker: before.file_id, sticker: attached('static') }, file(await png(1), 'b.png'))
    const after = await uids(reg)
    return after.length === 1 && after[0] !== before.file_unique_id
  })

  await check('deleting the last sticker leaves an empty, still usable pack', 'ok', async () => {
    const [only] = (await call('getStickerSet', { name: reg })).stickers
    await call('deleteStickerFromSet', { sticker: only.file_id })
    const empty = (await uids(reg)).length === 0
    await call('addStickerToSet', { user_id: OWNER, name: reg, sticker: attached('static') }, file(await png(1), 'b.png'))
    return empty && (await uids(reg)).length === 1
  })

  for (let i = 2; i <= 6; i++) await call('addStickerToSet', { user_id: OWNER, name: reg, sticker: attached('static') }, file(await png(i), `${i}.png`))
  await check('added stickers land at the end in add order', 'ok', async () => (await uids(reg)).length === 6)

  await check('setStickerPositionInSet = remove, then insert at index (backward)', 'ok', async () => {
    const before = await uids(reg)
    const set = await call('getStickerSet', { name: reg })
    await call('setStickerPositionInSet', { sticker: set.stickers[5].file_id, position: 0 })
    return JSON.stringify(await uids(reg)) === JSON.stringify([before[5], ...before.slice(0, 5)])
  })
  await check('setStickerPositionInSet = remove, then insert at index (forward)', 'ok', async () => {
    const before = await uids(reg)
    const set = await call('getStickerSet', { name: reg })
    await call('setStickerPositionInSet', { sticker: set.stickers[1].file_id, position: 4 })
    const rest = before.filter((_, i) => i !== 1)
    return JSON.stringify(await uids(reg)) === JSON.stringify([...rest.slice(0, 4), before[1], ...rest.slice(4)])
  })

  await check('re-adding a deleted sticker by file_id gives a NEW file_unique_id', 'ok', async () => {
    const set = await call('getStickerSet', { name: reg })
    const victim = set.stickers[set.stickers.length - 1]
    await call('deleteStickerFromSet', { sticker: victim.file_id })
    await call('addStickerToSet', { user_id: OWNER, name: reg, sticker: { sticker: victim.file_id, format: 'static', emoji_list: ['↩️'] } })
    const after = await uids(reg)
    return after.length === 6 && after[5] !== victim.file_unique_id
  })

  await check('TGS 512×512 at 30 fps in a regular pack', 'ok', async () => {
    await call('addStickerToSet', { user_id: OWNER, name: reg, sticker: attached('animated') }, file(tgs(512, 30), 'r30.tgs'))
  })
  await check('TGS on a 100×100 canvas in a regular pack', 'rejected', async () => {
    await call('addStickerToSet', { user_id: OWNER, name: reg, sticker: attached('animated') }, file(tgs(100), 'r100.tgs'))
  })

  const kwTarget = (await call('getStickerSet', { name: reg })).stickers[1].file_id
  await check('setStickerKeywords: 64 characters in total', 'ok', () =>
    call('setStickerKeywords', { sticker: kwTarget, keywords: Array.from({ length: 16 }, (_, i) => `k${String(i).padStart(3, '0')}`) }))
  await check('setStickerKeywords: 65 characters in total', 'rejected', () =>
    call('setStickerKeywords', { sticker: kwTarget, keywords: ['a'.repeat(65)] }))
  await check('setStickerEmojiList: 20 emoji', 'ok', () =>
    call('setStickerEmojiList', { sticker: kwTarget, emoji_list: [...'😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙'.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]) }))

  // Custom emoji pack: TGS canvas rules and cross-type file_id reuse.
  await check('custom emoji pack from a TGS on the 512×512 canvas', 'ok', async () => {
    await call('createNewStickerSet', { user_id: OWNER, name: emo, title: 'contract emoji', sticker_type: 'custom_emoji', stickers: [attached('animated')] }, file(tgs(512), 'e512.tgs'))
    created.add(emo)
  })
  if (!created.has(emo)) return

  await check('custom emoji: TGS on a 100×100 canvas', 'rejected', () =>
    call('addStickerToSet', { user_id: OWNER, name: emo, sticker: attached('animated') }, file(tgs(100), 'e100.tgs')))

  const regTgs = (await call('getStickerSet', { name: reg })).stickers.find((s) => s.is_animated)
  const emoTgs = (await call('getStickerSet', { name: emo })).stickers[0]
  await check('regular TGS → custom emoji pack by file_id', 'ok', () =>
    call('addStickerToSet', { user_id: OWNER, name: emo, sticker: { sticker: regTgs.file_id, format: 'animated', emoji_list: ['🧪'] } }))
  await check('custom emoji TGS → regular pack by file_id', 'ok', () =>
    call('addStickerToSet', { user_id: OWNER, name: reg, sticker: { sticker: emoTgs.file_id, format: 'animated', emoji_list: ['🧪'] } }))
}

main()
  .catch((err) => {
    failures++
    console.log(`ERROR ${err.message}`)
  })
  .finally(async () => {
    await cleanup()
    console.log(failures ? `\n${failures} check(s) did not match` : '\nall checks match')
    process.exitCode = failures ? 1 : 0
  })
