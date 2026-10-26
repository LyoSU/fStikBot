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

module.exports = { createFreshReader }
