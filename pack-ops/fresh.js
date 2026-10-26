// A sticker set as Telegram's servers hold it right now. The Bot API answers
// getStickerSet from a copy of its own, which goes on showing a set deleted
// or edited in a Telegram app (or @Stickers) for minutes; only this bot's own
// next write refreshes it (measured). MTProto (utils/telegram-api.js, the same
// bot) asks the server itself.
//
// Answers like the Bot API: a set that is gone is a 400 with Telegram's word
// for it. Without MTProto, or when it fails, it is the Bot API's answer.

const log = require('../utils/logger').scope('pack-ops:fresh')

/**
 * @param {{callApi: Function}} telegram the Bot API client, the fallback
 * @param {Function} getClient () => an MTProto client or null (utils/telegram-api.js)
 * @param {Object} Api gram.js TL constructors
 * @returns {(name: string) => Promise<Object>} the set, or throws a 400 for none
 */
function createFreshReader (telegram, getClient, Api) {
  return async (name) => {
    const client = await getClient().catch(() => null)
    if (client) {
      try {
        return await client.invoke(new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetShortName({ shortName: name }),
          hash: 0
        }))
      } catch (err) {
        if (err?.code === 400) {
          throw Object.assign(new Error(err.errorMessage), { code: 400, description: `Bad Request: ${err.errorMessage}` })
        }
        log.warn(`getStickerSet over MTProto failed, asking the Bot API: ${err?.errorMessage || err?.message}`)
      }
    }
    return telegram.callApi('getStickerSet', { name })
  }
}

// The Bot API's file_unique_id of a document, as tdlib makes it (measured
// against getStickerSet on a test bot; not documented): int32 2 (a document),
// int64 the document id, runs of zero bytes written as 0 and their count,
// base64url.
function uniqueIdOf (documentId) {
  const raw = Buffer.alloc(12)
  raw.writeInt32LE(2, 0)
  raw.writeBigInt64LE(BigInt.asIntN(64, BigInt(String(documentId))), 4)

  const out = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0) {
      out.push(raw[i])
      continue
    }
    let run = 0
    while (i < raw.length && raw[i] === 0) {
      run++
      i++
    }
    i--
    out.push(0, run)
  }
  return Buffer.from(out).toString('base64url')
}

/**
 * The pack's file_unique_ids as the server has them now, for the conflict
 * check; null when that can't be known. Only an MTProto answer is fresh (a
 * Bot API fallback is the copy the check already has). Since the ids rest on
 * an encoding Telegram doesn't document, ids that share none with `expected`
 * are taken for a broken read, not for a changed pack: null, and a warning.
 * Only a read that matches some of them and differs otherwise can stop a
 * publish.
 *
 * @param {(name: string) => Promise<Object>} readFresh from createFreshReader
 * @returns {(name: string, expected: string[]) => Promise<string[]|null>}
 */
function createFreshUids (readFresh) {
  return async (name, expected) => {
    const set = await readFresh(name)
    if (!Array.isArray(set?.documents)) return null

    const uids = set.documents.map((doc) => uniqueIdOf(doc.id))
    const known = new Set(expected)
    if ((uids.length || expected.length) && !uids.some((uid) => known.has(uid))) {
      log.warn(`${name}: no file_unique_id read over MTProto matches the draft's, skipping the fresh check`)
      return null
    }
    return uids
  }
}

module.exports = { createFreshReader, createFreshUids, uniqueIdOf }
