const crypto = require('crypto')
const got = require('got')
const slug = require('limax')
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const { generateStrings } = require('sticker-pack-names')

const { sendBanner } = require('../banners')
const {
  escapeHTML,
  addSticker,
  countUncodeChars,
  substrUnicode
} = require('../utils')
const packLink = require('../utils/pack-link')
const { humanizeTelegramError } = require('../utils/telegram-error')
const { runInCopyScope } = require('../utils/retry-api')
const { removePlaceholderIfPending } = require('../utils/placeholder')
const { sendPackMenu } = require('../handlers/pack-menu')
const { flushPendingStickers } = require('../handlers/sticker')
const log = require('../utils/logger').scope('pack-new')
const metrics = require('../utils/metrics')

const { match } = I18n

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A copy is done strictly one sticker at a time, in original order: that's
// the only way the copy mirrors the source ordering (a parallel/bulk pass
// reorders any sticker that has to be re-added) and it keeps us under
// Telegram's per-user sticker limit. COPY_PACE_MS is the gap between
// stickers; on a 429 the copy-scope policy simply waits out Telegram's
// retry_after and continues, so the copy completes instead of erroring out.
const COPY_PACE_MS = parseInt(process.env.COPY_PACE_MS, 10) || 1000

// createNewStickerSet takes at most 50 stickers.
const SEED_BATCH = 50

const placeholder = {
  regular: 'sticker_placeholder.webm',
  custom_emoji: 'emoji_placeholder.webm'
}

// Resolve the placeholder's *canonical* file_unique_id — the one Telegram
// reports via getStickerSet, NOT the one uploadStickerFile returns.
//
// These two are DIFFERENT strings for the same sticker (an uploaded file and
// the sticker it becomes inside a set are distinct objects). removePlaceholder-
// IfPending matches the marker against getStickerSet's stickers, so the marker
// must hold the getStickerSet value or it never matches. Right after
// createNewStickerSet the set holds exactly the placeholder at index 0.
//
// A freshly created set isn't always visible to getStickerSet on the very first
// read (Telegram-side propagation lag), so retry a few times with a short
// backoff. Returns null only if the set never materialises in time — the
// placeholder then just isn't auto-removed.
const resolvePlaceholderUniqueId = async (ctx, name) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const set = await ctx.telegram.getStickerSet(name).catch(() => null)
    const uniqueId = set?.stickers?.[0]?.file_unique_id
    if (uniqueId) return uniqueId
    await delay(500)
  }
  log.error(`placeholder unique id unresolved for ${name}; placeholder will not be auto-removed`)
  return null
}

// Download a source sticker and re-upload it via uploadStickerFile,
// returning the InputSticker entry ({ sticker: file_id, format, emoji_list })
// or null if it couldn't be fetched/uploaded. Runs in copy scope, so a 429
// is waited out rather than failed fast.
const uploadSourceSticker = async (ctx, sticker, onWait) => {
  let stickerFormat = 'static'
  if (sticker.is_animated) stickerFormat = 'animated'
  else if (sticker.is_video) stickerFormat = 'video'

  let fileLink
  try {
    fileLink = await ctx.telegram.getFileLink(sticker.file_id)
  } catch (err) {
    log.error('copy: getFileLink failed:', err.message)
    return null
  }

  const buffer = await got(fileLink, { responseType: 'buffer' })
    .then((response) => response.body)
    .catch(() => null)
  if (!buffer) return null

  const uploaded = await runInCopyScope(() => ctx.telegram.callApi('uploadStickerFile', {
    user_id: ctx.from.id,
    sticker_format: stickerFormat,
    sticker: { source: buffer }
  }), { onWait }).catch((error) => ({ error }))

  if (!uploaded || uploaded.error) return null

  return {
    sticker: uploaded.file_id,
    format: stickerFormat,
    emoji_list: sticker.emojis ? sticker.emojis : [sticker.emoji]
  }
}

