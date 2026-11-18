// Getting a prepared sticker file into a set: upload (or reuse a file_id),
// add, and confirm what landed. Shared by the add path (utils/add-sticker.js)
// and the convert-queue results (utils/convert-results.js).
//
// The add itself is never sent twice: after a 429, a 502/504 or a dropped
// connection the set is checked for the sticker instead (findLandedSticker).
const { db } = require('../database')
const config = require('../config.json')
const telegram = require('./telegram')
const downloadFileByUrl = require('./download-file-by-url')
const { removePlaceholderIfPending } = require('./placeholder')
const { rescaleTgs } = require('./lottie-rescale')
const { fixStaticTgs } = require('./tgs-static-fix')
const { getRetryAfter } = require('./retry-api')
const { isFileRejection } = require('./file-id-reuse')
const { isTransientError } = require('./transient-error')
const log = require('./logger').scope('add-sticker')

// Telegram takes a TGS only on a 512×512 canvas, for custom emoji too:
// measured against the Bot API, a 100×100 canvas is refused as "wrong file
// type" in both pack types, and an emoji uploaded at 512 is stored and
// served back byte-for-byte. Anything on another canvas is retargeted to 512.
const TGS_CANVAS = 512

const retargetTgs = (buffer) => rescaleTgs(buffer, TGS_CANVAS)

// Something that isn't the user's fault and has no better message. The
// details go to the log; the user used to read them as "Telegram error: …".
const internalError = (reason) => {
  log.error(reason)
  return { error: { i18nKey: 'error.unknown' } }
}

// A real Telegram 429 (not a cooldown we short-circuited ourselves), logged
// with the sticker it happened on — so "flood on a specific file" can be told
// apart from "the next file after a flood" in prod logs.
const logRateLimit = (method, error, { userId, stickerSet, stickerFile, stickerExtra, uploadBytes }) => {
  if (error?.code !== 429 || error.__cachedRateLimit) return
  const via = uploadBytes
    ? `upload(${uploadBytes}B) reason=${uploadReason(stickerSet, stickerFile, stickerExtra)}`
    : 'file_id'
  log.warn(
    `429 on ${method}: retry_after=${getRetryAfter(error)}s user=${userId} pack=${stickerSet.name} ` +
    `pack_type=${stickerSet.packType || 'regular'} format=${stickerExtra.sticker_format} ` +
    `file_unique_id=${stickerFile?.file_unique_id} src_set=${stickerFile?.set_name || '-'} ` +
    `src_type=${stickerFile?.type || '-'} via=${via}`
  )
}

// Why a sticker went through an upload instead of file_id — the question a
// bare "via=upload" in the 429 log couldn't answer.
const uploadReason = (stickerSet, stickerFile, stickerExtra) => {
  if (stickerExtra.uploadReason) return stickerExtra.uploadReason
  if (!stickerFile?.set_name) return 'no_source_set'
  if (stickerFile.type !== (stickerSet.packType || 'regular')) return `retarget_from_${stickerFile.type}`
  return 'other'
}

// getStickerSet reports "⭐" where emoji_list had "⭐️" (or the reverse).
const normalizeEmoji = (emoji) => (emoji || '').replace(/\uFE0F/g, '')

// `beforeStickers` is the set's sticker list as it looked immediately before
// this add (the caller usually already has it). Passing it lets us identify the
// sticker WE added instead of assuming it's the last one — with two concurrent
// adds to the same pack, slice(-1)[0] mapped both DB rows onto the same file.
const pickAddedSticker = (setInfo, beforeStickers, stickerFile) => {
  const isOurs = (s) => s.file_unique_id === stickerFile?.file_unique_id
  const beforeIds = new Set(
    Array.isArray(beforeStickers) ? beforeStickers.map((s) => s.file_unique_id) : []
  )
  const added = beforeIds.size > 0
    ? setInfo.stickers.filter((s) => !beforeIds.has(s.file_unique_id))
    : []

  // 1. A new sticker with our exact document — only the file_id path keeps
  //    file_unique_id, so this is the precise hit when concurrent adds landed.
  // 2. Otherwise the newest new sticker (upload path gets a new file_unique_id).
  // 3. Nothing new, but our document is in the set: Telegram left it unchanged
  //    ("If exactly the same sticker had already been added to the set, then
  //    the set isn't changed").
  // 4. No before-snapshot (e.g. the convert-queue path): the last sticker.
  // Checking the whole set for our document BEFORE the diff would map a fresh
  // upload onto an older copy of the same source already in the pack.
  return added.find(isOurs) ||
    added[added.length - 1] ||
    setInfo.stickers.find(isOurs) ||
    setInfo.stickers.slice(-1)[0]
}

