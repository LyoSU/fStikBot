const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const {
  escapeHTML,
  telegramApi,
  moderatePack,
  showGramAds
} = require('../utils')
const {
  db
} = require('../database')

function decodeStickerSetId (u64) {
  let u32 = u64 >> 32n
  let u32l = u64 & 0xffffffffn

  if ((u64 >> 24n & 0xffn) === 0xffn) { // for 64-bit ids
    u32 = (u64 >> 32n) + 0x100000000n
    u32l = (u64 & 0xfn)
  }

  return {
    ownerId: parseInt(u32),
    setId: parseInt(u32l)
  }
}

const packAbout = new Scene('packAbout')

packAbout.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.enter'), {
    reply_markup: {
      keyboard: [
        [{
          text: ctx.i18n.t('userAbout.select_user'),
          request_users: {
            request_id: 1,
            user_is_bot: false,
            max_quantity: 1,
          }
        }],
        [
          ctx.i18n.t('scenes.btn.cancel')
        ]
      ],
      resize_keyboard: true
    }
  })
})


// Handle user selection via users_shared
packAbout.use((ctx, next) => {
  if (ctx?.message?.users_shared) {
    let sharedUserId = ctx.message.users_shared.user_ids[0]

    if (!sharedUserId) return next()

    if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
      showGramAds(ctx.chat.id)
    }

    ctx.db.StickerSet.find({
      ownerTelegramId: sharedUserId
    }).select('_id name public').limit(500).lean().then((findPacks) => {
      let chunkedPacks = []
      const chunkSize = 70

      if (findPacks.length > 0) {
        chunkedPacks = (findPacks.map((pack) => {
          if (pack.name.toLowerCase().endsWith('fStikBot'.toLowerCase()) && pack.public !== true) {
            if (
              ctx.from.id === sharedUserId
              || ctx.from.id === ctx.config.mainAdminId
              || ctx?.session?.userInfo?.adminRights.includes('pack')
            ) {
              return `<a href="https://t.me/addstickers/${pack.name}"><s>${pack.name}</s></a>`
            } else {
              return '<i>[hidden]</i>'
            }
          }
          return `<a href="https://t.me/addstickers/${pack.name}">${pack.name}</a>`
        })).reduce((resultArray, item, index) => {
          const chunkIndex = Math.floor(index / chunkSize)

          if (!resultArray[chunkIndex]) {
            resultArray[chunkIndex] = []
          }

          resultArray[chunkIndex].push(item)

          return resultArray
        }, [])
      }

      let packsToReturn

      if (chunkedPacks.length > 0) {
        packsToReturn = chunkedPacks.shift()
      }

      // Save data for "show all packs" button
      const totalPacks = findPacks.length
      if (chunkedPacks.length > 0) {
        ctx.session.showAllPacksData = {
          ownerId: sharedUserId,
          excludeSetId: null
        }
      }

      const keyboard = []
      if (chunkedPacks.length > 0) {
        keyboard.push([Markup.callbackButton(
          ctx.i18n.t('scenes.packAbout.btn.show_all_packs', { count: totalPacks }),
          'show_all_packs'
        )])
      }

      ctx.replyWithHTML(ctx.i18n.t('userAbout.result', {
        userId: sharedUserId,
        packs: packsToReturn ? packsToReturn.join(', ') : ctx.i18n.t('userAbout.no_packs')
      }), {
        disable_web_page_preview: true,
        ...(keyboard.length > 0 ? Markup.inlineKeyboard(keyboard).extra() : {})
      })
    })

    return
  }
  return next()
})

