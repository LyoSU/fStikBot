// Rendering of "packs owned by <user>" lists — shared by the /about scene
// (user lookup, forwarded message, sticker lookup) and the "show all packs"
// button in bot/commands.js. They used to be four diverging copies.
const escapeHTML = require('./html-escape')
const { hasRight } = require('../handlers/admin/_helpers')

const DEFAULT_CHUNK = 70

// Packs created by the bot and never published are private to their owner:
// masked as "[hidden]" for everyone except the owner and pack admins.
const isHiddenFromViewer = (ctx, pack, ownerTelegramId) => {
  if (!pack.name.toLowerCase().endsWith('fstikbot')) return false
  if (pack.public === true) return false
  return ctx.from.id !== ownerTelegramId && !hasRight(ctx, 'pack')
}

const packLink = (ctx, pack) => {
  const prefix = pack.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix
  return `https://${prefix}${pack.name}`
}

/**
 * Format packs as HTML links, masking the ones this viewer may not see, and
 * chunk them so a single message stays under Telegram's length limit.
 *
 * @param {Object} ctx
 * @param {Array<{name: string, public?: boolean, packType?: string}>} packs
 * @param {number} ownerTelegramId
 * @param {number} [chunkSize]
 * @returns {string[][]} chunks of formatted entries
 */
const formatOwnerPacks = (ctx, packs, ownerTelegramId, chunkSize = DEFAULT_CHUNK) => {
  const entries = packs.map((pack) => {
    if (isHiddenFromViewer(ctx, pack, ownerTelegramId)) return ctx.i18n.t('scenes.packAbout.hidden')
    const name = escapeHTML(pack.name)
    const href = escapeHTML(packLink(ctx, pack))
    if (pack.name.toLowerCase().endsWith('fstikbot') && pack.public !== true) {
      return `<a href="${href}"><s>${name}</s></a>`
    }
    return `<a href="${href}">${name}</a>`
  })

  const chunks = []
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push(entries.slice(i, i + chunkSize))
  }
  return chunks
}

module.exports = { formatOwnerPacks, packLink }
