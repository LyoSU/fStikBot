const Markup = require('telegraf/markup')
const escapeHTML = require('../utils/html-escape')
const { humanizeTelegramError } = require('../utils/telegram-error')
const { safeEditMessage } = require('../utils/safe-edit')

module.exports = async (ctx) => {
  let packBotUsername
  let deleteSticker
  let sticker

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const { message } = ctx.callbackQuery

  sticker = await ctx.db.Sticker.findOne({
    fileUniqueId: ctx.match[2]
  }).populate('stickerSet', '_id name title owner inline passcode')

  if (!sticker) {
    let setName

    const { reply_to_message } = message

    if (message?.reply_to_message?.sticker) {
      setName = reply_to_message.sticker.set_name

      deleteSticker = reply_to_message.sticker.file_id
    } else if (reply_to_message?.entities && reply_to_message?.entities?.[0] && reply_to_message?.entities?.[0]?.type === 'custom_emoji') {
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

    packBotUsername = setName.split('_').pop()

    if (!message?.reply_to_message || !packBotUsername || packBotUsername !== ctx?.options?.username) {
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
      sticker.stickerSet.owner.toString() === ctx.session.userInfo.id.toString() || // if sticker owner is the same as the user
      (ctx.session.userInfo?.stickerSet && sticker.stickerSet.id === ctx.session.userInfo?.stickerSet?.id) || // if selected sticker pack by user is the same as the sticker pack
      canDelete // if user have rights to delete sticker
    ) {
      deleteSticker = sticker.getFileId()
    } else {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }
  }

  if (!deleteSticker) {
    return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
  }

  if (ctx.session?.userInfo?.stickerSet?.passcode === 'public' && sticker?.stickerSet?.name) {
    const stickerSet = await ctx.tg.getStickerSet(sticker.stickerSet.name).catch(() => null)

    if (stickerSet?.stickers?.[0]?.file_unique_id === sticker.fileUniqueId) {
      return ctx.answerCbQuery(ctx.i18n.t('callback.sticker.error.not_found'), true)
    }
  }

  if (!sticker?.stickerSet?.inline) {
    try {
      await ctx.deleteStickerFromSet(deleteSticker)
    } catch (error) {
      const description = error?.description || error?.message || ''

      // STICKER_INVALID means the sticker is already gone from the set (removed
      // via a Telegram client or @Stickers). Our row said deleted:false, so the
      // same file kept coming back as "already in the pack" with a button that
      // could never work. Sync the DB and report success.
      if (!description.includes('STICKER_INVALID')) {
        return ctx.answerCbQuery(humanizeTelegramError(ctx, error), true)
      }
    }
  }

  await ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.delete'))

  const packTitle = sticker?.stickerSet?.title
  const successText = packTitle
    ? `${ctx.i18n.t('callback.sticker.delete')}\n\n📦 <i>${escapeHTML(packTitle)}</i>`
    : ctx.i18n.t('callback.sticker.delete')

  await safeEditMessage(ctx, successText, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      { ...Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.restore'), `restore_sticker:${sticker?.fileUniqueId}`, !sticker), style: 'success' }
    ])
  })

  if (sticker) {
    sticker.deleted = true
    sticker.deletedAt = new Date()
    await sticker.save()
  }
}
