const got = require('got')
const slug = require('limax')
const StegCloak = require('stegcloak')
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
const { humanizeTelegramError } = require('../utils/telegram-error')
const { runInCopyScope, isRateLimitError } = require('../utils/retry-api')
const log = require('../utils/logger').scope('pack-new')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A copy is done strictly one sticker at a time, in original order: that's
// the only way the copy mirrors the source ordering (a parallel/bulk pass
// reorders any sticker that has to be re-added) and it keeps us under
// Telegram's ~1/s per-user sticker limit. COPY_PACE_MS is the gap between
// stickers; the copy-scope retry policy waits out the rare 429 on top.
const COPY_PACE_MS = parseInt(process.env.COPY_PACE_MS, 10) || 1000
// Circuit breaker: if this many stickers in a row fail with a rate-limit
// error we couldn't wait out, Telegram is hard-limiting us — stop and
// report honestly instead of grinding through the rest to the same end.
const COPY_ABORT_STREAK = parseInt(process.env.COPY_ABORT_STREAK, 10) || 3

const { match } = I18n

const placeholder = {
  regular: {
    video: 'sticker_placeholder.webm'
  },
  custom_emoji: {
    video: 'emoji_placeholder.webm'
  }
}

const stegcloak = new StegCloak(false, false)

// Download a source sticker and re-upload it via uploadStickerFile,
// returning the InputSticker entry ({ sticker: file_id, format, emoji_list })
// or null if it couldn't be fetched/uploaded. Runs in copy scope, so a 429
// is waited out rather than failed fast. Used to seed a same-type copy's
// createNewStickerSet with its first (ordered) batch of stickers.
const uploadSourceSticker = async (ctx, sticker) => {
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
  })).catch((error) => ({ error }))

  if (!uploaded || uploaded.error) return null

  return {
    sticker: uploaded.file_id,
    format: stickerFormat,
    emoji_list: sticker.emojis ? sticker.emojis : [sticker.emoji]
  }
}

const newPack = new Scene('newPack')

newPack.enter(async (ctx, next) => {
  if (!ctx.session.scene) ctx.session.scene = {}
  const existingNewPack = ctx.session.scene.newPack || {}
  ctx.session.scene.newPack = existingNewPack

  if (ctx?.message?.text) {
    const args = ctx.message.text.split(' ')

    if (['fill', 'adaptive'].includes(args[1])) {
      ctx.session.scene.newPack.fillColor = true
    }
  }

  // Якщо це інлайн пак, пропускаємо вибір типу
  if (ctx.session.scene.newPack.inline) {
    return ctx.scene.enter('newPackTitle')
  }

  await sendBanner(ctx, 'new-pack', ctx.i18n.t('scenes.new_pack.pack_type'), {
    reply_markup: Markup.keyboard([
      [
        { text: ctx.i18n.t('scenes.new_pack.regular'), style: 'primary' }
      ],
      [
        { text: ctx.i18n.t('scenes.new_pack.custom_emoji'), style: 'primary' }
      ],
      [
        { text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }
      ]
    ]).resize()
  })
})

newPack.on('message', async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  const { text } = ctx.message
  const { newPack } = ctx.session.scene
  if (text === ctx.i18n.t('scenes.new_pack.custom_emoji')) {
    newPack.packType = 'custom_emoji'
  } else if (text === ctx.i18n.t('scenes.new_pack.regular')) {
    newPack.packType = 'regular'
  } else {
    return ctx.scene.reenter()
  }

  if (
    ctx.session.scene?.copyPack &&
    ctx.session.scene.copyPack.sticker_type !== newPack.packType
  ) {
    return ctx.scene.enter('newPackCopyPay')
  }

  return ctx.scene.enter('newPackTitle')
})

const newPackCopyPay = new Scene('newPackCopyPay')

newPackCopyPay.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.pay', {
    balance: ctx.session.userInfo.balance
  }), {
    reply_markup: Markup.keyboard([
      [
        { text: ctx.i18n.t('scenes.copy.pay_btn'), style: 'primary' }
      ],
      [
        { text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }
      ]
    ]).resize()
  })
})

newPackCopyPay.hears(match('scenes.copy.pay_btn'), async (ctx) => {
  if (ctx.session.userInfo.balance < 1) {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.boost.error.not_enough_credits'), {
      reply_markup: Markup.removeKeyboard()
    })

    // Clean up all session state
    ctx.session.scene = {}
    return ctx.scene.leave()
  }
  return ctx.scene.enter('newPackTitle')
})