// After a 429 on addStickerToSet, check whether the sticker made it into the
// set anyway. Accepts only an unambiguous match: the same file_unique_id
// (file_id path), or exactly one new sticker with our emoji and format —
// with up to three adds in flight per user, "any new sticker" could be a
// sibling's.
const findLandedSticker = async (stickerSet, stickerFile, stickerExtra, beforeStickers) => {
  if (!Array.isArray(beforeStickers) || beforeStickers.length === 0) return null

  const setInfo = await telegram.getStickerSet(stickerSet.name).catch(() => null)
  // Couldn't look: the add may or may not be there.
  if (!setInfo?.stickers) return { unknown: true }

  const beforeIds = new Set(beforeStickers.map((s) => s.file_unique_id))
  const fresh = setInfo.stickers.filter((s) => !beforeIds.has(s.file_unique_id))

  const exact = fresh.find((s) => s.file_unique_id === stickerFile?.file_unique_id)
  if (exact) return { setInfo, sticker: exact }

  const format = stickerExtra.sticker_format
  const emoji = normalizeEmoji(stickerExtra.emojis?.[0])
  const candidates = fresh.filter((s) =>
    normalizeEmoji(s.emoji) === emoji &&
    !!s.is_animated === (format === 'animated') &&
    !!s.is_video === (format === 'video')
  )

  return candidates.length === 1 ? { setInfo, sticker: candidates[0] } : null
}

const packLink = (stickerSet) =>
  `${stickerSet.packType === 'custom_emoji' ? config.emojiLinkPrefix : config.stickerLinkPrefix}${stickerSet.name}`

// The add may be in the pack and we couldn't check. Not a failure to resend
// (that is how duplicates were made), not a success either: the user looks.
// handlers/sticker.js never repeats an add on this.
const unconfirmed = (stickerSet) => ({ error: { type: 'unconfirmed', link: packLink(stickerSet) } })

// Everything after the sticker is confirmed in the set: placeholder cleanup,
// DB row, success payload.
const finalizeAdd = async (stickerSet, stickerFile, stickerExtra, setInfo, stickerInfo) => {
  // A real sticker just landed — safe to drop the bootstrap placeholder now.
  await removePlaceholderIfPending(telegram, stickerSet, setInfo)

  const sticker = await db.Sticker.addSticker(stickerSet._id, stickerExtra.emojis, stickerInfo, stickerFile)

  return {
    ok: {
      title: stickerSet.title,
      link: packLink(stickerSet),
      stickerInfo,
      sticker,
      // A monochrome (needs_repainting) emoji dropped into a regular sticker
      // pack stays white-on-transparent — nothing repaints it there. Surface
      // that in the success text so the user isn't puzzled by a "blank"
      // sticker on a light background.
      repainting: !!stickerFile?.needs_repainting && stickerSet.packType !== 'custom_emoji'
    }
  }
}

