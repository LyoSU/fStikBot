module.exports = async (ctx) => {
  let shardedUserId = ctx?.message?.forward_from?.id || ctx?.message?.users_shared?.user_ids[0]

  if (!shardedUserId) {
    return ctx.replyWithHTML(ctx.i18n.t('userAbout.forward_hidden'), {
      reply_markup: {
        keyboard: [
          [{
            text: ctx.i18n.t('userAbout.select_user'),
            request_users: {
              request_id: 1,
              user_is_bot: false,
              max_quantity: 1,
            }
          }],
          [
            ctx.i18n.t('scenes.btn.cancel')
          ]
        ],
        resize_keyboard: true
      }
    })
  }

  const findPacks = await ctx.db.StickerSet.find({
    ownerTelegramId: shardedUserId
  })

  let chunkedPacks = []
  const chunkSize = 70

  if (findPacks.length > 0) {
    chunkedPacks = (findPacks.map((pack) => {
      if (pack.name.toLowerCase().endsWith('fStikBot'.toLowerCase()) && pack.public !== true) {
        if (
          ctx.from.id === shardedUserId
          || ctx.from.id === ctx.config.mainAdminId
          || ctx?.session?.userInfo?.adminRights.includes('pack')
        ) {
          return `<a href="https://t.me/addstickers/${pack.name}"><s>${pack.name}</s></a>`
        } else {
          return '<i>[hidden]</i>'
        }
      }
      return `<a href="https://t.me/addstickers/${pack.name}">${pack.name}</a>`
    })).reduce((resultArray, item, index) => {
      const chunkIndex = Math.floor(index / chunkSize)

      if (!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = []
      }

      resultArray[chunkIndex].push(item)

      return resultArray
    }, [])
  }

  let packsToReturn

  if (chunkedPacks.length > 0) {
    packsToReturn = chunkedPacks.shift()
  }

  await ctx.replyWithHTML(ctx.i18n.t('userAbout.result', {
    userId: shardedUserId,
    packs: packsToReturn ? packsToReturn.join(', ') : ctx.i18n.t('userAbout.no_packs')
  }))

  if (chunkedPacks && chunkedPacks.length > 1) {
    for (let i = 1; i < chunkedPacks.length; i++) {
      await ctx.replyWithHTML(chunkedPacks[i].join(', '))
    }
  }
}
