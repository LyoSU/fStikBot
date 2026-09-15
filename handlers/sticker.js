const Markup = require('telegraf/markup')
const {
  escapeHTML,
  showGramAds,
  countUncodeChars,
  substrUnicode,
  addSticker,
  addStickerText
} = require('../utils')
const userQueue = require('../utils/user-queue')
const mediaGroup = require('../utils/media-group')
const { waitForJob } = require('../utils/queue-job')
const packLink = require('../utils/pack-link')
const { parseCaption, extractMedia } = require('../utils/sticker-media')
const log = require('../utils/logger').scope('sticker')
const metrics = require('../utils/metrics')
const { failureReason } = require('../utils/failure-reason')
const coedit = require('../utils/coedit')
const handleError = require('./catch')

// Adds for a boosted pack may run side by side ("multiple stickers at once");
// everyone else's files go one at a time, in the order they were sent.
const BOOST_CONCURRENCY = 3
// A free user's next file waits until the converter is done with their video.
const VIDEO_WAIT_MS = 3 * 60 * 1000
// Files sent before any pack existed are added once the user creates or picks
// one — if that happens within this window.
const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_ITEMS = 10
// Stickers-in-pack counts at which an unpublished pack is offered the catalog.
const CATALOG_OFFER_AT = [50, 90]

// A custom emoji arrives as a text message; the file behind it is a sticker.
const resolveCustomEmoji = async (ctx, message) => {
  const entity = message?.entities?.find((e) => e.type === 'custom_emoji')
  if (!entity) return null

  const stickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
    custom_emoji_ids: [entity.custom_emoji_id]
  }).catch(() => null)

  const sticker = stickers?.[0]
  return sticker?.file_unique_id ? { ...sticker, stickerType: 'sticker' } : null
}

// Everything the caption and the target pack change about a file, applied to
// a copy so a pending item can be prepared again for another pack.
const prepareFile = (file, caption, stickerSet) => {
  const prepared = { ...file }

  if (stickerSet.inline) {
    // Inline packs keep the media as-is and search by the caption.
    if (caption) prepared.caption = caption
    prepared.file_unique_id = `${stickerSet.id}_${file.file_unique_id}`
    return prepared
  }

  const { flags, text } = parseCaption(caption)
  if (flags.video_note) prepared.video_note = true
  if (flags.forceCrop) prepared.forceCrop = true
  if (flags.removeBg && prepared.stickerType === 'photo') prepared.removeBg = true
  // A sticker keeps its own emoji; a Tenor caption is the URL, not emoji.
  if (text && prepared.stickerType !== 'sticker' && !prepared.fileUrl) prepared.emoji = text

  return prepared
}

const reply = (ctx, text, replyTo, extra = {}) => ctx.replyWithHTML(text, {
  reply_to_message_id: replyTo,
  allow_sending_without_reply: true,
  disable_web_page_preview: true,
  ...extra
})

// Reactions are a hint only — any failure (old client, reactions disabled) is fine.
const setReaction = (ctx, messageId, emoji) => ctx.telegram.callApi('setMessageReaction', {
  chat_id: ctx.chat.id,
  message_id: messageId,
  reaction: emoji ? [{ type: 'emoji', emoji }] : []
}).catch(() => {})

// Non-boosted packs carry " :: @bot" in the title. Returns the pack as
// Telegram sees it (reused by addSticker as the "before" snapshot), or null.
const syncPackTitle = async (ctx, stickerSet) => {
  const stickerSetInfo = await ctx.telegram.getStickerSet(stickerSet.name).catch(() => null)
  if (!stickerSetInfo) return null

  if (!stickerSet.boost && !stickerSetInfo.title.includes(ctx.options.username)) {
    const titleSuffix = ` :: @${ctx.options.username}`
    let newTitle = stickerSetInfo.title
    if (countUncodeChars(newTitle) > ctx.config.charTitleMax) {
      newTitle = substrUnicode(newTitle, 0, ctx.config.charTitleMax)
    }
    newTitle += titleSuffix

    const renamed = await ctx.telegram.callApi('setStickerSetTitle', {
      name: stickerSet.name,
      title: newTitle
    }).then(() => true).catch((err) => {
      log.warn('setStickerSetTitle failed:', err.description || err.message)
      return false
    })

    if (renamed) {
      stickerSetInfo.title = newTitle
      await ctx.replyWithHTML(ctx.i18n.t('scenes.rename.success', {
        title: escapeHTML(newTitle),
        link: packLink(stickerSet)
      }) + '\n' + ctx.i18n.t('scenes.rename.boost_notice', {
        titleSuffix: escapeHTML(titleSuffix)
      }), { disable_web_page_preview: true })
    }
  }

  if (stickerSet.title !== stickerSetInfo.title) {
    stickerSet.title = stickerSetInfo.title
    await ctx.db.StickerSet.updateOne({ _id: stickerSet._id }, { title: stickerSetInfo.title })
  }

  return stickerSetInfo
}

