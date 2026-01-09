const Scene = require('telegraf/scenes/base')
const Queue = require('bull')
const { showGramAds } = require('../utils')

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

async function getQueuePosition (jobId) {
  const waiting = await videoNoteQueue.getWaiting()
  const index = waiting.findIndex(j => j.id === jobId)
  return {
    position: index + 1,
    total: waiting.length
  }
}

async function processVideo (ctx, fileUrl) {
  ctx.replyWithChatAction('record_video_note')

  if (ctx.session.userInfo?.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  let priority = 10
  if (ctx.i18n.locale() === 'ru') priority = 15

  const job = await videoNoteQueue.add({
    fileUrl: typeof fileUrl === 'string' ? fileUrl : fileUrl.href,
    maxDuration: 60
  }, {
    priority,
    attempts: 1,
    removeOnComplete: true
  })

  // Show initial processing message with queue position
  const { position, total } = await getQueuePosition(job.id)
  const processingMsg = await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.processing', {
    position,
    total: total || 1
  }), {
    reply_to_message_id: ctx.message.message_id
  })

  // Update queue position every 2 seconds
  const updateInterval = setInterval(async () => {
    const { position: newPos, total: newTotal } = await getQueuePosition(job.id)
    if (newPos > 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        null,
        ctx.i18n.t('scenes.videoRound.processing', {
          position: newPos,
          total: newTotal || 1
        }),
        { parse_mode: 'HTML' }
      ).catch(() => {})
    }
  }, 2000)

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timeout')), 1000 * 120)
  })

  const result = await Promise.race([job.finished(), timeoutPromise]).catch(() => ({}))

  // Stop updating and delete processing message
  clearInterval(updateInterval)
  await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {})

  if (result.content) {
    await ctx.replyWithVideoNote({
      source: Buffer.from(result.content, 'base64')
    }, {
      reply_to_message_id: ctx.message.message_id
    }).catch(async (err) => {
      if (err.message?.includes('VOICE_MESSAGES_FORBIDDEN')) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.forbidden'))
      } else {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.error'))
      }
    })
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.error'))
  }
}

videoRound.on(['video', 'video_note', 'animation', 'sticker'], async (ctx) => {
  // Skip non-video stickers
  if (ctx.message.sticker && !ctx.message.sticker.is_video) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.not_video'))
  }

  const video = ctx.message.video || ctx.message.video_note || ctx.message.animation || ctx.message.sticker
  const fileUrl = await ctx.telegram.getFileLink(video.file_id)

  await processVideo(ctx, fileUrl)
})

videoRound.on('document', async (ctx) => {
  const mime = ctx.message.document.mime_type || ''
  // Support: video/*, image/gif, image/webp (animated), image/apng
  const isSupported = mime.startsWith('video/') ||
                      mime === 'image/gif' ||
                      mime === 'image/webp' ||
                      mime === 'image/apng' ||
                      mime === 'image/png' // APNG often detected as png

  if (!isSupported) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.not_video'))
  }

  const fileUrl = await ctx.telegram.getFileLink(ctx.message.document.file_id)

  await processVideo(ctx, fileUrl)
})

module.exports = [videoRound]
