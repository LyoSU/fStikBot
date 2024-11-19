const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const {
  telegramApi,
  moderatePack
} = require('../utils')
const {
  db
} = require('../database')

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
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

packAbout.on(['sticker', 'text'], async (ctx, next) => {
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

  const ownerChat = await ctx.telegram.getChat(actualOwnerId).catch(() => null)

  let mention
  mention = (!ownerChat || ownerChat?.has_private_forwards === true) ? undefined : `<a href="tg://user?id=${actualOwnerId}">${escapeHTML(ownerChat?.first_name) || 'unknown'}</a>`
  if (!mention) mention = `<a href="tg://openmessage?user_id=${actualOwnerId}">[🤖]</a>, <a href="https://t.me/@id${actualOwnerId}">[🍏]</a>`

  let otherPacks

  if (chunkedPacks.length > 0) {
    otherPacks = chunkedPacks.shift()
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.result', {
    link: `https://t.me/addstickers/${sticker.set_name}`,
    name: escapeHTML(sticker.set_name),
    ownerId: actualOwnerId,
    mention,
    setId,
    otherPacks: otherPacks ? otherPacks.join(', ') : ctx.i18n.t('scenes.packAbout.no_other_packs')
  }))

  if (chunkedPacks && chunkedPacks.length > 1) {
    for (let i = 1; i < chunkedPacks.length; i++) {
      await ctx.replyWithHTML(chunkedPacks[i].join(', '))
    }
  }
})

module.exports = packAbout
