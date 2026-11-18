// Results of the video converter (convertQueue): the sticker it made goes into
// the pack and the user gets the answer. Listens on the queue's global events
// from the moment it is required (utils/add-sticker.js requires it).
const path = require('path')
const I18n = require('telegraf-i18n')
const { db } = require('../database')
const config = require('../config.json')
const addStickerText = require('./add-sticker-text')
const telegram = require('./telegram')
const { convertQueue } = require('./queues')
const { logError } = require('./error-line')
const { convertFailure, jobFields } = require('./video-convert-rules')
const escapeHTML = require('./html-escape')
const log = require('./logger').scope('add-sticker')
const coedit = require('./coedit')
const metrics = require('./metrics')
const { failureReason } = require('./failure-reason')
const inflight = require('./inflight-adds')
const { uploadSticker } = require('./sticker-upload')

// This bot's id, straight from the token (`<id>:<secret>`). The convert queue's
// global:* events fire in every process attached to the queue, so each handler
// skips jobs enqueued by another bot. It used to come from a getMe() at module
// load with no .catch — a Telegram hiccup at boot became an unhandled rejection.
const BOT_ID = parseInt(String(process.env.BOT_TOKEN || '').split(':')[0], 10) || null
const isForeignJob = (input) => !!(input.botId && BOT_ID && input.botId !== BOT_ID)

// The outcome of a conversion the sticker handler counted as video_queued.
// Copies and restores also convert but are not in that funnel (no `tracked`).
const trackVideo = (input, result) => {
  if (!input.tracked) return
  if (result?.ok) return metrics.track('video_added')
  metrics.track('video_failed')
  metrics.track(`video_failed_${failureReason(result)}`)
}

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

// Update queue position messages when jobs complete (event-driven, not polling)
//
// Bounded on both axes: at most one pass every QUEUE_MESSAGE_THROTTLE_MS and at
// most QUEUE_MESSAGE_MAX edits per pass. With 200 waiting jobs the unbounded
// version issued up to 200 editMessageText per completed job and 429'd itself.
const QUEUE_MESSAGE_THROTTLE_MS = 3000
const QUEUE_MESSAGE_MAX = 20
let lastQueueMessageUpdate = 0

async function updateConvertQueueMessages () {
  const now = Date.now()
  if (now - lastQueueMessageUpdate < QUEUE_MESSAGE_THROTTLE_MS) return
  lastQueueMessageUpdate = now

  try {
    const waiting = await convertQueue.getWaiting()

    const limit = Math.min(waiting.length, QUEUE_MESSAGE_MAX)

    for (let i = 0; i < limit; i++) {
      const job = waiting[i]
      if (job?.data?.input?.convertingMessageId) {
        const { input } = job.data
        // Message ids are per chat; editing another bot's (chat, message)
        // pair could hit one of this bot's own messages.
        if (isForeignJob(input)) continue

        await telegram.editMessageText(input.chatId, input.convertingMessageId, null, i18n.t(input.locale || 'en', 'sticker.add.converting_process', {
          progress: i + 1,
          total: waiting.length
        }), {
          parse_mode: 'HTML'
        }).catch(() => {})
      }
    }
  } catch (err) {
    console.error('updateConvertQueueMessages error:', err.message)
  }
}

// A finished job adds its sticker and frees a slot, which moves every waiting
// job up — so that's also the only moment queue positions are refreshed.
convertQueue.on('global:completed', (jobId, result) => {
  handleConvertCompleted(jobId, result).catch((err) => {
    console.error('convertQueue global:completed handler failed:', err?.stack || err)
  })
  updateConvertQueueMessages().catch((err) => console.error('updateConvertQueueMessages error:', err.message))
})

async function handleConvertCompleted (jobId, result) {
  const seen = {}
  try {
    await finishConvertedAdd(jobId, result, seen)
  } finally {
    // The (pack, file) claim from handlers/sticker.js ends with the job,
    // whatever the outcome — a throw midway included.
    if (seen.input?.claimKey && !isForeignJob(seen.input)) inflight.release(seen.input.claimKey)
  }
}

// global:completed reaches every process on this queue. isForeignJob tells
// another bot's jobs apart, but during a deploy the old and the new container
// are the same bot and both used to add the sticker. The first to set this key
// handles the job. A Redis error lets the job through: a rare duplicate beats
// a sticker that is never added.
const DONE_KEY_TTL_S = 24 * 60 * 60
const takeJob = (jobId) => convertQueue.client
  .set(`fstik:convert-done:${jobId}`, String(process.pid), 'EX', DONE_KEY_TTL_S, 'NX')
  .then((ok) => ok === 'OK')
  .catch((err) => {
    log.warn(`convert job ${jobId}: done-key check failed, handling it anyway:`, err.message)
    return true
  })

