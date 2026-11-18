const Scene = require('telegraf/scenes/base')
const { showGramAds } = require('../utils')
const { videoNoteQueue } = require('../utils/queues')
const { runQueueJob } = require('../utils/queue-job')

const TIMEOUT_MS = 2 * 60 * 1000
const POSITION_REFRESH_MS = 5000

const videoRound = new Scene('videoRound')

videoRound.enter(async (ctx) => {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery()
    await ctx.deleteMessage().catch(() => {})
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.enter'), {
    reply_markup: {
      keyboard: [[ctx.i18n.t('scenes.btn.cancel')]],
      resize_keyboard: true
    }
  })
})

// Waiting job ids, in queue order, shared by everyone waiting and read at most
// once per refresh. Each waiter used to load the whole queue, payloads and
// all, every 5 s.
let snapshot = { at: 0, ids: [], pending: null }
const waitingIds = () => {
  if (Date.now() - snapshot.at < POSITION_REFRESH_MS) return Promise.resolve(snapshot.ids)
  if (!snapshot.pending) {
    snapshot.pending = videoNoteQueue.getRanges(['wait', 'paused'], 0, -1, true)
      .then((ids) => { snapshot = { at: Date.now(), ids: ids.map(String), pending: null }; return snapshot.ids })
      .catch(() => { snapshot.pending = null; return snapshot.ids })
  }
  return snapshot.pending
}

const queuePosition = async (jobId) => {
  const ids = await waitingIds()
  return { position: ids.indexOf(String(jobId)) + 1, total: ids.length || 1 }
}

async function processVideo (ctx, fileUrl) {
  ctx.replyWithChatAction('record_video_note').catch(() => {})

  if (ctx.session.userInfo?.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  const replyTo = { reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true }
  let progress = null
  let refresh = null

  const outcome = await runQueueJob(videoNoteQueue, {
    fileUrl: typeof fileUrl === 'string' ? fileUrl : fileUrl.href,
    maxDuration: 60,
    // Nobody waits longer than this: the converter drops the job past it.
    maxAgeMs: TIMEOUT_MS
  }, {
    priority: ctx.i18n.locale() === 'ru' ? 15 : 10,
    timeoutMs: TIMEOUT_MS,
    onQueued: async (job) => {
      const text = async () => ctx.i18n.t('scenes.videoRound.processing', await queuePosition(job.id))
      progress = await ctx.replyWithHTML(await text(), replyTo).catch(() => null)
      if (!progress) return
      refresh = setInterval(async () => {
        await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, null, await text(), { parse_mode: 'HTML' })
          .catch(() => {})
      }, POSITION_REFRESH_MS)
    }
  })

  clearInterval(refresh)
  if (progress) await ctx.telegram.deleteMessage(ctx.chat.id, progress.message_id).catch(() => {})

  if (outcome.error) {
    const key = outcome.error === 'disabled' ? 'scenes.photoClear.error_queue_disabled' : 'scenes.videoRound.error'
    return ctx.replyWithHTML(ctx.i18n.t(key), replyTo)
  }

  await ctx.replyWithVideoNote({ source: Buffer.from(outcome.result.content, 'base64') }, {
    ...replyTo,
    // The circle can go straight into the selected pack as a round video sticker.
    reply_markup: {
      inline_keyboard: [[{ text: ctx.i18n.t('scenes.photoClear.add_to_set_btn'), callback_data: 'add_sticker' }]]
    }
  }).catch((err) => {
    const key = err.message?.includes('VOICE_MESSAGES_FORBIDDEN') ? 'scenes.videoRound.forbidden' : 'scenes.videoRound.error'
    return ctx.replyWithHTML(ctx.i18n.t(key), replyTo)
  })
}

const fileLinkOrReply = async (ctx, fileId) => {
  try {
    return await ctx.telegram.getFileLink(fileId)
  } catch (err) {
    const key = err.message?.includes('file is too big') ? 'file_too_big' : 'error'
    await ctx.replyWithHTML(ctx.i18n.t(`scenes.videoRound.${key}`))
    return null
  }
}

videoRound.on(['video', 'video_note', 'animation', 'sticker'], async (ctx) => {
  if (ctx.message.sticker && !ctx.message.sticker.is_video) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.not_video'))
  }

  const video = ctx.message.video || ctx.message.video_note || ctx.message.animation || ctx.message.sticker
  const fileUrl = await fileLinkOrReply(ctx, video.file_id)
  if (fileUrl) await processVideo(ctx, fileUrl)
})

// Video, GIF and animated images sent as files.
const ANIMATED_DOCUMENT = /^(video\/|image\/(gif|webp|apng|png)$)/

videoRound.on('document', async (ctx) => {
  if (!ANIMATED_DOCUMENT.test(ctx.message.document.mime_type || '')) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.videoRound.not_video'))
  }

  const fileUrl = await fileLinkOrReply(ctx, ctx.message.document.file_id)
  if (fileUrl) await processVideo(ctx, fileUrl)
})

module.exports = [videoRound]
