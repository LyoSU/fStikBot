// All bot commands, actions, and hears. Preserves the exact registration
// order from the original bot.js — order matters for the
// addstickers/addemoji restore→copy chain and for /start payload routing.
const Composer = require('telegraf/composer')
const got = require('got')
const sharp = require('sharp')

module.exports = (bot, privateMessage, {
  handlers,
  limitPublicPack,
  privacyHtml,
  db,
  scenes
}) => {
  const {
    handleStats,
    handlePing,
    handleStart,
    handleHelp,
    handleDonate,
    handleSticker,
    handleDeleteSticker,
    handleRestoreSticker,
    handlePacks,
    handleSelectPack,
    handleSelectGroupPack,
    handleHidePack,
    handleRestorePack,
    handleBoostPack,
    handleCatalog,
    handleSearchCatalog,
    handleCopyPack,
    handleCoedit,
    handleLanguage,
    handleEmoji,
    handleStickerUpdate,
    handleInlineQuery,
    handleGroupSettings
  } = handlers

  // Helper for downstream handlers that want to forward a Telegram API
  // error back to the user without triggering the global error handler.
  const replyWithError = (ctx, error) =>
    ctx.replyWithHTML(ctx.i18n.t('error.telegram', { error: error.description })).catch(() => {})

  // --- Admin-only /json dump ---
  // Used to be public; now gated to the main admin to avoid leaking arbitrary
  // message payloads (forwarded chats can carry sensitive content).
  bot.command('json', Composer.privateChat((ctx) => {
    if (ctx.config.mainAdminId !== ctx.from.id) return
    return ctx.replyWithHTML('<code>' + JSON.stringify(ctx.message, null, 2) + '</code>')
  }))

  // Scenes (Stage) mount — must come before any composer that uses ctx.scene.enter
  bot.use(scenes)

  // Admin panel + news-channel onboarding
  privateMessage.use(require('../handlers/admin'))
  privateMessage.use(require('../handlers/news-channel'))

  bot.use(handleStats)
  bot.use(handlePing)

  // --- /start with merged startPayload routing ---
  // Originally there were three separate bot.start() calls branching on
  // different payload values — merged here for legibility. Falls through
  // via next() so handleDonate (mounted later) can still intercept the
  // 'donate' payload, and the final bot.start(handleStart) catches the rest.
  bot.start(async (ctx, next) => {
    const payload = ctx.startPayload

    if (payload === 'inline_pack') {
      ctx.state.type = 'inline'
      return handlePacks(ctx)
    }
    if (payload === 'pack' || payload === 'packs') return handlePacks(ctx)
    if (payload && /^s_(.*)/.test(payload)) return handleSelectPack(ctx)

    return next()
  })

  // Bot added to a new group → run start flow
  bot.on('new_chat_members', (ctx, next) => {
    if (ctx.message.new_chat_members.find((m) => m.id === ctx.botInfo.id)) {
      return handleStart(ctx, next)
    }
    return next()
  })

  // Pack navigation
  privateMessage.command('help', handleHelp)
  bot.command('packs', handlePacks)
  bot.command('pack', handleSelectGroupPack)
  bot.use(handleGroupSettings)

  privateMessage.action(/packs:(type):(.*)/, handlePacks)
  privateMessage.action(/packs:(.*)/, handlePacks)

  // Support / legal
  privateMessage.command('paysupport', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.paysupport')))
  privateMessage.command('privacy', (ctx) => ctx.replyWithHTML(privacyHtml))

  // Pack link handler chain: restore (if owner) → copy (if not owner).
  // Both hears use the same regex; handleRestorePack calls next() when the
  // pack isn't owned, which lets handleCopyPack fire.
  privateMessage.hears(/(addstickers|addemoji)\/(.*)/, handleRestorePack)

  privateMessage.command('report', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.report')))
  privateMessage.hears(/\/new/, (ctx) => ctx.scene.enter('newPack'))
  privateMessage.action(/new_pack:(.*)/, async (ctx) => {
    const packType = ctx.match[1]
    if (packType === 'inline') {
      ctx.session.scene = ctx.session.scene || {}
      ctx.session.scene.newPack = {
        inline: true,
        packType: 'regular'
      }
    }
    // Scene sends its own new-pack banner below (reply keyboards can't
    // attach via editMessageMedia, so we don't swap the /start message —
    // user keeps their welcome banner in history + sees the scene flow
    // as the next message).
    return ctx.scene.enter('newPack')
  })
  privateMessage.hears(/(addstickers|addemoji)\/(.*)/, handleCopyPack)

  privateMessage.command('publish', (ctx) => ctx.scene.enter('catalogPublishNew'))
  privateMessage.action(/publish/, (ctx) => ctx.scene.enter('catalogPublishNew'))
  privateMessage.command('frame', (ctx) => ctx.scene.enter('packFrame'))
  privateMessage.action(/frame/, (ctx) => ctx.scene.enter('packFrame'))
  privateMessage.command('delete', (ctx) => ctx.scene.enter('deleteSticker'))
  privateMessage.action(/^delete_sticker$/, (ctx) => ctx.scene.enter('deleteSticker'))
  privateMessage.command('catalog', handleCatalog)
  privateMessage.action(/search_catalog/, handleSearchCatalog)
  privateMessage.action(/^catalog$/, handleCatalog)
  privateMessage.command('public', handleSelectPack)
  privateMessage.command('emoji', handleEmoji)
  privateMessage.command('copy', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.copy')))
  privateMessage.command('restore', (ctx) => ctx.replyWithHTML(ctx.i18n.t('cmd.restore')))
  privateMessage.command('original', (ctx) => ctx.scene.enter('originalSticker'))
  privateMessage.action(/^original$/, (ctx) => ctx.scene.enter('originalSticker'))
  privateMessage.command('about', (ctx) => ctx.scene.enter('packAbout'))
  privateMessage.action(/about/, (ctx) => ctx.scene.enter('packAbout'))

  // Download-original — large callback handler kept inline because it
  // branches on sticker type and owns its own fallback logic for emoji
  // packs, webp/webm/tgs, and PNG conversion via sharp.
  privateMessage.action(/^download_original$/, async (ctx) => {
    await ctx.answerCbQuery()

    const sticker = ctx.session?.lastStickerForDownload
    if (!sticker) {
      return ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'))
    }

    // Query supports both new (original) and legacy (file) schema
    const stickerInfo = await db.Sticker.findOne({
      fileUniqueId: sticker.file_unique_id,
      $or: [
        { 'original.fileId': { $ne: null } },
        { 'file.file_id': { $ne: null } }
      ]
    })

    if (stickerInfo && stickerInfo.hasOriginal()) {
      const originalFileId = stickerInfo.getOriginalFileId()
      const originalFileUniqueId = stickerInfo.getOriginalFileUniqueId()

      await ctx.replyWithSticker(originalFileId, {
        caption: stickerInfo.emojis
      }).catch(async (stickerError) => {
        if (stickerError.description.match(/emoji/)) {
          let fileLink
          try {
            fileLink = await ctx.telegram.getFileLink(originalFileId)
          } catch (err) {
            return ctx.replyWithHTML(ctx.i18n.t(err.message?.includes('file is too big') ? 'error.file_too_big' : 'error.download'))
          }
          await ctx.replyWithDocument({
            url: fileLink,
            filename: `${originalFileUniqueId}.webp`
          }).catch((error) => replyWithError(ctx, error))
        } else {
          ctx.replyWithPhoto(originalFileId, {
            caption: stickerInfo.emojis
          }).catch((error) => replyWithError(ctx, error))
        }
      })
    } else {
      let fileLink
      try {
        fileLink = await ctx.telegram.getFileLink(sticker.file_id)
      } catch (err) {
        return ctx.replyWithHTML(ctx.i18n.t(err.message?.includes('file is too big') ? 'error.file_too_big' : 'error.download'))
      }

      if (fileLink.endsWith('.webp')) {
        const buffer = await got(fileLink).buffer()
        const pngBuffer = await sharp(buffer, { failOnError: false }).png().toBuffer()
        await ctx.replyWithDocument({
          source: pngBuffer,
          filename: `${sticker.file_unique_id}.png`
        }).catch((error) => replyWithError(ctx, error))
      } else if (fileLink.endsWith('.webm')) {
        await ctx.replyWithDocument({
          url: fileLink,
          filename: `${sticker.file_unique_id}.webm`
        }).catch((error) => replyWithError(ctx, error))
      } else if (fileLink.endsWith('.tgs')) {
        await ctx.replyWithDocument({
          url: fileLink,
          filename: `${sticker.file_unique_id}.tgs`
        }).catch((error) => replyWithError(ctx, error))
      } else {
        await ctx.replyWithHTML(ctx.i18n.t('scenes.original.error.not_found'))
      }
    }
  })

  // Show-all-packs — companion to /about scene. Chunks responses to 70 packs
  // per message to stay under Telegram's message-length limit.
  privateMessage.action(/^show_all_packs$/, async (ctx) => {
    await ctx.answerCbQuery()

    const data = ctx.session?.showAllPacksData
    if (!data) return

    const packs = await db.StickerSet.find({
      ownerTelegramId: data.ownerId,
      _id: { $ne: data.excludeSetId }
    }).limit(500)

    if (packs.length === 0) return

    const chunkSize = 70
    const formattedPacks = packs.map((pack) => {
      if (pack.name.toLowerCase().endsWith('fstikbot') && pack.public !== true) {
        if (
          ctx.from.id === data.ownerId ||
          ctx.from.id === ctx.config.mainAdminId ||
          ctx?.session?.userInfo?.adminRights?.includes('pack')
        ) {
          return `<a href="https://t.me/addstickers/${pack.name}"><s>${pack.name}</s></a>`
        } else {
          return ctx.i18n.t('scenes.packAbout.hidden')
        }
      }
      return `<a href="https://t.me/addstickers/${pack.name}">${pack.name}</a>`
    })

    // Skip first 70 (already shown) and send the rest in chunks
    const remainingPacks = formattedPacks.slice(chunkSize)
    const chunks = []
    for (let i = 0; i < remainingPacks.length; i += chunkSize) {
      chunks.push(remainingPacks.slice(i, i + chunkSize))
    }

    for (const chunk of chunks) {
      await ctx.replyWithHTML(chunk.join(', '), { disable_web_page_preview: true })
    }
  })

  // Media-edit scenes
  privateMessage.command('clear', (ctx) => ctx.scene.enter('photoClearSelect'))
  privateMessage.command('round', (ctx) => ctx.scene.enter('videoRound'))
  privateMessage.command('mosaic', (ctx) => ctx.scene.enter('mosaic'))
  privateMessage.action(/clear/, (ctx) => ctx.scene.enter('photoClearSelect'))
  privateMessage.action(/catalog:publish:(.*)/, (ctx) => ctx.scene.enter('catalogPublish'))
  privateMessage.action(/catalog:unpublish:(.*)/, (ctx) => ctx.scene.enter('catalogUnpublish'))

  // Language picker
  bot.command('lang', handleLanguage)
  bot.action(/set_language:(.*)/, handleLanguage)

  privateMessage.action(/delete_pack:(.*)/, (ctx) => ctx.scene.enter('packDelete'))

  privateMessage.action('mosaic:enter', (ctx) => {
    ctx.answerCbQuery()
    return ctx.scene.enter('mosaic')
  })

  // Donate (Stars) + boost + coedit
  bot.use(handleDonate)
  privateMessage.use(handleBoostPack)
  privateMessage.use(handleCoedit)

  // Inline queries (packs or GIFs)
  bot.use(handleInlineQuery)

  // Final /start catch-all — if none of the startPayload branches matched
  // AND handleDonate's composer didn't handle it, run the menu.
  bot.start(handleStart)

  // Pack management callbacks
  privateMessage.action(/(set_pack):(.*)/, handlePacks)
  privateMessage.action(/(hide_pack):(.*)/, handleHidePack)
  privateMessage.action(/(rename_pack):(.*)/, (ctx) => ctx.scene.enter('packRename'))
  privateMessage.action(/(delete_sticker):(.*)/, limitPublicPack, handleDeleteSticker)
  privateMessage.action(/(restore_sticker):(.*)/, limitPublicPack, handleRestoreSticker)

  // /ss — quote-reply style sticker creation (works in groups too)
  bot.command('ss', handleSticker)

  // Sticker detection in private chats (images, videos, video notes, etc.)
  privateMessage.on(['sticker', 'document', 'photo', 'video', 'video_note'], limitPublicPack, handleSticker)
  privateMessage.on('message', (ctx, next) => {
    if (ctx.message && ctx.message.entities && ctx.message.entities[0] && ctx.message.entities[0].type === 'custom_emoji') {
      return handleSticker(ctx)
    }
    return next()
  })
  privateMessage.action(/add_sticker/, handleSticker)

  // Sticker metadata updates (emoji suffix edit). These listen for free-form
  // text and must be registered BEFORE bot.use(privateMessage) so the
  // composer is fully populated at mount time.
  privateMessage.on('text', handleStickerUpdate)
  privateMessage.on('message', handleStart)

  // Mount privateMessage only after every handler is attached
  bot.use(privateMessage)
}
