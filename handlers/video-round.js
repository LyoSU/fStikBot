module.exports = async (ctx) => {
  ctx.session.userInfo.roundVideo = !ctx.session.userInfo.roundVideo
  if (ctx.session.userInfo.roundVideo) {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.round_video.enabled'), {
      reply_to_message_id: ctx.message.message_id
    })
  } else {
    await ctx.replyWithHTML(ctx.i18n.t('cmd.round_video.disabled'), {
      reply_to_message_id: ctx.message.message_id
    })
  }
}
