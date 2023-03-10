const StegCloak = require('stegcloak')
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { generateSlug } = require("random-word-slugs");
const {
  addSticker,
  countUncodeChars,
  substrUnicode,
} = require('../utils')


const stegcloak = new StegCloak(false, false)

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

const newPack = new Scene('newPack')

newPack.enter(async (ctx, next) => {
  ctx.session.scene.newPack = {}

  if (ctx?.message?.text?.match('emoji') || ctx?.callbackQuery?.data?.match('emoji')) {
    ctx.session.scene.newPack.packType = 'custom_emoji'
    return ctx.scene.enter('сhoosePackFormat')
  } else if (ctx?.message?.text?.match('inline') || ctx?.callbackQuery?.data?.match('inline')) {
    ctx.session.scene.newPack.inline = true
    return ctx.scene.enter('newPackTitle')
  } else {
    ctx.session.scene.newPack.packType = 'regular'
    return ctx.scene.enter('сhoosePackFormat')
  }
})
const сhoosePackFormat = new Scene('сhoosePackFormat')

сhoosePackFormat.enter(async (ctx, next) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_format'), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.new_pack.static')
      ],
      [
        ctx.i18n.t('scenes.new_pack.video')
      ],
      [
        ctx.i18n.t('scenes.new_pack.animated')
      ],
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

сhoosePackFormat.on('message', async (ctx) => {
  if (ctx.message.text === ctx.i18n.t('scenes.new_pack.animated')) {
    ctx.session.scene.newPack.animated = true
    return ctx.scene.enter('newPackTitle')
  } else if (ctx.message.text === ctx.i18n.t('scenes.new_pack.video')) {
    ctx.session.scene.newPack.video = true
    return ctx.scene.enter('newPackTitle')
  } else if (ctx.message.text === ctx.i18n.t('scenes.new_pack.static')) {
    ctx.session.scene.newPack.animated = false
    return ctx.scene.enter('newPackTitle')
  } else {
    return ctx.scene.reenter()
  }
})

const newPackTitle = new Scene('newPackTitle')

newPackTitle.enter(async (ctx) => {
  if (!ctx.session.scene.newPack) ctx.session.scene.newPack = {
    animated: ctx.session.scene.copyPack.is_animated,
    video: ctx.session.scene.copyPack.is_video,
  }

  const names = []

  names.push(generateSlug(
    2,
    {
      format: 'title',
      categories: {
        noun: ['animals'],
        adjective: ['appearance', 'color', 'size', 'personality']
      }
    }
  ))

  names.push(generateSlug(
    2,
    {
      format: 'title',
      categories: {
        noun: ['food'],
        adjective: ['taste', 'quantity', 'color', 'size']
      }
    }
  ))

  await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_title'), {
    reply_markup: Markup.keyboard([
      ...names.map((name) => [name]),
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})
newPackTitle.on('text', async (ctx) => {
  let charTitleMax = ctx.session.userInfo.premium ? ctx.config.premiumCharTitleMax : ctx.config.charTitleMax

  let title = ctx.message.text

  if (countUncodeChars(title) > charTitleMax) {
    title = substrUnicode(title, 0, charTitleMax)
  }

  ctx.session.scene.newPack.title = title

  if (ctx.session.scene.newPack.inline) return ctx.scene.enter('newPackConfirm')
  else return ctx.scene.enter('newPackName')
})

const newPackName = new Scene('newPackName')

newPackName.enter((ctx) => ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_name'), {
  reply_to_message_id: ctx.message.message_id,
  allow_sending_without_reply: true
}))

newPackName.on('text', async (ctx) => {
  ctx.session.scene.newPack.name = ctx.message.text

  return ctx.scene.enter('newPackConfirm')
})

const newPackConfirm = new Scene('newPackConfirm')

