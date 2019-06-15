const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const {
  handleStart,
} = require('../handlers')
const { addSticker } = require('../utils')


const newPack = new Scene('newPack')

newPack.enter((ctx) => {
  ctx.session.scane.newPack = {}
  ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_title'), {
    reply_to_message_id: ctx.message.message_id,
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel'),
      ],
    ]).resize(),
  })
})
newPack.on('message', async (ctx) => {
  if (ctx.message.text && ctx.message.text.length <= ctx.config.charTitleMax) {
    ctx.session.scane.newPack.title = ctx.message.text
    ctx.scene.enter('newPackName')
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.title_long', {
      max: ctx.config.charTitleMax,
    }), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
})

const newPackName = new Scene('newPackName')

newPackName.enter((ctx) => ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_name'), {
  reply_to_message_id: ctx.message.message_id,
}))
newPackName.on('message', async (ctx) => {
  if (ctx.message.text && ctx.message.text.length <= ctx.config.charNameMax) {
    if (!ctx.db.user) await ctx.db.User.findOne({ telegram_id: ctx.from.id })

    ctx.session.scane.newPack.name = ctx.message.text

    const nameSuffix = `_by_${ctx.options.username}`
    const titleSuffix = ` by @${ctx.options.username}`

    let { name, title } = ctx.session.scane.newPack

    name += nameSuffix
    if (ctx.db.user.premium !== true) title += titleSuffix

    const createNewStickerSet = await ctx.telegram.createNewStickerSet(ctx.from.id, name, title, {
      png_sticker: { source: 'sticker_placeholder.png' },
      emojis: '🌟',
    }).catch(async (error) => {
      if (error.description === 'Bad Request: sticker set name invalid') {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_invalid'), {
          reply_to_message_id: ctx.message.message_id,
        })
        ctx.scene.reenter()
      }
      else {
        await ctx.replyWithHTML(ctx.i18n.t('error.telegram', {
          error: error.description,
        }), {
          reply_to_message_id: ctx.message.message_id,
        })
        ctx.scene.reenter()
      }
    })

    if (createNewStickerSet) {
      const getStickerSet = await ctx.telegram.getStickerSet(name)
      const stickerInfo = getStickerSet.stickers.slice(-1)[0]

      ctx.telegram.deleteStickerFromSet(stickerInfo.file_id)

      const stickerSet = await ctx.db.StickerSet.newSet({
        owner: ctx.db.user.id,
        name,
        title,
        emojiSuffix: '🌟',
        create: true,
      })

      ctx.db.user.stickerSet = stickerSet.id
      ctx.db.user.save()

      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.ok', {
        title,
        link: `${ctx.config.stickerLinkPrefix}${name}`,
      }), {
        reply_to_message_id: ctx.message.message_id,
      })
      if (ctx.session.scane.copyPack) {
        const originalPack = ctx.session.scane.copyPack

        const message = await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.progress', {
          originalTitle: originalPack.title,
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
          title,
          link: `${ctx.config.stickerLinkPrefix}${name}`,
          already: 0,
          total: originalPack.stickers.length,
        }))

        for (let index = 0; index < originalPack.stickers.length; index++) {
          await addSticker(ctx, originalPack.stickers[index])

          ctx.telegram.editMessageText(
            message.chat.id, message.message_id, null,
            ctx.i18n.t('scenes.copy.progress', {
              originalTitle: originalPack.title,
              originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
              title,
              link: `${ctx.config.stickerLinkPrefix}${name}`,
              already: index,
              total: originalPack.stickers.length,
            }),
            { parse_mode: 'HTML' }
          )
        }

        ctx.telegram.editMessageText(
          message.chat.id, message.message_id, null,
          ctx.i18n.t('scenes.copy.done', {
            originalTitle: originalPack.title,
            originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
            title,
            link: `${ctx.config.stickerLinkPrefix}${name}`,
          }),
          { parse_mode: 'HTML' }
        )

        ctx.scene.leave()
      }
      else ctx.scene.leave()
      handleStart(ctx)
    }
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.title_long', {
      max: ctx.config.charNameMax,
    }), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
})

module.exports = [newPack, newPackName]
