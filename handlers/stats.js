const Composer = require('telegraf/composer')

const composer = new Composer()

// A catalog sticker link (handlers/sticker-link.js) names one sticker of one
// pack. Logged whole, every sticker would be a deep link of its own; the pack
// is what the numbers are about, so the position and the check are dropped.
const STICKER_LINK_RE = /^([ab]_[A-Za-z0-9_]+)-\d+(?:-[A-Za-z0-9_-]+)?$/

const deepLinkName = (payload) => {
  const stickerLink = STICKER_LINK_RE.exec(payload)
  return stickerLink ? stickerLink[1] : payload
}

composer.use(async (ctx, next) => {
  if (ctx.updateType === 'message' && ctx.updateSubTypes.includes('text') && ctx.message.text.startsWith('/start')) {
    const params = ctx.message.text.split(' ')
    if (params.length > 1) {
      const deepLink = deepLinkName(params[1])
      const found = await ctx.db.DeepLink.findOne({ deepLink, user: ctx.session.userInfo._id })

      if (!found) {
        await ctx.db.DeepLink.create({
          user: ctx.session.userInfo._id,
          deepLink
        })
      }
    }
  }

  return next()
})

module.exports = composer
module.exports.deepLinkName = deepLinkName