newPackConfirm.enter(async (ctx, next) => {
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const inline = !!ctx.session.scene?.newPack?.inline

  const nameSuffix = `_by_${ctx.options.username}`
  const titleSuffix = ` :: @${ctx.options.username}`

  let { name, title, animated, video } = ctx.session.scene.newPack

  if (!ctx.session.scene.newPack.inline) {
    name = name.replace(/https/, '')
    name = name.replace(/t.me\/addstickers\//, '')
    name = name.replace(/[^0-9a-z_]/gi, '')
  }

  if (!name) {
    return ctx.scene.enter('newPackName')
  }

  const maxNameLength = 64 - nameSuffix.length

  if (name.length >= maxNameLength) {
    name = name.slice(0, maxNameLength)
  }

  if (!inline) name += nameSuffix
  if (ctx.session.userInfo.premium !== true && !inline) title += titleSuffix

  const placeholder = {
    regular: {
      video: 'sticker_placeholder.webm',
      animated: 'sticker_placeholder.tgs',
      static: 'sticker_placeholder.webp'
    },
    custom_emoji: {
      video: 'emoji_placeholder.webm',
      animated: 'sticker_placeholder.tgs',
      static: 'emoji_placeholder.webp'
    }
  }

  let createNewStickerSet

  const packType = ctx.session.scene.newPack.packType || 'regular'

  if (inline) {
    createNewStickerSet = true
  } else {
    const stickerSetByName = await ctx.db.StickerSet.findOne({ name })

    if (stickerSetByName) {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
      return ctx.scene.enter('newPackName')
    }

    const stickerFormat = animated ? 'animated' : video ? 'video' : 'static'

    const uploadedSticker = await ctx.telegram.callApi('uploadStickerFile', {
      user_id: ctx.from.id,
      sticker_format: stickerFormat,
      sticker: {
        source: placeholder[packType][stickerFormat]
      }
    })

    createNewStickerSet = await ctx.telegram.callApi('createNewStickerSet', {
      user_id: ctx.from.id,
      name,
      title,
      stickers: [
        {
          sticker: uploadedSticker.file_id,
          emoji_list: ['🌟'],
        }
      ],
      sticker_format: stickerFormat,
      sticker_type: packType,
      // needs_repainting: true
    }).catch((error) => {
      console.log(JSON.stringify(error.on.payload))
      return { error }
    })

    if (createNewStickerSet.error) {
      const { error } = createNewStickerSet

      if (error.description === 'Bad Request: invalid sticker set name is specified') {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_invalid'), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
        return ctx.scene.enter('newPackName')
      } else if (error.description === 'Bad Request: sticker set name is already occupied') {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
        return ctx.scene.enter('newPackName')
      } else {
        await ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
          error: error.description
        }), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
        return ctx.scene.enter('newPackName')
      }
    }
  }

  if (createNewStickerSet) {
    if (!inline) {
      setTimeout(async () => {
        const getStickerSet = await ctx.telegram.getStickerSet(name)
        const stickerInfo = getStickerSet.stickers[0]
        if (!stickerInfo) return

        await ctx.telegram.deleteStickerFromSet(stickerInfo.file_id).catch(error => {
          console.error('Error while deleting sticker from set: ', error)
        }).then(result => {
          console.log('Sticker deleted from set: ', result)
        })
      }, 1000 * 10)
    }

    const userStickerSet = await ctx.db.StickerSet.newSet({
      owner: ctx.session.userInfo.id,
      name,
      title,
      animated,
      inline,
      video,
      packType,
      emojiSuffix: '🌟',
      create: true
    })

    ctx.session.userInfo.stickerSet = userStickerSet

    if (inline) {
      ctx.session.userInfo.inlineStickerSet = userStickerSet
      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_inline_pack', {
        title: escapeHTML(userStickerSet.title),
        botUsername: ctx.options.username
      }), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
        reply_markup: Markup.inlineKeyboard([
          Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
        ])
      })
    } else {
      let searchGifBtn = []

      if(userStickerSet.video) {
        let inlineData = ''
        if (ctx.session.userInfo.inlineType === 'packs') {
          inlineData = stegcloak.hide('{gif}', '', ' : ')
        }

        searchGifBtn = [Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.btn.search_gif'), inlineData)]
      }


      let format = 'static'
      if (userStickerSet.animated) format = 'animated'
      if (userStickerSet.video) format = 'video'

      const linkPrefix = userStickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

      await ctx.replyWithHTML(ctx.i18n.t(`callback.pack.set_pack.${format}`, {
        title: escapeHTML(userStickerSet.title),
        link: `${linkPrefix}${name}`
      }), {
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `${linkPrefix}${userStickerSet.name}`)
          ],
          searchGifBtn
        ]),
        parse_mode: 'HTML'
      })
    }

    if (!ctx.session.scene.copyPack) {
      if (video) {
        return ctx.scene.enter('packFrame')
      } else {
        await ctx.replyWithHTML('👌', {
          reply_markup: {
            remove_keyboard: true
          }
        })

        return ctx.scene.leave()
      }
    }

    const originalPack = ctx.session.scene.copyPack

    const message = await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.progress', {
      originalTitle: originalPack.title,
      originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
      title: escapeHTML(title),
      link: `${ctx.config.stickerLinkPrefix}${name}`,
      current: 0,
      total: originalPack.stickers.length
    }))

    for (let index = 0; index < originalPack.stickers.length; index++) {
      await addSticker(ctx, originalPack.stickers[index])

      await ctx.telegram.editMessageText(
        message.chat.id, message.message_id, null,
        ctx.i18n.t('scenes.copy.progress', {
          originalTitle: originalPack.title,
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
          title: escapeHTML(title),
          link: `${ctx.config.stickerLinkPrefix}${name}`,
          current: index,
          total: originalPack.stickers.length
        }),
        { parse_mode: 'HTML' }
      ).catch(() => { })
    }

    await ctx.telegram.editMessageText(
      message.chat.id, message.message_id, null,
      ctx.i18n.t('scenes.copy.done', {
        originalTitle: originalPack.title,
        originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
        title: escapeHTML(title),
        link: `${ctx.config.stickerLinkPrefix}${name}`
      }),
      { parse_mode: 'HTML' }
    )

    await ctx.replyWithHTML('👌', {
      reply_markup: {
        remove_keyboard: true
      }
    })

    await ctx.scene.leave()
  }
})

module.exports = [
  newPack,
  сhoosePackFormat,
  newPackTitle,
  newPackName,
  newPackConfirm
]