// A pack's short name: Latin letters, digits and "_", starting with a letter.
const normalizeName = (raw) => {
  const name = slug(
    String(raw || '')
      .replace(/https?:\/\//, '')
      .replace(/t\.me\/add(stickers|emoji)\//, ''),
    { separator: '_', maintainCase: true }
  )
  return name
    .replace(/[^0-9a-z_]/gi, '')
    .replace(/_{2,}/g, '_')
    .replace(/^[^a-z]+/i, '')
    .replace(/_+$/, '')
}

const fitName = (name, suffix) => name.slice(0, 64 - suffix.length).replace(/_+$/, '')

// Names to try for a pack the user didn't name: the title itself, then the
// title with a short random tail. The "type a Latin link" step was where most
// people gave up on /new — a custom link is now an optional button.
const autoNameCandidates = (title, suffix) => {
  const base = fitName(normalizeName(title) || 'stickers', suffix + '_xxxx')
  const tail = () => crypto.randomBytes(2).toString('hex')
  return [base, `${base}_${tail()}`, `${base}_${tail()}`].map((name) => name + suffix)
}

const NAME_REJECTED = /STICKERSET_INVALID|name is already occupied|invalid sticker set name/i

const cancelButton = (ctx) => ({ text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' })

const buyCreditsKeyboard = (ctx) => Markup.inlineKeyboard([
  { ...Markup.callbackButton(ctx.i18n.t('scenes.boost.btn.buy'), 'donate:topup'), style: 'success' }
])

const replyTo = (ctx) => ({
  reply_to_message_id: ctx.message?.message_id,
  allow_sending_without_reply: true
})

// A reply keyboard can only be removed by a message; one that disappears
// right away leaves just the menu that follows it.
const removeReplyKeyboard = async (ctx) => {
  const message = await ctx.reply('👌', { reply_markup: { remove_keyboard: true } }).catch(() => null)
  if (message) await ctx.telegram.deleteMessage(ctx.chat.id, message.message_id).catch(() => {})
}

// Everything after the first slow call may run when the user has already moved
// on (/cancel, another command or a new wizard replace session.scene), so the
// wizard only cleans up after itself while it is still the current one.
const wizardOf = (ctx) => ctx.session.scene?.newPack

const abandon = async (ctx, newPack) => {
  if (wizardOf(ctx) !== newPack) return
  ctx.session.scene = {}
  await removeReplyKeyboard(ctx)
  return ctx.scene.leave()
}

const newPack = new Scene('newPack')

newPack.enter(async (ctx) => {
  if (!ctx.session.scene) ctx.session.scene = {}

  // Start from a clean slate every time: leftovers from an abandoned wizard
  // used to bleed into the next run. Everything this run needs comes via
  // ctx.scene.state.
  const enterState = ctx.scene.state || {}
  ctx.session.scene.newPack = { ...(enterState.newPack || {}) }
  if (enterState.copyPack) ctx.session.scene.copyPack = enterState.copyPack
  else delete ctx.session.scene.copyPack
  if (!enterState.chooseType) metrics.track(enterState.copyPack ? 'copy_started' : 'new_pack_started')

  const args = ctx.message?.text?.split(' ') || []
  if (['fill', 'adaptive'].includes(args[1])) ctx.session.scene.newPack.fillColor = true

  if (ctx.session.scene.newPack.inline) return ctx.scene.enter('newPackTitle')

  // A copy keeps the source's type unless the user asks to change it.
  if (ctx.session.scene.copyPack && !enterState.chooseType) return ctx.scene.enter('newPackTitle')

  await sendBanner(ctx, 'new-pack', ctx.i18n.t('scenes.new_pack.pack_type'), {
    reply_markup: Markup.keyboard([
      [{ text: ctx.i18n.t('scenes.new_pack.regular'), style: 'primary' }],
      [{ text: ctx.i18n.t('scenes.new_pack.custom_emoji'), style: 'primary' }],
      [{ text: ctx.i18n.t('scenes.new_pack.custom_emoji_adaptive'), style: 'primary' }],
      [cancelButton(ctx)]
    ]).resize()
  })
})

newPack.on('message', async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  const { text } = ctx.message
  const { newPack } = ctx.session.scene

  if (text === ctx.i18n.t('scenes.new_pack.custom_emoji_adaptive')) {
    newPack.packType = 'custom_emoji'
    newPack.fillColor = true
  } else if (text === ctx.i18n.t('scenes.new_pack.custom_emoji')) {
    newPack.packType = 'custom_emoji'
    newPack.fillColor = false
  } else if (text === ctx.i18n.t('scenes.new_pack.regular')) {
    newPack.packType = 'regular'
    newPack.fillColor = false
  } else {
    return ctx.scene.reenter()
  }

  const { copyPack } = ctx.session.scene
  if (copyPack && copyPack.sticker_type !== newPack.packType) return ctx.scene.enter('newPackCopyPay')

  return ctx.scene.enter('newPackTitle')
})

const newPackCopyPay = new Scene('newPackCopyPay')

newPackCopyPay.enter(async (ctx) => {
  const { balance } = ctx.session.userInfo
  const text = ctx.i18n.t('scenes.copy.pay', { balance })

  if (balance < 1) {
    return ctx.replyWithHTML(text, { reply_markup: buyCreditsKeyboard(ctx) })
  }

  await ctx.replyWithHTML(text, {
    reply_markup: Markup.keyboard([
      [{ text: ctx.i18n.t('scenes.copy.pay_btn'), style: 'primary' }],
      [cancelButton(ctx)]
    ]).resize()
  })
})

newPackCopyPay.hears(match('scenes.copy.pay_btn'), (ctx) => ctx.scene.enter('newPackTitle'))

const newPackTitle = new Scene('newPackTitle')

newPackTitle.enter(async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  const { newPack, copyPack } = ctx.session.scene

  const suggestions = generateStrings({ count: 3 })
  let text = ctx.i18n.t('scenes.new_pack.pack_title')

  if (copyPack) {
    // The source's own title is the most likely choice for a copy.
    const sourceTitle = copyPack.title.replace(/ :: @\w+$/, '')
    suggestions.unshift(substrUnicode(sourceTitle, 0, ctx.config.charTitleMax))
    suggestions.length = 3
    text = ctx.i18n.t('scenes.copy.title', {
      originalTitle: escapeHTML(copyPack.title),
      originalLink: packLink(copyPack),
      count: copyPack.stickers.length
    })
  }

  const keyboard = suggestions.map((name) => [name])
  if (!newPack.inline) keyboard.push([ctx.i18n.t('scenes.new_pack.btn.custom_link')])
  if (copyPack) keyboard.push([ctx.i18n.t('scenes.copy.btn.change_type')])
  keyboard.push([cancelButton(ctx)])

  await ctx.replyWithHTML(text, {
    disable_web_page_preview: true,
    reply_markup: Markup.keyboard(keyboard).resize()
  })
})

newPackTitle.hears(match('scenes.new_pack.btn.custom_link'), (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  ctx.session.scene.newPack.wantsCustomName = true
  return ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.custom_link_on'))
})

newPackTitle.hears(match('scenes.copy.btn.change_type'), (ctx) => {
  const { newPack, copyPack } = ctx.session.scene || {}
  if (!copyPack) return ctx.scene.leave()
  return ctx.scene.enter('newPack', { copyPack, newPack: { fillColor: newPack?.fillColor }, chooseType: true })
})

newPackTitle.on('text', async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  const { newPack } = ctx.session.scene

  let title = ctx.message.text
  if (countUncodeChars(title) > ctx.config.charTitleMax) {
    title = substrUnicode(title, 0, ctx.config.charTitleMax)
  }
  newPack.title = title

  if (newPack.wantsCustomName) return ctx.scene.enter('newPackName')
  return ctx.scene.enter('newPackConfirm')
})

const newPackName = new Scene('newPackName')

newPackName.enter((ctx) => ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_name'), {
  ...replyTo(ctx),
  disable_web_page_preview: true,
  reply_markup: Markup.keyboard([[cancelButton(ctx)]]).resize()
}))

