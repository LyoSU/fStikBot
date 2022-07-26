module.exports = async (ctx) => {
  await ctx.replyWithHTML('👇', {
    reply_markup: JSON.stringify({
      inline_keyboard: [
        [
          {
            text: '🔍',
            web_app: {
              url: ctx.config.catalogUrl
            }
          }
        ]
      ]
    })
  })
}
