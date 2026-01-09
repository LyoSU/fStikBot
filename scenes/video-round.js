const Scene = require('telegraf/scenes/base')
const Queue = require('bull')

const videoNoteQueue = new Queue('videoNote', {
  redis: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD
  }
})

const videoRound = new Scene('videoRound')

videoRound.enter(async (ctx) => {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery()
    await ctx.deleteMessage().catch(() => {})
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.enter'), {
    reply_markup: {
      keyboard: [
        [ctx.i18n.t('scenes.btn.cancel')]
      ],
      resize_keyboard: true
    }
  })
})

videoRound.on(['video', 'video_note', 'animation'], async (ctx) => {
  ctx.replyWithChatAction('record_video_note')

  const video = ctx.message.video || ctx.message.video_note || ctx.message.animation

  const fileUrl = await ctx.telegram.getFileLink(video.file_id)

  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('Timeout'))
    }, 1000 * 120) // 2 minutes for video
  })

  const job = await videoNoteQueue.add({
    fileUrl: fileUrl.href || fileUrl,
    maxDuration: 60
  }, {
    attempts: 1,
    removeOnComplete: true
  })

  const result = await Promise.race([job.finished(), timeoutPromise]).catch(err => {
    console.error('videoRound job error:', err.message)
    return { error: err.message }
  })

  console.log('videoRound result:', result ? { hasContent: !!result.content, error: result.error } : 'null')

  if (result.content) {
    await ctx.replyWithVideoNote({
      source: Buffer.from(result.content, 'base64')
    }, {
      reply_to_message_id: ctx.message.message_id
    }).catch(async (err) => {
      console.error('videoRound sendVideoNote error:', err.message)
      await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.error'))
    })
  } else {
    console.error('videoRound no content, result:', JSON.stringify(result))
    await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.error'))
  }
})

videoRound.on('document', async (ctx) => {
  if (!ctx.message.document.mime_type?.startsWith('video/')) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.not_video'))
  }

  ctx.replyWithChatAction('record_video_note')

  const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id)

  const timeoutPromise = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('Timeout'))
    }, 1000 * 120)
  })

  const job = await videoNoteQueue.add({
    fileUrl: fileUrl.href || fileUrl,
    maxDuration: 60
  }, {
    attempts: 1,
    removeOnComplete: true
  })

  const result = await Promise.race([job.finished(), timeoutPromise]).catch(err => {
    console.error('videoRound job error:', err.message)
    return { error: err.message }
  })

  console.log('videoRound result:', result ? { hasContent: !!result.content, error: result.error } : 'null')

  if (result.content) {
    await ctx.replyWithVideoNote({
      source: Buffer.from(result.content, 'base64')
    }, {
      reply_to_message_id: ctx.message.message_id
    }).catch(async (err) => {
      console.error('videoRound sendVideoNote error:', err.message)
      await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.error'))
    })
  } else {
    console.error('videoRound no content, result:', JSON.stringify(result))
    await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.error'))
  }
})

module.exports = [videoRound]