packAbout.on(['sticker', 'text', 'forward'], async (ctx, next) => {
  // Handle forwarded message for user info
  if (ctx.message.forward_from) {
    let sharedUserId = ctx.message.forward_from.id

    if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
      showGramAds(ctx.chat.id)
    }

    const findPacks = await ctx.db.StickerSet.find({
      ownerTelegramId: sharedUserId
    })

    let chunkedPacks = []
    const chunkSize = 70

    if (findPacks.length > 0) {
      chunkedPacks = (findPacks.map((pack) => {
        if (pack.name.toLowerCase().endsWith('fStikBot'.toLowerCase()) && pack.public !== true) {
          if (
            ctx.from.id === sharedUserId
            || ctx.from.id === ctx.config.mainAdminId
            || ctx?.session?.userInfo?.adminRights.includes('pack')
          ) {
            return `<a href="https://t.me/addstickers/${pack.name}"><s>${pack.name}</s></a>`
          } else {
            return '<i>[hidden]</i>'
          }
        }
        return `<a href="https://t.me/addstickers/${pack.name}">${pack.name}</a>`
      })).reduce((resultArray, item, index) => {
        const chunkIndex = Math.floor(index / chunkSize)

        if (!resultArray[chunkIndex]) {
          resultArray[chunkIndex] = []
        }

        resultArray[chunkIndex].push(item)

        return resultArray
      }, [])
    }

    let packsToReturn

    if (chunkedPacks.length > 0) {
      packsToReturn = chunkedPacks.shift()
    }

    // Save data for "show all packs" button
    const totalPacks = findPacks.length
    if (chunkedPacks.length > 0) {
      ctx.session.showAllPacksData = {
        ownerId: sharedUserId,
        excludeSetId: null
      }
    }

    const keyboard = []
    if (chunkedPacks.length > 0) {
      keyboard.push([Markup.callbackButton(
        ctx.i18n.t('scenes.packAbout.btn.show_all_packs', { count: totalPacks }),
        'show_all_packs'
      )])
    }

    await ctx.replyWithHTML(ctx.i18n.t('userAbout.result', {
      userId: sharedUserId,
      packs: packsToReturn ? packsToReturn.join(', ') : ctx.i18n.t('userAbout.no_packs')
    }), {
      disable_web_page_preview: true,
      ...(keyboard.length > 0 ? Markup.inlineKeyboard(keyboard).extra() : {})
    })
    return
  }
  if (!ctx.message) return

  let sticker

  if (ctx.message.entities && ctx.message.entities[0] && ctx.message.entities[0].type === 'custom_emoji') {
    const customEmoji = ctx.message.entities.find((e) => e.type === 'custom_emoji')

    if (!customEmoji) return

    const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: [customEmoji.custom_emoji_id]
    })

    if (!emojiStickers) return

    sticker = emojiStickers[0]
  } else if (ctx.message.sticker) {
    sticker = ctx.message.sticker
  } else {
    return next()
  }

  if (!sticker) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.not_found'))
  }

  if (!sticker.set_name) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.not_found'))
  }

  const stickerSetInfo = await telegramApi.client.invoke(new telegramApi.Api.messages.GetStickerSet({
    stickerset: new telegramApi.Api.InputStickerSetShortName({
      shortName: sticker.set_name
    }),
    hash: 0
  }))

  if (!stickerSetInfo) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.not_found'))
  }

  const { ownerId, setId } = decodeStickerSetId(stickerSetInfo.set.id.value)

  // find sticker set in database
  let stickerSet = await db.StickerSet.findOne({
    name: sticker.set_name
  })

  if (!stickerSet) {
    stickerSet = await db.StickerSet.create({
      ownerTelegramId: ownerId,
      name: sticker.set_name,
      title: stickerSetInfo.set.title,
      animated: sticker.is_animated,
      video: sticker.is_video,
      packType: sticker.type,
      thirdParty: true,
    })
  }

  const actualOwnerId = stickerSet.ownerTelegramId || ownerId

  // get all stickerset owners from database
  const packs = await db.StickerSet.find({
    ownerTelegramId: actualOwnerId,
    _id: {
      $ne: stickerSet?._id || null
    }
  })

  let chunkedPacks = []
  const chunkSize = 70

  if (packs.length > 0) {
    chunkedPacks = (packs.map((pack) => {
      if (pack.name.toLowerCase().endsWith('fStikBot'.toLowerCase()) && pack.public !== true) {
        if (
          ctx.from.id === actualOwnerId ||
          ctx.from.id === ctx.config.mainAdminId ||
          ctx?.session?.userInfo?.adminRights.includes('pack')
        ) {
          return `<a href="https://t.me/addstickers/${pack.name}"><s>${pack.name}</s></a>`
        } else {
          return `<i>[hidden]</i>`
        }
      }
      return `<a href="https://t.me/addstickers/${pack.name}">${pack.name}</a>`
    })).reduce((resultArray, item, index) => {
      const chunkIndex = Math.floor(index / chunkSize)

      if (!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = []
      }

      resultArray[chunkIndex].push(item)

      return resultArray
    }, [])
  }

  if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  const ownerChat = await ctx.telegram.getChat(actualOwnerId).catch(() => null)

  let mention
  mention = (!ownerChat || ownerChat?.has_private_forwards === true) ? undefined : `<a href="tg://user?id=${actualOwnerId}">${escapeHTML(ownerChat?.first_name) || 'unknown'}</a>`
  if (!mention) mention = `<a href="tg://openmessage?user_id=${actualOwnerId}">[🤖]</a>, <a href="https://t.me/@id${actualOwnerId}">[🍏]</a>`

  let otherPacks

  if (chunkedPacks.length > 0) {
    otherPacks = chunkedPacks.shift()
  }

  // Save sticker for download button
  ctx.session.lastStickerForDownload = {
    file_id: sticker.file_id,
    file_unique_id: sticker.file_unique_id,
    is_video: sticker.is_video,
    is_animated: sticker.is_animated
  }

  // Save data for "show all packs" button
  const totalOtherPacks = packs.length
  if (chunkedPacks.length > 0) {
    ctx.session.showAllPacksData = {
      ownerId: actualOwnerId,
      excludeSetId: stickerSet?._id || null
    }
  }

  // Build keyboard
  const keyboard = [[Markup.callbackButton(ctx.i18n.t('scenes.packAbout.btn.download'), 'download_original')]]
  if (chunkedPacks.length > 0) {
    keyboard.push([Markup.callbackButton(
      ctx.i18n.t('scenes.packAbout.btn.show_all_packs', { count: totalOtherPacks }),
      'show_all_packs'
    )])
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.result', {
    link: `https://t.me/addstickers/${sticker.set_name}`,
    name: escapeHTML(sticker.set_name),
    ownerId: actualOwnerId,
    mention,
    setId,
    otherPacks: otherPacks ? otherPacks.join(', ') : ctx.i18n.t('scenes.packAbout.no_other_packs')
  }), {
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(keyboard).extra()
  })
})

module.exports = packAbout
