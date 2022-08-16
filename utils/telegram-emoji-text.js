const got = require('got')
const Telegram = require('telegraf/telegram')

const telegram = new Telegram(process.env.BOT_TOKEN)

module.exports = async () => {
  const result = await got.post('https://translations.telegram.org/ru/emoji', {
    headers: {
      'X-Requested-With': 'XMLHttpRequest'
    }
  }).json()

  console.log(result.s.initKeywords)

  const stickerSet = await telegram.getStickerSet('Crocosaurus')

  stickerSet.stickers.forEach(element => {
    result.s.initKeywords.forEach(keyword => {
      if (element.emoji.includes(keyword.e)) {
        console.log(keyword.k, keyword.e)
      }
    })
  })
}
