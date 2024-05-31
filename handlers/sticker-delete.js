const Markup = require('telegraf/markup')

module.exports = async (ctx) => {
  let packBotUsername
  let deleteSticker
  let sticker

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const { message } = ctx.callbackQuery

  sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet')

  if(!sticker) {
    let setName

    const { reply_to_message } = message

    if (message.reply_to_message.sticker) {
      setName = reply_to_message.sticker.set_name

      deleteSticker = reply_to_message.sticker.file_id
    } else if (reply_to_message.entities && reply_to_message.entities[0] && reply_to_message.entities[0].type === 'custom_emoji') {
      const customEmoji = reply_to_message.entities.find((e) => e.type === 'custom_emoji')

      if (!customEmoji) return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)

      const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
        custom_emoji_ids: [customEmoji.custom_emoji_id]
      })

      if (!emojiStickers) return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)

      setName = emojiStickers[0].set_name
      deleteSticker = emojiStickers[0].file_id
    }

    if (!setName) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }

    packBotUsername = setName.split('_').pop(-1)

    if (!message.reply_to_message || !packBotUsername || packBotUsername !== ctx.options.username) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }

    const stickerSet = await ctx.db.StickerSet.findOne({
      name: setName,
      owner: ctx.session.userInfo.id
    })

    if (!stickerSet) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }

  } else {
    if (!sticker.stickerSet) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }

    // cat delete in group
    let canDelete = false

    if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
      const group = await ctx.db.Group.findOne({ telegram_id: ctx.chat.id })

      if (group && group.stickerSet && group.stickerSet._id.toString() === sticker.stickerSet._id.toString()) {
        if (group.settings.rights.delete === 'all') {
          canDelete = true
        } else {
          const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)

          if (['creator', 'administrator'].includes(chatMember.status)) {
            canDelete = true
          }
        }
      } else {
        return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
      }
    }

    if (
      sticker.stickerSet.owner.toString() === ctx.session.userInfo.id.toString() // if sticker owner is the same as the user
      || (ctx.session.userInfo?.stickerSet && sticker.stickerSet.id === ctx.session.userInfo?.stickerSet?.id) // if selected sticker pack by user is the same as the sticker pack
      || canDelete // if user have rights to delete sticker
    ) {
      deleteSticker = sticker.info.file_id
    } else {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }
  }

  if (!deleteSticker) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }

  let deleteStickerFromSet
  if (ctx.session?.userInfo?.stickerSet?.passcode === 'public') {
    const stickerSet = await ctx.tg.getStickerSet(sticker.stickerSet.name)

    if (stickerSet.stickers[0].file_unique_id === sticker.fileUniqueId) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }
  }

  if (ctx.session?.userInfo?.stickerSet?.inline) {
    deleteStickerFromSet = true
  } else {
    deleteStickerFromSet = await ctx.deleteStickerFromSet(deleteSticker).catch((error) => {
      ctx.answerCbQuery(ctx.i18n.t('error.answerCbQuery.telegram', {
        error: error.description
      }), true)
    })
  }

  if (deleteStickerFromSet) {
    ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.delete'))

    ctx.editMessageText(ctx.i18n.t('callback.sticker.delete'), {
      reply_markup: Markup.inlineKeyboard([
        Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.restore'), `restore_sticker:${sticker?.info?.file_unique_id}`, !sticker?.info)
      ])
    }).catch(() => {})

    if (sticker) {
      sticker.deleted = true
      await sticker.save()
    }
  }
}