const trackFailed = (result, count = 1) => {
  metrics.track('sticker_failed', count)
  metrics.track(`sticker_failed_${failureReason(result)}`, count)
}

const findExisting = (ctx, stickerSet, file) => ctx.db.Sticker.findOne({
  stickerSet,
  deleted: false,
  $or: [
    { fileUniqueId: file.file_unique_id },
    { 'original.fileUniqueId': file.file_unique_id },
    { 'file.file_unique_id': file.file_unique_id }
  ]
}).lean()

// One file into the pack. A free user's video holds the queue until the
// converter has finished it, so their files still go one at a time.
const addOne = async (ctx, stickerSet, file, { stickerSetInfo, replyTo }) => {
  const existing = await findExisting(ctx, stickerSet, file)
  if (existing) {
    metrics.track('sticker_duplicate')
    return { error: { type: 'duplicate', sticker: existing } }
  }

  // `track` makes the convert worker count the video's outcome, so
  // video_queued has a matching video_added / video_failed.
  const result = await addSticker(ctx, file, stickerSet, true, { stickerSetInfo, replyToMessageId: replyTo, track: true })
  if (result.ok) metrics.track('sticker_added')
  else if (result.wait) metrics.track('video_queued')
  else trackFailed(result)

  if (result.wait && result.job && !stickerSet.boost) {
    await waitForJob(result.job, VIDEO_WAIT_MS)
  }

  return result
}

const isPackFull = (result) => /TOO_MUCH/.test(result?.error?.telegram?.description || '')

const maybeOfferCatalog = async (ctx, stickerSet, added) => {
  if (added < 1 || stickerSet.inline || stickerSet.public || stickerSet.packType !== 'regular') return

  const count = await ctx.db.Sticker.countDocuments({ stickerSet, deleted: false })
  if (!CATALOG_OFFER_AT.some((mark) => count >= mark && count - added < mark)) return

  await ctx.replyWithHTML(ctx.i18n.t('sticker.add.catalog_offer', {
    title: escapeHTML(stickerSet.title),
    link: packLink(stickerSet)
  }), {
    reply_markup: Markup.inlineKeyboard([
      { ...Markup.callbackButton(ctx.i18n.t('callback.pack.btn.catalog_add'), `catalog:publish:${stickerSet.id}`), style: 'primary' }
    ])
  }).catch(() => {})
}

const rememberSticker = (ctx, sticker) => {
  if (sticker?._id) ctx.session.previousSticker = { id: String(sticker._id) }
}

const addSingle = async (ctx, stickerSet, item, stickerSetInfo) => {
  const result = await addOne(ctx, stickerSet, item.file, { stickerSetInfo, replyTo: item.replyTo })

  // Queued for conversion: the worker replies when the video is ready.
  if (result.wait) return

  rememberSticker(ctx, result.ok?.sticker || result.error?.sticker)

  const { messageText, replyMarkup } = addStickerText(result, ctx.i18n.locale())
  if (messageText) await reply(ctx, messageText, item.replyTo, { reply_markup: replyMarkup })

  if (result.ok) {
    coedit.track(ctx.db, stickerSet, ctx.from, 'add', { count: 1 })
    await maybeOfferCatalog(ctx, stickerSet, 1)
  }
}

