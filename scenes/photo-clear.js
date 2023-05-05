const Scene = require('telegraf/scenes/base')
const sharp = require('sharp')
const Queue = require('bull')

const removebgQueue = new Queue('removebg', {
  redis: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD
  }
})

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

  const fileUrl = await ctx.telegram.getFileLink(photo.file_id)

  const avaibleModels = [
    'silueta',
    // 'isnet-general-use'
  ]

  for (const model of avaibleModels) {
    const job = await removebgQueue.add({
      fileUrl,
      model
    }, {
      attempts: 1,
      removeOnComplete: true
    })

    const { content } = await job.finished()

    if (content) {
      const trimBuffer = await sharp(Buffer.from(content, 'base64'))
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