newPackName.on('text', (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.enter('newPack')
  ctx.session.scene.newPack.name = ctx.message.text
  return ctx.scene.enter('newPackConfirm')
})

// createNewStickerSet under the first name Telegram accepts. For a pack the
// user named that's their name or nothing.
const createSet = async (ctx, { names, title, packType, fillColor, stickers, copy }) => {
  let lastError = null

  for (const name of names) {
    if (await ctx.db.StickerSet.exists({ name })) {
      lastError = { description: 'Bad Request: sticker set name is already occupied' }
      continue
    }

    const call = () => ctx.telegram.callApi('createNewStickerSet', {
      user_id: ctx.from.id,
      name,
      title,
      stickers,
      sticker_type: packType,
      needs_repainting: !!fillColor
    })
    const created = await (copy ? runInCopyScope(call) : call()).then(() => true).catch((error) => {
      lastError = error
      return false
    })

    if (created) return { name }
    if (!NAME_REJECTED.test(lastError?.description || '')) break
  }

  return { error: lastError || {} }
}

// Tell the user why creating failed, and where to go from here.
const handleCreateError = async (ctx, error, { customName, newPack }) => {
  const description = error?.description || ''

  if (NAME_REJECTED.test(description)) {
    const key = /invalid/i.test(description)
      ? 'scenes.new_pack.error.telegram.name_invalid'
      : 'scenes.new_pack.error.telegram.name_occupied'
    await ctx.replyWithHTML(ctx.i18n.t(key), replyTo(ctx))
    // Even the generated names were refused — let the user pick one.
    return ctx.scene.enter('newPackName')
  }

  await ctx.replyWithHTML(humanizeTelegramError(ctx, error), replyTo(ctx))
  if (customName) return ctx.scene.enter('newPackName')
  return abandon(ctx, newPack)
}

