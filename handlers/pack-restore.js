const { escapeHTML } = require('../utils')
const packLink = require('../utils/pack-link')

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

  const getStickerSet = await ctx.telegram.getStickerSet(ctx.match[2]).catch(() => null)

  if (!getStickerSet) {
    return ctx.replyWithHTML(ctx.i18n.t('callback.pack.error.restore'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }

  if (getStickerSet.name.endsWith(`_by_${ctx.options.username}`)) {
    if (findStickerSet) {
      findStickerSet.title = getStickerSet.title
      if (findStickerSet.create === true) {
        if (findStickerSet.hide === true) {
          findStickerSet.hide = false
          // Reset the cached pack count so /packs recounts it (see pack-hide.js).
          const countType = findStickerSet.inline ? 'inline' : (findStickerSet.packType || 'regular')
          await ctx.db.User.updateOne({ _id: findStickerSet.owner }, { $set: { [`packsCount.${countType}`]: 0 } })
          if (ctx.session.userInfo.packsCount) ctx.session.userInfo.packsCount[countType] = 0
        } else {
          const packOwner = await ctx.db.User.findById(findStickerSet.owner)
          if (!packOwner) {
            findStickerSet.owner = ctx.session.userInfo.id
          }
        }
        await findStickerSet.save()
        restored = true
      }
    }

    if (restored) {
      // The pack's rows are made to match the set: present stickers first,
      // then the rest marked deleted. Marking everything deleted first left a
      // live pack looking empty when the update stopped halfway, and the
      // lookup went by file alone, so it could take another pack's row for
      // the same file and move it here.
      const fileUniqueIds = getStickerSet.stickers.map(s => s.file_unique_id)
      const existingStickers = await ctx.db.Sticker.find({
        stickerSet: findStickerSet._id,
        fileUniqueId: { $in: fileUniqueIds }
      }).sort({ deleted: 1, _id: -1 }).lean()
      // One row per file: a live one, else the newest.
      const stickerMap = new Map()
      for (const row of existingStickers) {
        if (!stickerMap.has(row.fileUniqueId)) stickerMap.set(row.fileUniqueId, row)
      }

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
                  stickerType: sticker.type || null
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

      if (bulkOps.length > 0) {
        const result = await ctx.db.Sticker.bulkWrite(bulkOps, { ordered: false })
        if (result.hasWriteErrors && result.hasWriteErrors()) {
          console.error('Partial bulk write failure:', result.getWriteErrors())
        }
      }

      // Whatever the set no longer has, including other rows for a file the
      // set holds once, goes to the archive with its TTL timestamp.
      // Rows just inserted are for files that had none, so they match neither.
      const kept = [...stickerMap.values()].map((row) => row._id)
      await ctx.db.Sticker.updateMany(
        {
          stickerSet: findStickerSet._id,
          deleted: { $ne: true },
          $or: [
            { fileUniqueId: { $nin: fileUniqueIds } },
            { fileUniqueId: { $in: [...stickerMap.keys()] }, _id: { $nin: kept } }
          ]
        },
        { $set: { deleted: true, deletedAt: new Date() } }
      )

      messageText = ctx.i18n.t('callback.pack.restored', {
        title: escapeHTML(findStickerSet.title),
        link: packLink(findStickerSet)
      })
    }
  }

  await ctx.replyWithHTML(messageText, {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
}