// An album gets one progress message and one summary instead of a reply per
// file — ten "Added to pack" messages in a row buried the chat.
const addAlbum = async (ctx, stickerSet, items, stickerSetInfo) => {
  const total = items.length
  metrics.track('album')
  const counts = { added: 0, converting: 0, duplicates: 0, failed: 0 }
  let failReason = null
  let lastSticker = null

  const progress = await reply(ctx, ctx.i18n.t('sticker.add.album_progress', { current: 0, total }), items[0].replyTo)
    .catch(() => null)

  for (const [index, item] of items.entries()) {
    const result = await addOne(ctx, stickerSet, item.file, {
      // The snapshot is only "before" for the first file.
      stickerSetInfo: index === 0 ? stickerSetInfo : null,
      replyTo: item.replyTo
    })

    if (result.ok) {
      counts.added++
      lastSticker = result.ok.sticker
    } else if (result.wait) {
      counts.converting++
    } else if (result.error?.type === 'duplicate') {
      counts.duplicates++
    } else {
      counts.failed++
      if (!failReason) failReason = addStickerText(result, ctx.i18n.locale()).messageText
      // Nothing after this fits either.
      if (isPackFull(result)) {
        // Never attempted, but counted in sticker_received — count them here
        // too, or they vanish from the funnel.
        const skipped = total - index - 1
        if (skipped) trackFailed(result, skipped)
        counts.failed += skipped
        break
      }
    }

    if (progress) {
      await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, null,
        ctx.i18n.t('sticker.add.album_progress', { current: index + 1, total }),
        { parse_mode: 'HTML' }
      ).catch(() => {})
    }
  }

  if (progress) await ctx.telegram.deleteMessage(ctx.chat.id, progress.message_id).catch(() => {})

  rememberSticker(ctx, lastSticker)

  const lines = [ctx.i18n.t('sticker.add.album_done', {
    added: counts.added,
    total,
    title: escapeHTML(stickerSet.title),
    link: packLink(stickerSet)
  })]
  if (counts.converting) lines.push(ctx.i18n.t('sticker.add.album_converting', { count: counts.converting }))
  if (counts.duplicates) lines.push(ctx.i18n.t('sticker.add.album_duplicates', { count: counts.duplicates }))
  if (counts.failed) lines.push(ctx.i18n.t('sticker.add.album_failed', { count: counts.failed }) + '\n' + (failReason || '').trim())

  const button = stickerSet.inline
    ? Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
    : Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `https://${packLink(stickerSet)}`)

  await reply(ctx, lines.join('\n\n'), items[0].replyTo, {
    reply_markup: Markup.inlineKeyboard([button])
  })

  if (counts.added) coedit.track(ctx.db, stickerSet, ctx.from, 'add', { count: counts.added })
  await maybeOfferCatalog(ctx, stickerSet, counts.added)
}

const addItems = async (ctx, stickerSet, items) => {
  const sorted = [...items].sort((a, b) => a.messageId - b.messageId)
  // An album has one caption, on one of its messages; it applies to all.
  const sharedCaption = sorted.find((item) => item.caption)?.caption
  const prepared = sorted.map((item) => ({
    ...item,
    file: prepareFile(item.file, item.caption || sharedCaption, stickerSet)
  }))

  if (ctx.session.userInfo?.locale === 'ru' && !stickerSet.boost) showGramAds(ctx.chat.id)
  ctx.telegram.sendChatAction(ctx.chat.id, 'choose_sticker').catch(() => {})

  const isGroup = ctx.chat.type !== 'private'
  const stickerSetInfo = !isGroup && !stickerSet.inline ? await syncPackTitle(ctx, stickerSet) : null

  if (prepared.length === 1) return addSingle(ctx, stickerSet, prepared[0], stickerSetInfo)
  return addAlbum(ctx, stickerSet, prepared, stickerSetInfo)
}

// Reserve the user's place in the queue now and add once it's their turn.
// `getItems` may resolve later (an album still arriving).
const schedule = (ctx, stickerSet, getItems, replyTo) => {
  let reacted = null

  const queued = userQueue.enqueue(ctx.from.id, async () => {
    if (reacted) await reacted.then(() => setReaction(ctx, replyTo, null))
    try {
      await addItems(ctx, stickerSet, await getItems())
    } catch (err) {
      await handleError(err, ctx).catch((e) => log.error('handleError failed:', e))
    }
  }, { concurrency: stickerSet.boost ? BOOST_CONCURRENCY : 1 })

  if (!queued) {
    metrics.track('queue_full')
    return reply(ctx, ctx.i18n.t('sticker.add.error.queue_full'), replyTo)
  }

  // Waiting behind the user's earlier files — show it was received.
  if (!queued.started) reacted = setReaction(ctx, replyTo, '👀')
}

const rememberPending = (ctx, item) => {
  const pending = ctx.session.pendingStickers
  const fresh = pending && Date.now() - pending.at < PENDING_TTL_MS
  ctx.session.pendingStickers = {
    at: fresh ? pending.at : Date.now(),
    items: [...(fresh ? pending.items : []), item].slice(-MAX_PENDING_ITEMS)
  }
}

/**
 * Add the files a user sent before they had a pack, now that they do.
 * No-op when there is nothing pending (or it went stale).
 */
const flushPendingStickers = (ctx, stickerSet) => {
  const pending = ctx.session.pendingStickers
  ctx.session.pendingStickers = null
  if (!pending || Date.now() - pending.at > PENDING_TTL_MS || !pending.items.length) return
  if (pending.items[0].chatId !== ctx.chat?.id) return

  metrics.track('pending_flushed')
  schedule(ctx, stickerSet, () => pending.items, pending.items[0].replyTo)
}