const uploadPlaceholder = (ctx, packType, copy) => {
  const call = () => ctx.telegram.callApi('uploadStickerFile', {
    user_id: ctx.from.id,
    sticker_format: 'video',
    sticker: { source: placeholder[packType] || placeholder.regular }
  })
  return (copy ? runInCopyScope(call) : call()).catch((error) => {
    log.error('placeholder upload failed:', error.description || error.message)
    return null
  })
}

// Charging for a copy into another pack type: atomic, and only when the
// balance covers it (the session balance can be stale — two copies started
// together used to take it below zero). Refundable until the copy produced
// something.
const chargeCopy = async (ctx) => {
  const userId = ctx.session.userInfo._id
  const result = await ctx.db.User.updateOne({ _id: userId, balance: { $gte: 1 } }, { $inc: { balance: -1 } })
  if (!result.modifiedCount) return null

  ctx.session.userInfo.balance -= 1
  let refunded = false
  return {
    refund: async () => {
      if (refunded) return
      refunded = true
      await ctx.db.User.updateOne({ _id: userId }, { $inc: { balance: 1 } })
        .catch((error) => log.error('failed to refund copy credit:', error))
      ctx.session.userInfo.balance += 1
    }
  }
}

const NO_CHARGE = { refund: async () => {} }

// Copy the rest of the source one sticker at a time, then report.
const copyRemaining = async (ctx, { copyPack, userStickerSet, seeded, seedAttempted, hasPlaceholder, charged }) => {
  const remaining = copyPack.stickers.slice(seedAttempted)
  const links = {
    originalTitle: escapeHTML(copyPack.title),
    originalLink: packLink(copyPack),
    title: escapeHTML(userStickerSet.title),
    link: packLink(userStickerSet)
  }

  let success = seeded
  let failed = seedAttempted - seeded
  let pending = 0

  if (remaining.length > 0) {
    const progressText = () => ctx.i18n.t('scenes.copy.progress', {
      ...links,
      current: success + pending,
      total: copyPack.stickers.length
    })
    const message = await ctx.replyWithHTML(progressText())

    // While Telegram makes us wait out a rate limit, say so on the progress
    // message so the copy doesn't look frozen.
    const onWait = (seconds) => ctx.telegram.editMessageText(
      message.chat.id, message.message_id, null,
      ctx.i18n.t('error.rate_limit_seconds', { seconds })
    ).catch(() => {})

    for (const [index, sticker] of remaining.entries()) {
      const result = await runInCopyScope(() => addSticker(ctx, sticker, userStickerSet, false), { onWait })

      if (result?.error) failed++
      else if (result?.wait) pending++
      else success++

      if ((index + 1) % 10 === 0) {
        await ctx.telegram.editMessageText(message.chat.id, message.message_id, null, progressText(), { parse_mode: 'HTML' })
          .catch(() => {})
      }

      await delay(COPY_PACE_MS)
    }

    await ctx.telegram.deleteMessage(message.chat.id, message.message_id).catch(() => {})
  }

  if (hasPlaceholder) {
    if (success === 0 && pending === 0) {
      // Nothing was copied — the set holds only the placeholder. Delete it and
      // give the conversion credit back.
      await ctx.telegram.callApi('deleteStickerSet', { name: userStickerSet.name })
        .catch((error) => log.error('failed to delete empty sticker set:', error))
      await ctx.db.StickerSet.deleteOne({ _id: userStickerSet._id }).catch(() => {})
      await charged.refund()
      return ctx.replyWithHTML(ctx.i18n.t('scenes.copy.error.all_failed', links), { disable_web_page_preview: true })
    }

    // The placeholder is normally removed by the first copied sticker; retry
    // in case that removal didn't stick.
    if (userStickerSet.placeholderFileUniqueId) {
      const set = await ctx.telegram.getStickerSet(userStickerSet.name).catch(() => null)
      await removePlaceholderIfPending(ctx.telegram, userStickerSet, set)
    }
  }

  // A copy that fit entirely in the seed batch was already announced.
  if (remaining.length === 0 && failed === 0) return

  let key = 'scenes.copy.done'
  if (failed > 0 && pending > 0) key = 'scenes.copy.done_partial_pending'
  else if (failed > 0) key = 'scenes.copy.done_partial'
  else if (pending > 0) key = 'scenes.copy.done_pending'

  return ctx.replyWithHTML(ctx.i18n.t(key, { ...links, success, failed, pending }), {
    disable_web_page_preview: true
  })
}

