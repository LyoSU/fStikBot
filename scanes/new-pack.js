const Stage = require('telegraf/stage')
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const {
  handleStart,
} = require('./../handlers')


const { match } = I18n


const newPack = new Scene('newPack')

newPack.enter((ctx) => {
  ctx.session.newPack = {}
  ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_title'), {
    reply_to_message_id: ctx.message.message_id,
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.new_pack.btn.cancel'),
      ],
    ]).resize(),
  })
})
newPack.on('message', async (ctx) => {
  if (ctx.message.text && ctx.message.text.length <= ctx.config.charTitleMax) {
    ctx.session.newPack.title = ctx.message.text
    ctx.scene.enter('packName')
  }
  else {
    ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.title_long', {
      max: ctx.config.charTitleMax,
    }), {
      reply_to_message_id: ctx.message.message_id,
    })
  }
})

const packName = new Scene('packName')

packName.enter((ctx) => ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_name'), {
  reply_to_message_id: ctx.message.message_id,
}))
packName.on('message', async (ctx) => {
  if (ctx.message.text && ctx.message.text.length <= ctx.config.charNameMax) {
    ctx.session.newPack.name = ctx.message.text

    const nameSufix = `_by_${ctx.options.username}`
    const titleSufix = ` by @${ctx.options.username}`

    const name = ctx.session.newPack.name + nameSufix
    const title = ctx.session.newPack.title + titleSufix

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
        await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.unknown', {
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

      const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })

      const stickerSet = await ctx.db.StickerSet.newSet({
        owner: user.id,
        name,
        title,
        emojiSufix: '🌟',
        create: true,
      })

      user.stickerSet = stickerSet.id
      user.save()

      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.ok', {
        title,
        link: `${ctx.config.stickerLinkPrefix}${name}`,
      }), {
        reply_to_message_id: ctx.message.message_id,
      })
      ctx.scene.leave()
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

const stage = new Stage()

stage.register(newPack, packName)
stage.hears((['/cancel', match('scenes.new_pack.btn.cancel')]), async (ctx) => {
  ctx.session.newPack = null
  await ctx.reply(ctx.i18n.t('scenes.new_pack.leave'), {
    reply_to_message_id: ctx.message.message_id,
  })
  ctx.scene.leave()
  handleStart(ctx)
})
stage.middleware()

module.exports = stage
