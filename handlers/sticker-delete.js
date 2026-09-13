const Markup = require('telegraf/markup')
const escapeHTML = require('../utils/html-escape')
const { humanizeTelegramError } = require('../utils/telegram-error')
const { safeEditMessage } = require('../utils/safe-edit')
const { removePlaceholderIfPending } = require('../utils/placeholder')
const coedit = require('../utils/coedit')

const isOwnerOf = (ctx, stickerSet) => String(stickerSet.owner) === String(ctx.session.userInfo.id)

const canDeleteInGroup = async (ctx, stickerSet) => {
  const group = await ctx.db.Group.findOne({ telegram_id: ctx.chat.id })
  if (!group?.stickerSet || String(group.stickerSet._id || group.stickerSet) !== String(stickerSet._id)) return false
  if (group.settings?.rights?.delete === 'all') return true

  const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null)
  return ['creator', 'administrator'].includes(member?.status)
}

// Which sticker to delete, and whether this user may. `telegramSticker` is
// the sticker as Telegram sent it, for stickers of this bot's packs that
// predate the database.
const resolveTarget = async (ctx, fileUniqueId, telegramSticker) => {
  const sticker = await ctx.db.Sticker.findOne({ fileUniqueId })
    .populate('stickerSet', '_id name title owner inline passcode placeholderFileUniqueId packType')

  if (sticker?.stickerSet) {
    const access = await coedit.getAccess(ctx, sticker.stickerSet)
    const allowed = coedit.can(access, 'delete') ||
      (ctx.chat.type !== 'private' && await canDeleteInGroup(ctx, sticker.stickerSet))

    if (allowed) return { sticker, stickerSet: sticker.stickerSet, fileId: sticker.getFileId(), access }
    // A member whose role only allows adding.
    return access ? { denied: true } : null
  }

  const setName = telegramSticker?.set_name
  if (!setName || setName.split('_').pop() !== ctx.options.username) return null

  const stickerSet = await ctx.db.StickerSet.findOne({ name: setName, owner: ctx.session.userInfo.id })
  return stickerSet ? { sticker: null, stickerSet, fileId: telegramSticker.file_id } : null
}

/**
 * Delete a sticker from its pack.
 *
 * @returns {Promise<{ok: {text: string, extra: Object}} | {error: string}>}
 *   the success message to show, or the error text
 */
async function deleteSticker (ctx, fileUniqueId, telegramSticker) {
  const target = await resolveTarget(ctx, fileUniqueId, telegramSticker)
  if (!target) return { error: ctx.i18n.t('callback.sticker.error.not_found') }
  if (target.denied) return { error: ctx.i18n.t('coedit.no_rights') }

  const { sticker, stickerSet, fileId } = target

  // The shared public demo pack keeps its first sticker.
  if (ctx.session.userInfo?.stickerSet?.passcode === 'public' && sticker) {
    const set = await ctx.tg.getStickerSet(stickerSet.name).catch(() => null)
    if (set?.stickers?.[0]?.file_unique_id === sticker.fileUniqueId) {
      return { error: ctx.i18n.t('callback.sticker.error.not_found') }
    }
  }

  if (!stickerSet.inline) {
    try {
      await ctx.deleteStickerFromSet(fileId)
    } catch (error) {
      // STICKER_INVALID: already gone from the set (removed in a Telegram
      // client). Sync the database and report success.
      if (!(error?.description || error?.message || '').includes('STICKER_INVALID')) {
        return { error: humanizeTelegramError(ctx, error) }
      }
    }

    // The last real sticker may be gone, leaving only the bootstrap placeholder.
    if (stickerSet.placeholderFileUniqueId) {
      const currentSet = await ctx.tg.getStickerSet(stickerSet.name).catch(() => null)
      await removePlaceholderIfPending(ctx.telegram, stickerSet, currentSet, { allowEmpty: true })
    }
  }

  if (sticker) {
    sticker.deleted = true
    sticker.deletedAt = new Date()
    await sticker.save()
  }

  coedit.track(ctx.db, stickerSet, ctx.from, 'delete', { fileUniqueId: sticker?.fileUniqueId })

  // Restore needs the same right as delete within the pack; a group admin
  // deleting through group rights used to get a button that always failed.
  const buttons = sticker && (isOwnerOf(ctx, stickerSet) || coedit.can(target.access, 'delete'))
    ? [{ ...Markup.callbackButton(ctx.i18n.t('callback.sticker.btn.restore'), `restore_sticker:${sticker.fileUniqueId}`), style: 'success' }]
    : []

  return {
    ok: {
      text: `${ctx.i18n.t('callback.sticker.delete')}\n\n📦 <i>${escapeHTML(stickerSet.title)}</i>`,
      extra: { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(buttons) }
    }
  }
}

// delete_sticker:<file_unique_id> — the "Delete" button.
module.exports = async (ctx) => {
  const replyTo = ctx.callbackQuery.message?.reply_to_message
  const result = await deleteSticker(ctx, ctx.match[2], replyTo?.sticker)

  if (result.error) return ctx.answerCbQuery(result.error, true)

  await ctx.answerCbQuery(ctx.i18n.t('callback.sticker.answerCbQuery.delete'))
  await safeEditMessage(ctx, result.ok.text, result.ok.extra)
}

module.exports.deleteSticker = deleteSticker