const replyNoPack = async (ctx, replyTo) => {
  metrics.track('no_pack_prompt')
  const hasPacks = await ctx.db.StickerSet.exists({ owner: ctx.session.userInfo.id, create: true, deleted: { $ne: true } })

  const buttons = [Markup.callbackButton(ctx.i18n.t('cmd.start.btn.new'), 'new_pack:null')]
  if (hasPacks) buttons.push(Markup.callbackButton(ctx.i18n.t('cmd.start.commands.packs'), 'packs:null'))

  return reply(ctx, ctx.i18n.t('sticker.add.error.no_selected_pack'), replyTo, {
    reply_markup: Markup.inlineKeyboard([buttons])
  })
}

const resolveGroupPack = async (ctx, replyTo) => {
  const group = await ctx.db.Group.findOne({ telegram_id: ctx.chat.id }).populate('stickerSet')

  if (!group || !group.stickerSet) {
    await reply(ctx, ctx.i18n.t('sticker.add.error.no_selected_group_pack'), replyTo, {
      reply_markup: Markup.inlineKeyboard([
        Markup.switchToCurrentChatButton(ctx.i18n.t('cmd.packs.select_group_pack'), 'select_group_pack')
      ])
    })
    return null
  }

  if (group.settings?.rights?.add !== 'all') {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null)
    if (!['creator', 'administrator'].includes(member?.status)) {
      await reply(ctx, ctx.i18n.t('sticker.add.error.no_rights'), replyTo)
      return null
    }
  }

  return group.stickerSet
}

module.exports = async (ctx, next) => {
  const isSsCommand = !!ctx.message?.text?.startsWith('/ss')

  if (isSsCommand && !ctx.message.reply_to_message) {
    return reply(ctx, ctx.i18n.t('sticker.add.error.reply'), ctx.message.message_id)
  }

  // Where the media is: the message itself, the message /ss replies to, or
  // the bot's own message under an "Add to pack" button.
  const source = ctx.callbackQuery
    ? ctx.callbackQuery.message
    : (isSsCommand ? ctx.message.reply_to_message : ctx.message)
  const replyTo = (ctx.message || ctx.callbackQuery.message).message_id

  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  let file = extractMedia(source)
  if (!file) file = await resolveCustomEmoji(ctx, source)

  if (!file) {
    // Plain text isn't ours to handle.
    if (!ctx.callbackQuery && !isSsCommand && source?.text) return next()

    if (ctx.chat.type === 'private') {
      return reply(ctx, ctx.i18n.t('sticker.add.error.file_type.unknown'), replyTo)
    }
    return reply(ctx, ctx.i18n.t('sticker.add.quote'), replyTo, {
      reply_markup: Markup.inlineKeyboard([
        Markup.urlButton(ctx.i18n.t('cmd.start.commands.add_to_group'), 'https://t.me/QuotLyBot?startgroup=bot')
      ])
    })
  }

  ctx.replyWithChatAction('upload_document').catch(() => {})
  metrics.track('sticker_received')

  const item = {
    file,
    caption: source.caption,
    replyTo,
    messageId: source.message_id,
    chatId: ctx.chat.id
  }
  const albumId = !ctx.callbackQuery && !isSsCommand && ctx.chat.type === 'private' && source.media_group_id
  const album = albumId ? mediaGroup.collect(`${ctx.chat.id}:${albumId}`, item) : null

  if (ctx.chat.type === 'private') {
    const { stickerSet } = ctx.session.userInfo

    if (!stickerSet) {
      rememberPending(ctx, item)
      if (album && !album.first) return
      return replyNoPack(ctx, replyTo)
    }

    // Someone else's pack: members can be removed or limited at any time.
    if (coedit.idOf(stickerSet.owner) !== coedit.idOf(ctx.session.userInfo)) {
      if (album && !album.first) return
      const access = await coedit.getAccess(ctx, stickerSet)
      if (!coedit.can(access, 'add')) {
        ctx.session.userInfo.stickerSet = null
        return reply(ctx, ctx.i18n.t('coedit.no_access'), replyTo)
      }
    }

    if (album) {
      if (!album.first) return
      return schedule(ctx, stickerSet, () => album.items, replyTo)
    }
    return schedule(ctx, stickerSet, () => [item], replyTo)
  }

  const stickerSet = await resolveGroupPack(ctx, replyTo)
  if (!stickerSet) return

  return schedule(ctx, stickerSet, () => [item], replyTo)
}

module.exports.flushPendingStickers = flushPendingStickers