// `seen.input` is set as soon as the job input is known, so the caller can
// release its claim even when this throws.
async function finishConvertedAdd (jobId, result, seen = {}) {
  let parsed
  try {
    parsed = JSON.parse(result)
  } catch (err) {
    console.error('convertQueue global:completed: bad payload:', err.message)
    return
  }

  const { input, metadata, content } = parsed

  if (!input) return

  // global:* fires in EVERY process attached to this Redis queue. Without this
  // guard each replica ran uploadSticker for the same job — double adds and
  // duplicate failure replies.
  if (isForeignJob(input)) return
  seen.input = input
  if (!await takeJob(jobId)) return

  const stickerExtra = input.stickerExtra

  // Handle case when conversion failed (no metadata/content)
  if (!metadata || !content) {
    log.warn(`convert job ${jobId} finished without output`)
    trackVideo(input, { error: { i18nKey: 'sticker.add.error.convert' } })
    if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.convert'), replyExtra(input)).catch(() => {})
    return
  }

  stickerExtra.sticker = {
    source: Buffer.from(content, 'base64')
  }

  // input.stickerSet is a plain object here — Bull serialized the job to JSON
  // in Redis, so it lost its Mongoose document methods (e.g. .save()) that
  // uploadSticker relies on. Re-fetch the live document before calling it.
  const stickerSet = await db.StickerSet.findById(input.stickerSet._id)

  if (!stickerSet) {
    trackVideo(input, { error: { i18nKey: 'pack_deleted' } })
    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'sticker.add.error.convert'), replyExtra(input)).catch(() => {})
    return
  }

  // Uploads go out as the owner (input.userId); a co-editor's access was
  // checked at enqueue, and the conversion may have taken minutes since.
  const byMember = input.chatId > 0 && input.actor && input.actor.id !== input.userId
  if (byMember && !await coedit.canStillAdd(db, stickerSet, input.actor.id)) {
    if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})
    await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', 'coedit.no_access'), replyExtra(input)).catch(() => {})
    return
  }

  let uploadResult
  try {
    // The set as it was before this add: tells our sticker apart from one a
    // sibling job added meanwhile, and lets a 5xx on the add be checked
    // against the set instead of reported as a failure the user then resends.
    const before = stickerSet.create === false
      ? null
      : await telegram.getStickerSet(stickerSet.name).catch(() => null)
    uploadResult = await uploadSticker(input.userId, stickerSet, input.stickerFile, stickerExtra, before?.stickers)
  } catch (err) {
    // A Mongo or network throw here used to escape to the event listener's
    // .catch: the "converting" message stayed forever and the user never got
    // a reply. Report it as a conversion failure instead.
    log.error('convert upload failed:', err?.stack || err)
    uploadResult = { error: { i18nKey: 'sticker.add.error.convert' } }
  } finally {
    if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})
  }

  trackVideo(input, uploadResult)
  if (uploadResult?.ok && input.actor) coedit.track(db, stickerSet, input.actor, 'add', { count: 1 })

  if (input.showResult) {
    const textResult = addStickerText(uploadResult, input.locale || 'en', {
      userId: input.actor?.id || input.userId,
      where: 'queue:convert:add',
      private: input.chatId > 0,
      format: input.stickerExtra?.sticker_format
    })

    if (textResult.messageText) {
      await telegram.sendMessage(input.chatId, textResult.messageText, {
        ...replyExtra(input),
        reply_markup: textResult.replyMarkup
      }).catch((err) => console.error('convert result reply failed:', err.message))
    }
  }
}

// Worker results reply to the message that sent the video: with several videos
// converting, a bare "Added" didn't say which one it was about.
function replyExtra (input) {
  return {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(input.replyToMessageId
      ? { reply_to_message_id: input.replyToMessageId, allow_sending_without_reply: true }
      : {})
  }
}

convertQueue.on('global:failed', (jobId, errorData) => {
  handleConvertFailed(jobId, errorData).catch((err) => {
    logError(err, { where: 'queue:convert:failed_handler' })
  })
})

async function handleConvertFailed (jobId, errorData) {
  const job = await convertQueue.getJob(jobId)
  if (!job) return

  const { input } = job.data || {}
  if (!input) return

  // Same reason as global:completed — one owner per job, or every replica
  // messages the user.
  if (isForeignJob(input)) return
  inflight.release(input.claimKey)
  if (!await takeJob(jobId)) return

  // A job that waited too long is load, not the video: no message to the log
  // chat for it, the JSON line is the record (a burst used to post hundreds).
  const failure = convertFailure(errorData)

  logError(String(errorData), {
    kind: 'queue_failed',
    where: 'queue:convert',
    level: failure.level,
    fields: { code: failure.code, ...jobFields(job) }
  })

  if (input.convertingMessageId) await telegram.deleteMessage(input.chatId, input.convertingMessageId).catch(() => {})

  trackVideo(input, { error: { i18nKey: failure.metric } })

  if (failure.logChat) {
    await telegram.sendMessage(config.logChatId, `<b>Convert error</b>\n\n<code>${escapeHTML(JSON.stringify(errorData))}</code>`, {
      parse_mode: 'HTML'
    }).catch(() => {})
  }

  await telegram.sendMessage(input.chatId, i18n.t(input.locale || 'en', failure.i18nKey), replyExtra(input)).catch(() => {})

  await job.remove().catch(() => {})
}

module.exports = { handleConvertCompleted, handleConvertFailed, isForeignJob }
