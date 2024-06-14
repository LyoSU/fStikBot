const Markup = require('telegraf/markup')
const {
  showGramAds,
  countUncodeChars,
  substrUnicode,
  addSticker,
  addStickerText
} = require('../utils')

const escapeHTML = (str) => str.replace(
  /[&<>'"]/g,
  (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag)
)

module.exports = async (ctx, next) => {
  if (ctx.message?.text?.startsWith('/ss') && !ctx.message?.reply_to_message) {
    return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.reply'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }

  ctx.replyWithChatAction('upload_document').catch(() => {})

  let messageText = ''
  let replyMarkup = {}

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const message = ctx.message || ctx.callbackQuery.message

  let stickerFile
  let stickerType = ctx.updateSubTypes[0]
  if (ctx.callbackQuery) {
    if (message.document) {
      stickerType = 'document'
    } else if (message.sticker) {
      stickerType = 'sticker'
    }

    // if message send less than 2 seconds ago
    if (message.date > Math.floor(Date.now() / 1000) - 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  if (ctx.message?.text?.startsWith('/ss') && ctx.message?.reply_to_message) {
    if (ctx.message.reply_to_message.sticker) stickerType = 'sticker'
    else if (ctx.message.reply_to_message.document) stickerType = 'document'
    else if (ctx.message.reply_to_message.animation) stickerType = 'animation'
    else if (ctx.message.reply_to_message.video) stickerType = 'video'
    else if (ctx.message.reply_to_message.video_note) stickerType = 'video_note'
    else if (ctx.message.reply_to_message.photo) stickerType = 'photo'
    else stickerType = undefined
  }

  switch (stickerType) {
    case 'sticker':
      stickerFile = message.sticker
      break

    case 'document':
      if (
        (message?.document?.mime_type.match('image') ||
        message?.document?.mime_type?.match('video'))
        && !message.document.mime_type.match(/heic|heif/)
      ) {
        stickerFile = message.document
        if (message.caption) stickerFile.emoji = message.caption
      }
      break

    case 'animation':
      // if caption tenor gif
      if (message.caption && message.caption.match('tenor.com')) {
        stickerFile = message.animation
        stickerFile.fileUrl = message.caption
      } else {
        stickerFile = message.animation
        if (message.caption) stickerFile.emoji = message.caption
      }
      break

    case 'video':
      stickerFile = message.video
      if (message.caption) stickerFile.emoji = message.caption
      break

    case 'video_note':
        stickerFile = message?.video_note
        if (message?.video_note) stickerFile.video_note = true
    break

    case 'photo':
      // eslint-disable-next-line prefer-destructuring
      if (message.photo) stickerFile = message.photo.slice(-1)[0]
      if (message.caption) stickerFile.emoji = message.caption
      break

    default:
      break
  }

  if (ctx.message?.text?.startsWith('/ss') && ctx.message?.reply_to_message && stickerType && !stickerFile) {
    stickerFile = ctx.message.reply_to_message[stickerType]
    if (Array.isArray(stickerFile)) {
      stickerFile = stickerFile.slice(-1)[0]
    }
    if (stickerType === 'video_note') stickerFile.video_note = true
  }

  if (stickerType === 'text') {
    const customEmoji = message.entities.find((e) => e.type === 'custom_emoji')

    if (!customEmoji) return next()

    const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: [customEmoji.custom_emoji_id]
    })

    if (!emojiStickers) return next()

    stickerFile = emojiStickers[0]
  }

  let { stickerSet } = ctx.session.userInfo

  if (!stickerSet) {
    if (ctx.chat.type === 'private') {
      return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.no_selected_pack'), {
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true
      })
    } else {
      return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.no_selected_pack'), {
        reply_markup: Markup.inlineKeyboard([
          Markup.switchToCurrentChatButton(ctx.i18n.t('cmd.packs.select_pack'), 'select_pack')
        ]),
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true
      })
    }
  }

  if (!stickerSet?.inline) {
    const stickerSetInfo = await ctx.telegram.getStickerSet(stickerSet.name).catch(() => {})

    if (stickerSetInfo) {
      // if user not premium and not boosed pack and title not have bot username
      if (!stickerSet.boost && !stickerSetInfo.title.includes(ctx.options.username)) {
        const titleSuffix = ` :: @${ctx.options.username}`
        const charTitleMax = ctx.config.charTitleMax

        let newTitle = stickerSetInfo.title

        if (countUncodeChars(newTitle) > charTitleMax) {
          newTitle = substrUnicode(newTitle, 0, charTitleMax)
        }

        newTitle += titleSuffix

        await ctx.telegram.callApi('setStickerSetTitle', {
          name: stickerSet.name,
          title: newTitle
        }).catch((err) => {
          console.log('setStickerSetTitle', err)
        })

        const linkPrefix = stickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

        const text = ctx.i18n.t('scenes.rename.success', {
          title: escapeHTML(stickerSet.title),
          link: `${linkPrefix}${stickerSet.name}`
        }) + '\n' + ctx.i18n.t('scenes.rename.boost_notice', {
          titleSuffix: escapeHTML(titleSuffix)
        })

        await ctx.replyWithHTML(text)
      }

      stickerSet.title = stickerSetInfo.title
      await stickerSet.save()
    }
  }

  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    const group = await ctx.db.Group.findOne({ telegram_id: ctx.chat.id }).populate('stickerSet')

    if (!group || !group.stickerSet) {
      return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.no_selected_group_pack'), {
        reply_markup: Markup.inlineKeyboard([
          Markup.switchToCurrentChatButton(ctx.i18n.t('cmd.packs.select_group_pack'), 'select_group_pack')
        ]),
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true
      })
    }

    // if have rights to add stickers
    if (group.settings?.rights?.add !== 'all') {
      const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id)

      if (!['creator', 'administrator'].includes(chatMember.status)) {
        return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.no_rights'), {
          reply_to_message_id: message.message_id,
          allow_sending_without_reply: true
        })
      }
    }

    if (group) {
      stickerSet = group.stickerSet
    }
  }

  if (!stickerSet) {
    return ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.no_selected_pack'), {
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true
    })
  }

  if (stickerSet.inline) {
    if (stickerType === 'photo') stickerFile = message[stickerType].pop()
    else stickerFile = message[stickerType]

    if (stickerFile?.stickerType) stickerFile.stickerType = stickerType

    if (message.caption) stickerFile.caption = message.caption
    stickerFile.file_unique_id = stickerSet.id + '_' + stickerFile.file_unique_id
  }

  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.message.document) {
      stickerFile = ctx.callbackQuery.message.document
    } else if (ctx.callbackQuery.message.sticker) {
      stickerFile = ctx.callbackQuery.message.sticker
    }
  }

  if (stickerFile) {
    if (message.caption?.includes('roundit')) stickerFile.video_note = true
    if (message.caption?.includes('cropit')) stickerFile.forceCrop = true
    if (message.photo && message.caption?.includes('!')) stickerFile.removeBg = true

    const originalSticker = await ctx.db.Sticker.findOne({
      stickerSet,
      fileUniqueId: stickerFile.file_unique_id,
      deleted: false
    })

    let sticker

    if (originalSticker) {
      sticker = originalSticker
    } else {
      sticker = await ctx.db.Sticker.findOne({
        stickerSet,
        'file.file_unique_id': stickerFile.file_unique_id,
        deleted: false
      })
    }

    if (sticker) {
      ctx.session.previousSticker = {
        id: sticker.id
      }

      await ctx.replyWithHTML(ctx.i18n.t('sticker.add.error.have_already'), {
        reply_to_message_id: message.message_id,
        allow_sending_without_reply: true,
        reply_markup: Markup.inlineKeyboard([
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.delete'), `delete_sticker:${sticker.info.file_unique_id}`),
          Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.copy'), `restore_sticker:${sticker.info.file_unique_id}`)
        ])
      })
    } else {
      if (ctx.session.userInfo.locale === 'ru' && !stickerSet?.boost) {
        showGramAds(ctx.chat.id)
      }

      ctx.session.previousSticker = null

      const stickerInfo = await addSticker(ctx, stickerFile, stickerSet)

      if (stickerInfo.wait) {
        return
      }

      const result = addStickerText(stickerInfo, ctx.i18n.locale())

      messageText = result.messageText
      replyMarkup = result.replyMarkup

      if (typeof stickerSet?.publishDate === 'undefined' && stickerSet?.packType === 'regular') {
        const countStickers = await ctx.db.Sticker.count({
          stickerSet,
          deleted: false
        })

        if ([50, 90].includes(countStickers)) {
          setTimeout(async () => {
            await ctx.replyWithHTML(ctx.i18n.t('sticker.add.catalog_offer', {
              title: escapeHTML(stickerSet.title),
              link: `${ctx.config.stickerLinkPrefix}${stickerSet.name}`
            }), {
              reply_markup: Markup.inlineKeyboard([
                Markup.callbackButton(ctx.i18n.t('callback.pack.btn.catalog_add'), `catalog:publish:${stickerSet.id}`)
              ])
            })
          }, 1000 * 2)
        }
      }
    }
  } else {
    if (ctx.chat.type === 'private') {
      messageText = ctx.i18n.t('sticker.add.error.file_type.unknown')
    } else {
      return ctx.replyWithHTML(ctx.i18n.t('sticker.add.quote'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: ctx.i18n.t('cmd.start.commands.add_to_group'), url: 'https://t.me/QuotLyBot?startgroup=bot' }]
          ]
        },
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
    }
  }

  if (messageText) {
    await ctx.replyWithHTML(messageText, {
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true,
      reply_markup: replyMarkup
    })
  }
}
