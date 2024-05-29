const Composer = require('telegraf/composer')

const composer = new Composer()

composer.use(async (ctx, next) => {
  if (ctx.updateType === 'message' && ctx.updateSubTypes.includes('text') && ctx.message.text.startsWith('/start')) {
    const params = ctx.message.text.split(' ')
    if (params.length > 1) {
      const deepLink = await ctx.db.DeepLink.findOne({ deepLink: params[1], user: ctx.session.userInfo._id })

      if (!deepLink) {
        await ctx.db.DeepLink.create({
          user: ctx.session.userInfo._id,
          deepLink: params[1]
        })
      }
    }
  }

  return next()
})

module.exports = composer
