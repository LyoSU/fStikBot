const Markup = require('telegraf/markup')
const { escapeHTML } = require('../utils')
const packLink = require('../utils/pack-link')

// /pack <name> in a group — an admin picks one of their packs for the group.
module.exports = async (ctx, next) => {
  const packName = ctx.message.text.split(' ')[1]

  if (!packName) return next()

  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.packs.select_group_pack_info'), {
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    })
  }

  // The command carries a pack name; keep the group chat clean.
  await ctx.deleteMessage().catch(() => {})

  const isAdmin = await ctx.telegram.getChatAdministrators(ctx.chat.id)
    .then((admins) => admins.some((admin) => admin.user.id === ctx.from.id))
    .catch(() => false)

  // Used to delete the command and say nothing at all.
  if (!isAdmin) {
    return ctx.replyWithHTML(ctx.i18n.t('cmd.packs.group_admin_only'))
  }

  const stickerSet = await ctx.db.StickerSet.findOne({
    name: packName,
    owner: ctx.session.userInfo.id,
    deleted: { $ne: true }
  })
  const group = stickerSet && await ctx.db.Group.findOne({ telegram_id: ctx.chat.id })

  if (!stickerSet || !group) {
    return ctx.replyWithHTML(ctx.i18n.t('callback.pack.select_group.error'))
  }

  group.stickerSet = stickerSet
  group.updatedAt = new Date()
  await group.save()

  return ctx.replyWithHTML(ctx.i18n.t('callback.pack.select_group.success', {
    link: packLink(stickerSet),
    title: escapeHTML(stickerSet.title)
  }), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.select_group.access_rights.add'), 'group_settings add')],
      [Markup.switchToCurrentChatButton(ctx.i18n.t('callback.pack.select_group.access_rights.delete'), 'group_settings delete')]
    ]),
    disable_web_page_preview: true
  })
}
