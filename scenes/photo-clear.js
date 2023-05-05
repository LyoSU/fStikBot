const Scene = require('telegraf/scenes/base')
const rembg = require('../utils/rembg')
const sharp = require('sharp')

const photoClear = new Scene('photoClear')

photoClear.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.enter'), {
    reply_markup: {
      keyboard: [
        [
          ctx.i18n.t('scenes.btn.cancel')
        ]
      ],
      resize_keyboard: true
    }
  })
})

photoClear.on('photo', async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1]

  const fileLink = await ctx.telegram.getFileLink(photo.file_id)

  const avaibleModels = [
    'silueta',
    // 'isnet-general-use'
  ]

  for (const model of avaibleModels) {
    const { body } = await rembg(fileLink, model)

    if (body) {
      const trimBuffer = await sharp(body)
        .trim()
        .webp()
        .toBuffer()

      ctx.replyWithDocument({
        source: trimBuffer,
        filename: `${model}_${photo.file_unique_id}.webp`
      }, {
        reply_to_message_id: ctx.message.message_id
      })
    }
  }
})

module.exports = photoClear
