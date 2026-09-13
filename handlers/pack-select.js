const escapeHTML = require('../utils/html-escape')
const packLink = require('../utils/pack-link')
const coedit = require('../utils/coedit')
const { sendPackMenu, isOwner } = require('./pack-menu')
const { flushPendingStickers } = require('./sticker')

// Select a pack by passcode: a co-edit link (/start s_<passcode>) or /public.
// Opening someone's co-edit link makes you a member with the pack's default role.
module.exports = async (ctx) => {
  const { userInfo } = ctx.session

  let passcode
  if (ctx.startPayload) passcode = ctx.startPayload.match(/^s_(.+)$/)?.[1]
  if (ctx.message?.text === '/public') passcode = 'public'

  // Without this guard findOne({ passcode: undefined }) matched the first pack
  // without a passcode — a stranger's pack, selected for the caller.
  let stickerSet = passcode
    ? await ctx.db.StickerSet.findOne({ passcode, deleted: { $ne: true } })
    : null

  // A hidden pack is only reachable by its owner — a co-edit link shouldn't
  // resurrect a pack the owner deliberately took out of the list.
  if (!stickerSet || (stickerSet.hide === true && !isOwner(ctx, stickerSet))) {
    return ctx.replyWithHTML(ctx.i18n.t('callback.pack.answerCbQuer.not_found'))
  }

  let notice
  if (!isOwner(ctx, stickerSet) && passcode !== 'public') {
    const role = stickerSet.coedit?.defaultRole || coedit.DEFAULT_ROLE
    const joined = await coedit.addMember(ctx.db, stickerSet, ctx.from, userInfo._id, role)

    if (joined) {
      stickerSet = await ctx.db.StickerSet.findById(stickerSet._id)
      coedit.track(ctx.db, stickerSet, ctx.from, 'join')
      coedit.notify(ctx.db, ctx.telegram, stickerSet.owner, 'coedit.joined_notice', {
        name: escapeHTML(coedit.displayName(ctx.from)),
        title: escapeHTML(stickerSet.title),
        link: packLink(stickerSet)
      })
      notice = ctx.i18n.t('coedit.joined', {
        title: escapeHTML(stickerSet.title),
        role: coedit.roleLabel((key) => ctx.i18n.t(key), role)
      })
    }
  }

  if (stickerSet.inline) userInfo.inlineStickerSet = stickerSet
  userInfo.stickerSet = stickerSet

  await sendPackMenu(ctx, stickerSet, { notice })
  flushPendingStickers(ctx, stickerSet)
}
