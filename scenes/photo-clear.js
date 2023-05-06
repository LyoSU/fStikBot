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
  const args = ctx.message.text.split(' ')

  if (args[1]) {
    ctx.session.clerType = args[1]
  } else {
    ctx.session.clerType = 'silueta'
  }

  await ctx.replyWithHTML(ctx.i18n.t(`scenes.photoClear.${ctx.session.clerType === 'anime' ? 'enter_anime' : 'enter'}`), {
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

  let model = 'silueta'
  if (ctx.session.clerType === 'anime') {
    model = 'anime-seg'
  } else if (ctx.session.clerType === 'general') {
    model = 'isnet-general-use'
  }

  let priority = 10
  if (ctx.session.userInfo.premium) priority = 5
  else if (ctx.i18n.locale() === 'ru') priority = 15

  const job = await removebgQueue.add({
    fileUrl,
    model
  }, {
    priority,
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
})

module.exports = photoClear
