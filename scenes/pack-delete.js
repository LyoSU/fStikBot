const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { match } = require('telegraf-i18n')
const { escapeHTML } = require('../utils')

const packDelete = new Scene('packDelete')

packDelete.enter(async (ctx) => {
  const stickerSet = await ctx.db.StickerSet.findById(ctx.match[1])

  if (!stickerSet) return ctx.answerCbQuery('Error')

  if (stickerSet.owner.toString() !== ctx.session.userInfo.id.toString()) {
    await ctx.answerCbQuery(ctx.i18n.t('Access denied'), true)
    return ctx.scene.leave()
  }

  await ctx.deleteMessage().catch(() => {})

  ctx.session.scene = {
    id: 'packDelete',
    data: {
      id: stickerSet._id,
      name: stickerSet.name
    }
  }

  const linkPrefix = stickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

  await ctx.replyWithHTML(ctx.i18n.t('scenes.delete_pack.enter', {
    link: `${linkPrefix}${stickerSet.name}`,
    title: escapeHTML(stickerSet.title),
    confirm: ctx.i18n.t('scenes.delete_pack.confirm')
  }), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

packDelete.hears(match('scenes.delete_pack.confirm'), async (ctx) => {
  const result = await ctx.telegram.callApi('deleteStickerSet', {
    name: ctx.session.scene.data.name
  }).catch(error => { return { error } })

  if (result.error) {
    if (result.error.message.includes('STICKERSET_INVALID')) {
      await ctx.db.StickerSet.deleteOne({
        _id: ctx.session.scene.data.id
      })

      return ctx.replyWithHTML(ctx.i18n.t('scenes.delete_pack.success'), {
        reply_markup: Markup.removeKeyboard()
      })
    } else {
      throw result.error
    }
  }

  if (!result) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.delete_pack.error'), {
      reply_markup: Markup.keyboard([
        [
          ctx.i18n.t('scenes.btn.cancel')
        ]
      ]).resize()
    })
  }

  await ctx.db.StickerSet.updateOne({
    _id: ctx.session.scene.data.id
  }, {
    deleted: true
  })

  await ctx.replyWithHTML(ctx.i18n.t('scenes.delete_pack.success'), {
    reply_markup: Markup.removeKeyboard()
  })
})

module.exports = packDelete