const newPackTitle = new Scene('newPackTitle')

newPackTitle.enter(async (ctx) => {
  if (!ctx.session.scene) return ctx.scene.leave()
  if (!ctx.session.scene.newPack) {
    ctx.session.scene.newPack = {}
  }

  const names = generateStrings({ count: 3 })

  await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_title'), {
    reply_markup: Markup.keyboard([
      ...names.map((name) => [name]),
      [
        { text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }
      ]
    ]).resize()
  })
})
newPackTitle.on('text', async (ctx) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  const charTitleMax = ctx.config.charTitleMax

  let title = ctx.message.text

  if (countUncodeChars(title) > charTitleMax) {
    title = substrUnicode(title, 0, charTitleMax)
  }

  ctx.session.scene.newPack.title = title

  if (ctx.session.scene.newPack.inline) return ctx.scene.enter('newPackConfirm')
  else return ctx.scene.enter('newPackName')
})

const newPackName = new Scene('newPackName')

newPackName.enter((ctx) => ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.pack_name'), {
  reply_to_message_id: ctx.message.message_id,
  allow_sending_without_reply: true,
  disable_web_page_preview: true
}))

newPackName.on('text', async (ctx) => {
  // Ensure scene state exists
  if (!ctx.session.scene?.newPack) {
    return ctx.scene.enter('newPack')
  }

  ctx.session.scene.newPack.name = ctx.message.text

  return ctx.scene.enter('newPackConfirm')
})

const newPackConfirm = new Scene('newPackConfirm')