// Same-type copy: upload the first ≤50 source stickers for one ordered
// createNewStickerSet. Uploads run one by one with pacing; a sticker that
// fails is skipped (re-adding it later would break the order).
const uploadSeed = async (ctx, copyPack) => {
  const waitMessage = await ctx.replyWithHTML('⏳', { reply_markup: { remove_keyboard: true } })
  const onWait = (seconds) => ctx.telegram.editMessageText(
    waitMessage.chat.id, waitMessage.message_id, null,
    ctx.i18n.t('error.rate_limit_seconds', { seconds })
  ).catch(() => {})

  const batch = copyPack.stickers.slice(0, SEED_BATCH)
  const stickers = []
  for (const [index, sticker] of batch.entries()) {
    const entry = await uploadSourceSticker(ctx, sticker, onWait)
    if (entry) stickers.push(entry)
    if ((index + 1) % 10 === 0) {
      await ctx.telegram.editMessageText(waitMessage.chat.id, waitMessage.message_id, null,
        `⏳ ${index + 1}/${copyPack.stickers.length}`
      ).catch(() => {})
    }
    await delay(COPY_PACE_MS)
  }

  await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id).catch(() => {})
  return { stickers, attempted: batch.length }
}

const newPackConfirm = new Scene('newPackConfirm')

