const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { sendBanner } = require('../banners')
const {
  escapeHTML,
  telegramApi,
  showGramAds
} = require('../utils')
const {
  db
} = require('../database')
const decodeStickerSetId = require('../utils/decode-sticker-set-id')
const { formatOwnerPacks } = require('../utils/owner-packs')

// One reply per lookup; the rest stays behind the "show all packs" button.
const USER_PACKS_CHUNK = 70
// The sticker lookup reply carries a lot of other text, so its pack list is
// kept shorter to stay under Telegram's message-length limit.
const OTHER_PACKS_CHUNK = 20

// Remembered for the "show all packs" button (bot/commands.js), which sends
// every chunk after the first.
const rememberShowAllPacks = (ctx, ownerId, excludeSetId, chunkSize) => {
  ctx.session.showAllPacksData = { ownerId, excludeSetId, chunkSize }
}

const showAllPacksKeyboard = (ctx, total) => Markup.inlineKeyboard([[
  Markup.callbackButton(ctx.i18n.t('scenes.packAbout.btn.show_all_packs', { count: total }), 'show_all_packs')
]]).extra()

// "Whose packs are these?" for a user picked via request_users or a forward.
const replyWithUserPacks = async (ctx, ownerId) => {
  if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  // Only the first ~500 are ever rendered, so there is no reason to hydrate
  // every pack a prolific user ever made.
  const packs = await ctx.db.StickerSet.find({ ownerTelegramId: ownerId })
    .select('name public packType')
    .limit(500)
    .lean()

  const chunks = formatOwnerPacks(ctx, packs, ownerId, USER_PACKS_CHUNK)
  const hasMore = chunks.length > 1
  if (hasMore) rememberShowAllPacks(ctx, ownerId, null, USER_PACKS_CHUNK)

  return ctx.replyWithHTML(ctx.i18n.t('userAbout.result', {
    userId: ownerId,
    packs: chunks.length > 0 ? chunks[0].join(', ') : ctx.i18n.t('userAbout.no_packs')
  }), {
    disable_web_page_preview: true,
    ...(hasMore ? showAllPacksKeyboard(ctx, packs.length) : {})
  })
}

// Telegram datacenter regions
const DC_REGIONS = {
  1: '🇺🇸 USA',
  2: '🇪🇺 Europe',
  3: '🇺🇸 USA',
  4: '🇪🇺 Europe',
  5: '🇸🇬 Asia',
  7: '🇺🇸 USA'
}

const packAbout = new Scene('packAbout')

packAbout.enter(async (ctx) => {
  await sendBanner(ctx, 'origin', ctx.i18n.t('scenes.packAbout.enter'), {
    reply_markup: {
      keyboard: [
        [{
          text: ctx.i18n.t('userAbout.select_user'),
          request_users: {
            request_id: 1,
            user_is_bot: false,
            max_quantity: 1
          }
        }],
        [
          ctx.i18n.t('scenes.btn.cancel')
        ]
      ],
      resize_keyboard: true
    }
  })
})

// Handle user selection via users_shared
packAbout.use((ctx, next) => {
  if (ctx?.message?.users_shared) {
    const sharedUserId = ctx.message.users_shared.user_ids[0]

    if (!sharedUserId) return next()

    return replyWithUserPacks(ctx, sharedUserId)
  }
  return next()
})

