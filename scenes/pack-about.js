const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { telegramApi } = require('../utils')
const {
  db
} = require('../database')

function decodeStickerSetId (u64) {
  let u32 = u64 >> 32n
  let u32l = u64 & 0xffffffffn

  if ((u64 >> 24n & 0xffn) === 0xffn) {
    return {
      ownerId: parseInt((u64 >> 32n) + 0x100000000n),
      setId: null
    }
  }
  return {
    ownerId: parseInt(u32),
    setId: parseInt(u32l)
  }
}

const packAbout = new Scene('packAbout')

packAbout.enter(async (ctx) => {
  await ctx.replyWithHTML('Send me a sticker or a custom emoji', {
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
  const stickerSet = await db.StickerSet.findOne({
    name: sticker.set_name
  })

  if (!stickerSet && sticker.type === 'regular') {
    await db.StickerSet.create({
      ownerTelegramId: ownerId,
      name: sticker.set_name,
      title: stickerSetInfo.set.title,
      animated: sticker.is_animated,
      video: sticker.is_video,
      thirdParty: true,
    })
  } else if (stickerSet && ownerId && ownerId !== stickerSet.ownerTelegramId) {
    await db.StickerSet.updateOne({
      name: sticker.set_name
    }, {
      $set: {
        ownerTelegramId: ownerId
      }
    })
  }

  // get all stickerset owners from database
  const owners = await db.StickerSet.find({
    ownerTelegramId: ownerId,
    _id: {
      $ne: stickerSet._id
    }
  }).limit(100).lean()

  let otherPacks = ''

  if (owners.length > 0) {
    otherPacks = owners.map((owner) => {
      return `<a href="https://t.me/addstickers/${owner.name}">${owner.name}</a>`
    }).join(', ')
  } else {
    otherPacks = ctx.i18n.t('scenes.packAbout.no_other_packs')
  }

  return ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.result', {
    link: `https://t.me/addstickers/${sticker.set_name}`,
    name: sticker.set_name,
    ownerId,
    setId,
    otherPacks
  }))
})

module.exports = packAbout