newPackConfirm.enter(async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const { copyPack, newPack } = ctx.session.scene
  const inline = !!newPack.inline
  const packType = newPack.packType || 'regular'
  const { fillColor } = newPack

  const isCurrent = () => wizardOf(ctx) === newPack

  const nameSuffix = `_by_${ctx.options.username}`
  const title = inline ? newPack.title : `${newPack.title} :: @${ctx.options.username}`

  if (inline) {
    // The inline pack name is fixed (inline_<userId>) and StickerSet.newSet
    // replaces a set of the same name — a second inline pack would wipe the
    // first. Select the existing one instead and say why.
    const existingInline = await ctx.db.StickerSet.findOne({
      owner: ctx.session.userInfo.id,
      inline: true,
      deleted: { $ne: true }
    })

    if (existingInline) {
      ctx.session.userInfo.stickerSet = existingInline
      ctx.session.userInfo.inlineStickerSet = existingInline
      ctx.session.userInfo.inlineType = 'packs'

      await removeReplyKeyboard(ctx)
      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.inline_exists', {
        title: escapeHTML(existingInline.title)
      }), {
        reply_markup: Markup.inlineKeyboard([
          Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
        ])
      })

      ctx.session.scene = {}
      return ctx.scene.leave()
    }
  }

  const customName = !!newPack.name
  let names
  if (inline) {
    names = [`inline_${ctx.from.id}`]
  } else if (customName) {
    const name = fitName(normalizeName(newPack.name), nameSuffix)
    if (!name) {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_invalid'), replyTo(ctx))
      return ctx.scene.enter('newPackName')
    }
    names = [name + nameSuffix]
  } else {
    names = autoNameCandidates(newPack.title, nameSuffix)
  }

  let charged = NO_CHARGE
  if (copyPack && copyPack.sticker_type !== packType) {
    charged = await chargeCopy(ctx)
    if (!charged) {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.boost.error.not_enough_credits'), { reply_markup: buyCreditsKeyboard(ctx) })
      return abandon(ctx, newPack)
    }
  }

  let created = { name: names[0] }
  let seeded = 0
  let seedAttempted = 0
  let hasPlaceholder = false
  let placeholderFileUniqueId = null

  if (!inline) {
    // Uploading can take a minute (a copy's seed batch). The scene is left
    // now so the bot keeps working meanwhile; session.scene stays for the
    // isCurrent() checks and for going back to the name step.
    await ctx.scene.leave()

    let stickers

    if (copyPack && copyPack.sticker_type === packType) {
      const seed = await uploadSeed(ctx, copyPack)
      stickers = seed.stickers
      seeded = seed.stickers.length
      seedAttempted = seed.attempted

      if (stickers.length === 0) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.upload_failed'), replyTo(ctx))
        return abandon(ctx, newPack)
      }
    } else {
      // A new empty pack, or a copy into another type (each sticker is
      // converted one by one later): Telegram won't create an empty set, so it
      // starts with a placeholder that the first real sticker replaces.
      const uploaded = await uploadPlaceholder(ctx, packType, !!copyPack)
      if (!uploaded) {
        await charged.refund()
        await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.upload_failed'), replyTo(ctx))
        return abandon(ctx, newPack)
      }
      stickers = [{ sticker: uploaded.file_id, format: 'video', emoji_list: ['🌟'] }]
      hasPlaceholder = true
    }

    created = await createSet(ctx, { names, title, packType, fillColor, stickers, copy: !!copyPack })

    if (created.error) {
      await charged.refund()
      if (!isCurrent()) return
      return handleCreateError(ctx, created.error, { customName, newPack })
    }

    if (hasPlaceholder) placeholderFileUniqueId = await resolvePlaceholderUniqueId(ctx, created.name)
  }

  metrics.track(copyPack ? 'copy_created' : 'pack_created')

  const userStickerSet = await ctx.db.StickerSet.newSet({
    owner: ctx.session.userInfo.id,
    ownerTelegramId: ctx.from.id,
    name: created.name,
    title,
    inline,
    packType,
    boost: !!copyPack,
    emojiSuffix: '🌟',
    create: true,
    placeholderFileUniqueId
  })

  // The cached pack count is reset so /packs recounts it (see handlers/pack-hide.js).
  const countType = inline ? 'inline' : packType
  await ctx.db.User.updateOne(
    { _id: ctx.session.userInfo._id },
    { $set: { stickerSet: userStickerSet._id, [`packsCount.${countType}`]: 0 } }
  )
  if (ctx.session.userInfo.packsCount) ctx.session.userInfo.packsCount[countType] = 0
  ctx.session.userInfo.stickerSet = userStickerSet
  if (inline) {
    ctx.session.userInfo.inlineStickerSet = userStickerSet
    ctx.session.userInfo.inlineType = 'packs'
  }

  if (isCurrent()) await removeReplyKeyboard(ctx)
  await sendPackMenu(ctx, userStickerSet, {
    text: ctx.i18n.t(copyPack ? 'scenes.copy.created' : 'scenes.new_pack.ok', {
      title: escapeHTML(userStickerSet.title),
      link: packLink(userStickerSet)
    })
  })

  // The wizard is done — unless the user already moved on to something else.
  if (isCurrent()) {
    ctx.session.scene = {}
    await ctx.scene.leave()
  }

  if (!copyPack) return flushPendingStickers(ctx, userStickerSet)

  return copyRemaining(ctx, { copyPack, userStickerSet, seeded, seedAttempted, hasPlaceholder, charged })
})

module.exports = [
  newPack,
  newPackTitle,
  newPackName,
  newPackConfirm,
  newPackCopyPay
]
