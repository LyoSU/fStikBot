const { escapeHTML } = require('../utils')

module.exports = async (ctx, next) => {
  let messageText = ctx.i18n.t('callback.pack.error.restore')

  let restored = false
  const findStickerSet = await ctx.db.StickerSet.findOne({
    name: ctx.match[2],
    owner: ctx.session.userInfo.id,
    thirdParty: false
  })

  if (!findStickerSet) {
    return next()
  }

  const getStickerSet = await ctx.getStickerSet(ctx.match[2]).catch(() => {})

  if (!getStickerSet) {
    return next()
  }

  if (getStickerSet.name.split('_').pop(-1) === ctx.options.username) {
    if (findStickerSet) {
      findStickerSet.title = getStickerSet.title
      if (findStickerSet.create === true) {
        if (findStickerSet.hide === true) {
          findStickerSet.hide = false
        } else {
          const packOwner = await ctx.db.User.findById(findStickerSet.owner)
          if (!packOwner) {
            findStickerSet.owner = ctx.session.userInfo.id
          }
        }
        findStickerSet.save()
        restored = true
      }
    }

    if (restored) {
      // Mark all stickers as deleted with TTL timestamp before re-syncing
      await ctx.db.Sticker.updateMany(
        { stickerSet: findStickerSet },
        { $set: { deleted: true, deletedAt: new Date() } }
      )

      // Batch fetch existing stickers (single query instead of N queries)
      const fileUniqueIds = getStickerSet.stickers.map(s => s.file_unique_id)
      const existingStickers = await ctx.db.Sticker.find({
        fileUniqueId: { $in: fileUniqueIds }
      }).lean()
      const stickerMap = new Map(existingStickers.map(s => [s.fileUniqueId, s]))

      // Prepare bulk operations
      const bulkOps = getStickerSet.stickers.map(sticker => {
        const existing = stickerMap.get(sticker.file_unique_id)

        if (existing) {
          // Update existing sticker
          return {
            updateOne: {
              filter: { _id: existing._id },
              update: {
                $set: {
                  deleted: false,
                  deletedAt: null,
                  fileId: sticker.file_id,
                  stickerType: sticker.type || null,
                  stickerSet: findStickerSet._id
                }
              }
            }
          }
        } else {
          // Insert new sticker
          return {
            insertOne: {
              document: {
                fileUniqueId: sticker.file_unique_id,
                emojis: sticker.emoji + findStickerSet.emojiSuffix,
                deleted: false,
                deletedAt: null,
                fileId: sticker.file_id,
                stickerType: sticker.type || null,
                stickerSet: findStickerSet._id
              }
            }
          }
        }
      })

      // Execute all operations in single batch
      if (bulkOps.length > 0) {
        await ctx.db.Sticker.bulkWrite(bulkOps, { ordered: false })
      }

      messageText = ctx.i18n.t('callback.pack.restored', {
        title: escapeHTML(findStickerSet.title),
        link: `${ctx.config.stickerLinkPrefix}${findStickerSet.name}`
      })
    }
  }

  await ctx.replyWithHTML(messageText, {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
}