newPackConfirm.enter(async (ctx, next) => {
  if (!ctx.session.scene?.newPack) return ctx.scene.leave()
  if (!ctx.session.userInfo) ctx.session.userInfo = await ctx.db.User.getData(ctx.from)

  const copyPack = ctx.session.scene.copyPack
  const inline = !!ctx.session.scene.newPack.inline

  const nameSuffix = `_by_${ctx.options.username}`
  const titleSuffix = ` :: @${ctx.options.username}`

  let { name, title, fillColor, packType } = ctx.session.scene.newPack

  // Для inline паку автоматично генеруємо name
  if (inline) {
    name = 'inline_' + ctx.from.id
  } else {
    name = name.replace(/https/, '')
    name = name.replace(/t.me\/addstickers\//, '')
    name = slug(name, { separator: '_', maintainCase: true })
    name = name.replace(/[^0-9a-z_]/gi, '')
  }

  if (!name) {
    return ctx.scene.enter('newPackName')
  }

  const maxNameLength = 64 - nameSuffix.length

  if (name.length >= maxNameLength) {
    name = name.slice(0, maxNameLength)
  }

  if (!inline) name += nameSuffix
  if (!inline) title += titleSuffix

  let alreadyUploadedStickers = 0
  let createNewStickerSet
  let hasPlaceholder = false

  packType = packType || 'regular'

  if (inline) {
    createNewStickerSet = true
  } else {
    const stickerSetByName = await ctx.db.StickerSet.findOne({ name })

    if (stickerSetByName) {
      await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true
      })
      return ctx.scene.enter('newPackName')
    }

    if (copyPack) {
      const waitMessage = await ctx.replyWithHTML('⏳', {
        reply_markup: {
          remove_keyboard: true
        }
      })

      const sameType = copyPack.sticker_type === packType
      let seedStickers

      if (sameType) {
        // Same type → seed the set with the first ≤50 source stickers in a
        // single ordered createNewStickerSet call (Telegram preserves the
        // array order). Uploads run strictly sequentially with pacing so we
        // never burst the per-user limit. A sticker that still fails to
        // upload is skipped (never re-inserted later — that scrambles order)
        // and reported as failed below.
        const firstBatch = copyPack.stickers.slice(0, 50)
        const uploaded = []
        let seedProcessed = 0
        for (const sticker of firstBatch) {
          const entry = await uploadSourceSticker(ctx, sticker)
          if (entry) uploaded.push(entry)
          seedProcessed++
          // Keep the ⏳ message alive with a counter — the seed upload can
          // take ~50s (one per second) before the set link exists.
          if (seedProcessed % 10 === 0) {
            await ctx.telegram.editMessageText(
              waitMessage.chat.id, waitMessage.message_id, null,
              `⏳ ${seedProcessed}/${copyPack.stickers.length}`
            ).catch(() => {})
          }
          await delay(COPY_PACE_MS)
        }

        if (uploaded.length === 0) {
          // Whole first batch failed → Telegram is hard-limiting us; abort
          // cleanly rather than create an empty/broken pack.
          await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id).catch(() => {})
          await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.upload_failed'), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
          ctx.session.scene = {}
          return ctx.scene.leave()
        }

        seedStickers = uploaded
        alreadyUploadedStickers = uploaded.length
      } else {
        // Different type → each sticker needs per-sticker conversion
        // (addSticker), so we can't bulk-upload raw files. Seed with a
        // placeholder and copy everything individually below; the
        // placeholder is removed once copying finishes.
        const placeholderSticker = await runInCopyScope(() => ctx.telegram.callApi('uploadStickerFile', {
          user_id: ctx.from.id,
          sticker_format: 'video',
          sticker: {
            source: placeholder[packType].video
          }
        }))

        seedStickers = [{ sticker: placeholderSticker.file_id, format: 'video', emoji_list: ['🌟'] }]
        hasPlaceholder = true
      }

      createNewStickerSet = await runInCopyScope(() => ctx.telegram.callApi('createNewStickerSet', {
        user_id: ctx.from.id,
        name,
        title,
        stickers: seedStickers,
        sticker_type: packType,
        needs_repainting: !!fillColor
      })).catch((error) => {
        return { error }
      })

      await ctx.telegram.deleteMessage(ctx.chat.id, waitMessage.message_id)

      if (createNewStickerSet.error) {
        // In create-flow, STICKERSET_INVALID actually means "name not
        // accepted" — Telegram quirk where this code surfaces on
        // create. Keep the context-specific mapping; fall back to the
        // generic humanizer for everything else.
        if (createNewStickerSet.error.description === 'STICKERSET_INVALID') {
          await ctx.replyWithHTML(ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied'), {
            reply_to_message_id: ctx.message.message_id,
            allow_sending_without_reply: true
          })
          return ctx.scene.enter('newPackName')
        }

        await ctx.replyWithHTML(humanizeTelegramError(ctx, createNewStickerSet.error), {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
        return ctx.scene.enter('newPackName')
      }
    } else {
      const uploadedSticker = await ctx.telegram.callApi('uploadStickerFile', {
        user_id: ctx.from.id,
        sticker_format: 'video',
        sticker: {
          source: placeholder[packType].video
        }
      })

      createNewStickerSet = await ctx.telegram.callApi('createNewStickerSet', {
        user_id: ctx.from.id,
        name,
        title,
        stickers: [
          {
            sticker: uploadedSticker.file_id,
            format: 'video',
            emoji_list: ['🌟']
          }
        ],
        sticker_type: packType,
        needs_repainting: !!fillColor
      }).catch((error) => {
        return { error }
      })

      if (createNewStickerSet.error) {
        const { error } = createNewStickerSet
        const description = error?.description || ''

        // Context-specific name validation errors keep their own keys —
        // they appear at the "enter pack name" step and need step-specific
        // copy. Other Telegram errors flow through the shared humanizer.
        let messageText
        if (description === 'Bad Request: invalid sticker set name is specified') {
          messageText = ctx.i18n.t('scenes.new_pack.error.telegram.name_invalid')
        } else if (description === 'Bad Request: sticker set name is already occupied') {
          messageText = ctx.i18n.t('scenes.new_pack.error.telegram.name_occupied')
        } else {
          messageText = humanizeTelegramError(ctx, error)
        }

        await ctx.replyWithHTML(messageText, {
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true
        })
        return ctx.scene.enter('newPackName')
      }
    }
  }

  if (createNewStickerSet) {
    if (!inline && !ctx?.session?.scene?.copyPack) {
      // Delayed cleanup of the bootstrap placeholder Telegram requires for
      // createNewStickerSet. Runs outside any handler timeline, so a
      // single top-level try/catch is mandatory — an unhandled rejection
      // here (e.g. getStickerSet 404 if the user nuked the pack first)
      // would crash the process.
      setTimeout(async () => {
        try {
          const set = await ctx.telegram.getStickerSet(name)
          const placeholder = set.stickers[0]
          if (!placeholder) return
          await ctx.telegram.deleteStickerFromSet(placeholder.file_id)
        } catch (error) {
          log.error('placeholder cleanup failed:', error)
        }
      }, 1000 * 10)
    }

    const userStickerSet = await ctx.db.StickerSet.newSet({
      owner: ctx.session.userInfo.id,
      ownerTelegramId: ctx.from.id,
      name,
      title,
      inline,
      packType,
      boost: !!copyPack,
      emojiSuffix: '🌟',
      create: true
    })

    if (inline) {
      ctx.session.userInfo.inlineStickerSet = userStickerSet
      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_inline_pack', {
        title: escapeHTML(userStickerSet.title),
        botUsername: ctx.options.username
      }), {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
        reply_markup: Markup.inlineKeyboard([
          Markup.switchToChatButton(ctx.i18n.t('callback.pack.btn.use_pack'), '')
        ])
      })
    } else {
      let inlineData = ''
      if (ctx.session.userInfo.inlineType === 'packs') {
        inlineData = stegcloak.hide('{gif}', '', ' : ')
      }

      const linkPrefix = userStickerSet.packType === 'custom_emoji' ? ctx.config.emojiLinkPrefix : ctx.config.stickerLinkPrefix

      await ctx.replyWithHTML(ctx.i18n.t('callback.pack.set_pack', {
        title: escapeHTML(userStickerSet.title),
        link: `${linkPrefix}${name}`
      }), {
        disable_web_page_preview: true,
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.urlButton(ctx.i18n.t('callback.pack.btn.use_pack'), `${linkPrefix}${userStickerSet.name}`)
          ],
          [
            Markup.callbackButton(ctx.i18n.t('callback.pack.btn.boost'), `boost:${userStickerSet.id}`, userStickerSet.boost)
          ],
          [
            Markup.callbackButton(ctx.i18n.t('callback.pack.btn.frame'), 'set_frame')
          ],
          [
            Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.btn.search_gif'), inlineData)
          ],
          [
            Markup.callbackButton(ctx.i18n.t('callback.pack.btn.coedit'), `coedit:${userStickerSet.id}`)
          ]
        ]),
        parse_mode: 'HTML'
      })
    }

    ctx.session.userInfo.stickerSet = userStickerSet

    // if different pack type, use atomic $inc to prevent race conditions
    if (copyPack && copyPack.sticker_type !== packType) {
      await ctx.db.User.updateOne(
        { _id: ctx.session.userInfo._id },
        { $inc: { balance: -1 }, $set: { stickerSet: userStickerSet._id } }
      )
      ctx.session.userInfo.balance -= 1
    } else {
      await ctx.db.User.updateOne(
        { _id: ctx.session.userInfo._id },
        { $set: { stickerSet: userStickerSet._id } }
      )
    }

    if (!copyPack) {
      await ctx.replyWithHTML('👌', {
        reply_markup: {
          remove_keyboard: true
        }
      })

      return ctx.scene.leave()
    }

    const originalPack = copyPack

    // Same-type copies already seeded the first ≤50 stickers via
    // createNewStickerSet; any of those that failed to upload are counted as
    // failed here (never re-added — re-adding would break the order). What's
    // left to copy one-by-one is everything past that seed batch (or, for a
    // different-type copy, every sticker).
    const batchAttemptedCount = hasPlaceholder ? 0 : Math.min(50, originalPack.stickers.length)
    const remainingItems = originalPack.stickers.slice(batchAttemptedCount)

    // Hoisted so the hasPlaceholder cleanup and result-message branches below
    // can reference them even when there's nothing left to copy individually.
    let successCount = alreadyUploadedStickers
    let failedCount = batchAttemptedCount - alreadyUploadedStickers // stickers skipped during the seed batch
    let pendingCount = 0
    let processed = 0

    if (remainingItems.length > 0) {
      const message = await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.progress', {
        originalTitle: escapeHTML(originalPack.title),
        originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
        title: escapeHTML(title),
        link: `${ctx.config.stickerLinkPrefix}${name}`,
        current: successCount + pendingCount,
        total: originalPack.stickers.length
      }))

      // Copy the rest strictly one at a time, in original order, paced ~1/s.
      // Each add waits out a per-user 429 (copy scope). If Telegram keeps
      // hard-limiting us for COPY_ABORT_STREAK stickers in a row, stop and
      // report honestly rather than grinding through the rest to no effect.
      let rateLimitStreak = 0
      let aborted = false

      for (const sticker of remainingItems) {
        const result = await runInCopyScope(() => addSticker(ctx, sticker, userStickerSet, false))

        if (result?.error) {
          failedCount++
          if (isRateLimitError(result.error.telegram)) {
            if (++rateLimitStreak >= COPY_ABORT_STREAK) aborted = true
          } else {
            rateLimitStreak = 0
          }
        } else if (result?.wait) {
          // Video stickers queued for async processing - don't count as success yet
          pendingCount++
          rateLimitStreak = 0
        } else {
          successCount++
          rateLimitStreak = 0
        }
        processed++

        if (processed % 10 === 0) {
          await ctx.telegram.editMessageText(
            message.chat.id, message.message_id, null,
            ctx.i18n.t('scenes.copy.progress', {
              originalTitle: escapeHTML(originalPack.title),
              originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
              title: escapeHTML(title),
              link: `${ctx.config.stickerLinkPrefix}${name}`,
              current: successCount + pendingCount,
              total: originalPack.stickers.length
            }),
            { parse_mode: 'HTML' }
          ).catch(() => {})
        }

        if (aborted) {
          // Everything we won't attempt counts as failed so the summary adds up.
          failedCount += remainingItems.length - processed
          break
        }

        await delay(COPY_PACE_MS)
      }

      await ctx.telegram.deleteMessage(message.chat.id, message.message_id)
    }

    // Show result with appropriate message based on outcome. Skipped only
    // when a copy completed fully within the seed batch (nothing processed
    // individually, nothing failed) — the pack link reply already covers it.
    if (processed > 0 || failedCount > 0) {
      if (failedCount > 0 && pendingCount > 0) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done_partial_pending', {
          originalTitle: escapeHTML(originalPack.title),
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
          title: escapeHTML(title),
          link: `${ctx.config.stickerLinkPrefix}${name}`,
          success: successCount,
          failed: failedCount,
          pending: pendingCount
        }),
        { parse_mode: 'HTML' }
        )
      } else if (failedCount > 0) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done_partial', {
          originalTitle: escapeHTML(originalPack.title),
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
          title: escapeHTML(title),
          link: `${ctx.config.stickerLinkPrefix}${name}`,
          success: successCount,
          failed: failedCount
        }),
        { parse_mode: 'HTML' }
        )
      } else if (pendingCount > 0) {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done_pending', {
          originalTitle: escapeHTML(originalPack.title),
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
          title: escapeHTML(title),
          link: `${ctx.config.stickerLinkPrefix}${name}`,
          success: successCount,
          pending: pendingCount
        }),
        { parse_mode: 'HTML' }
        )
      } else {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.done', {
          originalTitle: escapeHTML(originalPack.title),
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`,
          title: escapeHTML(title),
          link: `${ctx.config.stickerLinkPrefix}${name}`
        }),
        { parse_mode: 'HTML' }
        )
      }
    }

    // Delete placeholder sticker after all stickers are copied
    if (hasPlaceholder) {
      const getStickerSet = await ctx.telegram.getStickerSet(name).catch(() => null)
      if (getStickerSet?.stickers?.length > 1) {
        // Delete placeholder only if there are other stickers
        const placeholderSticker = getStickerSet.stickers[0]
        if (placeholderSticker) {
          await ctx.telegram.deleteStickerFromSet(placeholderSticker.file_id).catch(error => {
            log.error('failed to delete placeholder sticker:', error)
          })
        }
      } else if (getStickerSet?.stickers?.length === 1 && successCount === 0 && pendingCount === 0) {
        // All stickers failed - pack only has placeholder
        // Delete the entire pack since it's useless
        await ctx.telegram.callApi('deleteStickerSet', { name }).catch(error => {
          log.error('failed to delete empty sticker set:', error)
        })
        // Remove from database
        await ctx.db.StickerSet.deleteOne({ name }).catch(() => {})
        // Warn user
        await ctx.replyWithHTML(ctx.i18n.t('scenes.copy.error.all_failed', {
          originalTitle: escapeHTML(originalPack.title),
          originalLink: `${ctx.config.stickerLinkPrefix}${originalPack.name}`
        }))
      }
    }

    // Clean up session state
    delete ctx.session.scene.copyPack

    await ctx.scene.leave()
  }
})

module.exports = [
  newPack,
  newPackTitle,
  newPackName,
  newPackConfirm,
  newPackCopyPay
]