const uploadSticker = async (userId, stickerSet, stickerFile, stickerExtra, beforeStickers) => {
  let stickerAdd

  if (!stickerExtra || !stickerExtra.sticker) {
    return internalError(`uploadSticker without sticker data (pack ${stickerSet.name})`)
  }

  const { sticker } = stickerExtra
  const uploadBytes = sticker?.source ? sticker.source.length : 0
  const logContext = { userId, stickerSet, stickerFile, stickerExtra, uploadBytes }

  if (sticker?.source) {
    // retry-api repeats an upload on a 5xx or a dropped connection.
    const uploadedSticker = await telegram.callApi('uploadStickerFile', {
      user_id: userId,
      sticker_format: stickerExtra.sticker_format,
      sticker: {
        source: sticker.source
      }
    }).catch((error) => ({ error: { telegram: error } }))

    if (uploadedSticker.error) {
      logRateLimit('uploadStickerFile', uploadedSticker.error.telegram, logContext)
    }

    if (uploadedSticker.error) {
      return uploadedSticker
    }

    stickerExtra.sticker = uploadedSticker.file_id
  }

  if (!stickerExtra.sticker) {
    return internalError(`uploadStickerFile returned no file_id (pack ${stickerSet.name})`)
  }

  if (stickerSet.create === false) {
    stickerAdd = await telegram.callApi('createNewStickerSet', {
      user_id: userId,
      name: stickerSet.name,
      title: stickerSet.title,
      stickers: [{
        sticker: stickerExtra.sticker,
        format: stickerExtra.sticker_format,
        emoji_list: stickerExtra.emojis
      }],
      sticker_type: stickerSet.packType === 'custom_emoji' ? 'custom_emoji' : 'regular'
    }).catch((error) => {
      logRateLimit('createNewStickerSet', error, logContext)
      return {
        error: {
          telegram: error
        }
      }
    })
    if (stickerAdd.error) {
      return stickerAdd
    }
    if (stickerAdd) {
      stickerSet.create = true
      await stickerSet.save()
    }
  } else {
    stickerAdd = await telegram.callApi('addStickerToSet', {
      user_id: userId,
      name: stickerSet.name,
      sticker: {
        format: stickerExtra.sticker_format,
        sticker: stickerExtra.sticker,
        emoji_list: stickerExtra.emojis
      }
    }).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })

    if (stickerAdd.error) {
      const error = stickerAdd.error.telegram
      const rateLimited = error?.code === 429 && !error.__cachedRateLimit
      if (!rateLimited && !isTransientError(error)) return stickerAdd

      if (rateLimited) logRateLimit('addStickerToSet', error, logContext)

      // Neither a 429 nor a 502/504 / dropped connection is a sure refusal:
      // the Bot API server's TDLib retries FLOOD_WAIT internally, and a
      // gateway timeout often comes back for an add Telegram did carry out.
      // Look before telling the user it failed — otherwise they resend and
      // get a duplicate. The add itself is never sent twice.
      const landed = await findLandedSticker(stickerSet, stickerFile, stickerExtra, beforeStickers)
      log.warn(`addStickerToSet ${error?.code || error?.type || 'error'} on pack=${stickerSet.name}: sticker ${landed?.unknown ? 'unknown, set unreadable' : landed ? 'landed anyway' : 'not in set'}`)

      if (landed?.unknown) return unconfirmed(stickerSet)
      if (!landed) return stickerAdd
      return finalizeAdd(stickerSet, stickerFile, stickerExtra, landed.setInfo, landed.sticker)
    }
  }

  if (stickerAdd) {
    const getStickerSet = await telegram.getStickerSet(stickerSet.name).catch((error) => {
      return {
        error: {
          telegram: error
        }
      }
    })
    // Telegram said the add went through; only the read after it failed.
    // Reporting that as a failure made people resend, and the handler
    // repeated the whole add on a short 429 here.
    if (getStickerSet.error) {
      log.warn(`getStickerSet after a confirmed add failed on pack=${stickerSet.name}: ${getStickerSet.error.telegram?.code || getStickerSet.error.telegram?.message}`)
      return unconfirmed(stickerSet)
    }

    if (!getStickerSet.stickers || getStickerSet.stickers.length === 0) {
      return internalError(`pack ${stickerSet.name} is empty right after an add`)
    }

    const stickerInfo = pickAddedSticker(getStickerSet, beforeStickers, stickerFile)

    return finalizeAdd(stickerSet, stickerFile, stickerExtra, getStickerSet, stickerInfo)
  }
}

// Add a sticker by file_id. Returns the add result, or null when Telegram
// refused the file itself — the caller then re-uploads, and the reason is
// kept for that upload's 429 log.
const tryAddByFileId = async (userId, stickerSet, stickerFile, stickerExtra, beforeStickers) => {
  const fileId = stickerFile.reuse_file_id || stickerFile.file_id
  const result = await uploadSticker(userId, stickerSet, stickerFile, { ...stickerExtra, sticker: fileId }, beforeStickers)
  if (!isFileRejection(result)) return result

  log.info(
    `file_id add refused for ${stickerFile.file_unique_id} ` +
    `(${result.error.telegram.description}) — falling back to re-upload`
  )
  stickerExtra.uploadReason = 'file_id_refused'
  return null
}

// Download a TGS (unless the bytes are already here), fit it to Telegram's
// canvas and upload it.
const uploadRetargetedTgs = async (userId, stickerSet, stickerFile, stickerExtra, fileUrl, beforeStickers, preloaded = null) => {
  let animatedData = preloaded
  if (!animatedData) {
    try {
      animatedData = await downloadFileByUrl(fileUrl)
    } catch (err) {
      return { error: { i18nKey: 'sticker.add.error.convert' } }
    }
  }

  const retargeted = retargetTgs(animatedData)
  if (retargeted.error) return retargeted

  const extra = { ...stickerExtra, sticker: { source: retargeted.buffer } }
  const result = await uploadSticker(userId, stickerSet, stickerFile, extra, beforeStickers)
  if (!isFileRejection(result)) return result

  // Telegram refuses a TGS it parses as static ("wrong file type"), typically
  // one whose keyframes carry no interpolators and get dropped. Repair it only
  // after a refusal, so files Telegram takes as they are stay untouched.
  const repaired = fixStaticTgs(retargeted.buffer)
  if (repaired.error || !repaired.changed) return result
  return uploadSticker(userId, stickerSet, stickerFile, { ...stickerExtra, sticker: { source: repaired.buffer } }, beforeStickers)
}

module.exports = {
  uploadSticker,
  tryAddByFileId,
  uploadRetargetedTgs,
  internalError,
  pickAddedSticker,
  findLandedSticker
}