packAbout.on(['sticker', 'text', 'forward'], async (ctx, next) => {
  // Handle forwarded message for user info
  if (ctx.message.forward_from) {
    await replyWithUserPacks(ctx, ctx.message.forward_from.id)
    return
  }
  if (!ctx.message) return

  let sticker

  if (ctx.message.entities && ctx.message.entities[0] && ctx.message.entities[0].type === 'custom_emoji') {
    const customEmoji = ctx.message.entities.find((e) => e.type === 'custom_emoji')

    if (!customEmoji) return

    const emojiStickers = await ctx.telegram.callApi('getCustomEmojiStickers', {
      custom_emoji_ids: [customEmoji.custom_emoji_id]
    })

    if (!emojiStickers) return

    sticker = emojiStickers[0]
  } else if (ctx.message.sticker) {
    sticker = ctx.message.sticker
  } else {
    return next()
  }

  if (!sticker) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.not_found'))
  }

  if (!sticker.set_name) {
    return ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.not_found'))
  }

  // First check database
  let stickerSet = await db.StickerSet.findOne({
    name: sticker.set_name
  })

  let ownerId = stickerSet?.ownerTelegramId || null
  let setId = null
  let dcId = null
  let stickerCount = null

  // Only use MTProto if we don't have owner info in database
  const mtproto = ownerId ? null : await telegramApi.getClient()
  if (mtproto) {
    try {
      const stickerSetInfo = await mtproto.invoke(new telegramApi.Api.messages.GetStickerSet({
        stickerset: new telegramApi.Api.InputStickerSetShortName({
          shortName: sticker.set_name
        }),
        hash: 0
      }))

      if (stickerSetInfo) {
        const decoded = decodeStickerSetId(stickerSetInfo.set.id.value)
        ownerId = decoded.ownerId
        setId = decoded.setId
        dcId = decoded.dcId
        stickerCount = stickerSetInfo.set.count

        // Save to database for future requests
        if (!stickerSet) {
          stickerSet = await db.StickerSet.create({
            ownerTelegramId: ownerId,
            name: sticker.set_name,
            title: stickerSetInfo.set.title,
            animated: sticker.is_animated,
            video: sticker.is_video,
            packType: sticker.type,
            thirdParty: true
          })
        } else if (!stickerSet.ownerTelegramId) {
          // Update existing record with owner info
          stickerSet.ownerTelegramId = ownerId
          await stickerSet.save()
        }
      }
    } catch (err) {
      // MTProto API unavailable, continue without owner info
    }
  }

  const actualOwnerId = ownerId

  // get all stickerset owners from database (only if we have owner info)
  const packs = actualOwnerId
    ? await db.StickerSet.find({
      ownerTelegramId: actualOwnerId,
      _id: { $ne: stickerSet?._id || null }
    }).select('name public packType').limit(500).lean()
    : []

  const chunkedPacks = formatOwnerPacks(ctx, packs, actualOwnerId, OTHER_PACKS_CHUNK)

  if (ctx.session.userInfo.locale === 'ru' && !ctx.session.userInfo?.stickerSet?.boost) {
    showGramAds(ctx.chat.id)
  }

  let ownerChat = null
  let mention = ctx.i18n.t('scenes.packAbout.unknown_owner')

  if (actualOwnerId) {
    ownerChat = await ctx.telegram.getChat(actualOwnerId).catch(() => null)
    mention = (!ownerChat || ownerChat?.has_private_forwards === true) ? undefined : `<a href="tg://user?id=${actualOwnerId}">${escapeHTML(ownerChat?.first_name) || 'unknown'}</a>`
    if (!mention) mention = `<a href="tg://openmessage?user_id=${actualOwnerId}">[🤖]</a>, <a href="https://t.me/@id${actualOwnerId}">[🍏]</a>`
  }

  let otherPacks

  if (chunkedPacks.length > 0) {
    otherPacks = chunkedPacks.shift()
  }

  // Save sticker for download button
  ctx.session.lastStickerForDownload = {
    file_id: sticker.file_id,
    file_unique_id: sticker.file_unique_id,
    is_video: sticker.is_video,
    is_animated: sticker.is_animated
  }

  // Save data for "show all packs" button
  const totalOtherPacks = packs.length
  if (chunkedPacks.length > 0) {
    rememberShowAllPacks(ctx, actualOwnerId, stickerSet?._id || null, OTHER_PACKS_CHUNK)
  }

  // Build keyboard
  const keyboard = [[Markup.callbackButton(ctx.i18n.t('scenes.packAbout.btn.download'), 'download_original')]]
  if (chunkedPacks.length > 0) {
    keyboard.push([Markup.callbackButton(
      ctx.i18n.t('scenes.packAbout.btn.show_all_packs', { count: totalOtherPacks }),
      'show_all_packs'
    )])
  }

  const otherPacksText = otherPacks
    ? otherPacks.slice(0, 15).join(', ') + (otherPacks.length > 15 ? '...' : '')
    : ctx.i18n.t('scenes.packAbout.no_other_packs')

  const dcRegion = dcId ? DC_REGIONS[dcId] || '?' : null
  const dcDisplay = dcId ? `${dcRegion}` : '?'

  await ctx.replyWithHTML(ctx.i18n.t('scenes.packAbout.result', {
    link: `https://t.me/addstickers/${sticker.set_name}`,
    name: escapeHTML(sticker.set_name),
    ownerId: actualOwnerId ?? '?',
    mention,
    setId: setId ?? '?',
    dcId: dcDisplay,
    stickerCount: stickerCount ?? '?',
    otherPacks: otherPacksText
  }), {
    disable_web_page_preview: true,
    ...Markup.inlineKeyboard(keyboard).extra()
  })
})

module.exports = packAbout
