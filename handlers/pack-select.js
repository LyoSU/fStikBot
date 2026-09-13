const { sendPackMenu, isOwner } = require('./pack-menu')
const { flushPendingStickers } = require('./sticker')

// Select a pack by passcode: a co-edit link (/start s_<passcode>) or /public.
module.exports = async (ctx) => {
  const { userInfo } = ctx.session

  let passcode
  if (ctx.startPayload) passcode = ctx.startPayload.match(/^s_(.+)$/)?.[1]
  if (ctx.message?.text === '/public') passcode = 'public'

  // Without this guard findOne({ passcode: undefined }) matched the first pack
  // without a passcode — a stranger's pack, selected for the caller.
  const stickerSet = passcode
    ? await ctx.db.StickerSet.findOne({ passcode, deleted: { $ne: true } })
    : null

  // A hidden pack is only reachable by its owner — a co-edit link shouldn't
  // resurrect a pack the owner deliberately took out of the list.
  if (!stickerSet || (stickerSet.hide === true && !isOwner(ctx, stickerSet))) {
    return ctx.replyWithHTML(ctx.i18n.t('callback.pack.answerCbQuer.not_found'))
  }

  // Knowing the passcode IS the co-edit grant.
  if (stickerSet.inline) userInfo.inlineStickerSet = stickerSet
  userInfo.stickerSet = stickerSet

  await sendPackMenu(ctx, stickerSet)
  flushPendingStickers(ctx, stickerSet)
}
