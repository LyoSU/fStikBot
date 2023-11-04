const https = require('https')
const got = require('got')
const FormData = require('form-data')
const sharp = require('sharp')
const gm = require('gm').subClass({ imageMagick: '7+' })
const temp = require('temp')
const Scene = require('telegraf/scenes/base')
const Queue = require('bull')

const downloadFileByUrl = (fileUrl) => new Promise((resolve, reject) => {
  const data = []

  https.get(fileUrl, (response) => {
    response.on('data', (chunk) => {
      data.push(chunk)
    })

    response.on('end', () => {
      resolve(Buffer.concat(data))
    })
  }).on('error', reject)
})

const uploadFile = async (file) => {
  const telegraphBaseUrl = 'https://telegra.ph'
  const form = new FormData()

  form.append('data', file, {
    filename: 'file'
  })

  return new Promise((resolve, reject) => {
    form.submit(telegraphBaseUrl + '/upload', (err, res) => {
      if (err) return reject(err)
      let data = ''

      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (result[0] && result[0].src) {
            resolve(telegraphBaseUrl + result[0].src)
          } else {
            resolve(result)
          }
        } catch (error) {
          reject(Error(`Failed to upload the image to Telegram server, rsponse: ${data}, error: ${error}`))
        }
      })
      res.on('error', reject)
    })
  })
}

const removeBackground = async (file) => {
  return new Promise((resolve, reject) => {
    temp.open({ suffix: '.webp' }, async (err, info) => {
      if (err) {
        return reject(err)
      }

      gm(file, 'image.jpg')
        .fuzz('6%')
        .fill('none')
        .draw('alpha 0,0 floodfill')
        .channel('alpha')
        .blur('0x5')
        .level('50x100%')
        .channel('alpha')
        .setFormat('webp')
        .write(info.path, (err) => {
          if (err) {
            return reject(err)
          }

          resolve(info.path)
        })
    })
  })
}

const removebgQueue = new Queue('removebg', {
  redis: {
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    password: process.env.REDIS_PASSWORD
  }
})

const aiSticker = new Scene('aiSticker')

aiSticker.enter(async (ctx) => {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery()
    await ctx.deleteMessage().catch(() => {})
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.aiSticker.send_text'), {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: ctx.i18n.t('scenes.aiSticker.cancel'),
            callback_data: 'cancel'
          }
        ]
      ]
    }
  })
})

aiSticker.on('text', async (ctx) => {
  const message = await ctx.replyWithHTML(ctx.i18n.t('scenes.aiSticker.processing'))

  const text = ctx.message.text

  const response = await got.get(`http://localhost:8333/?q=${text}`).json().catch((err) => {
    return err
  })

  if (!response.result) {
    // something went wrong
    return ctx.reply('error')
  }

  // const response = {
  //   result: {
  //     Upscales: [
  //       {
  //         uri: 'https://cdn.discordapp.com/ephemeral-attachments/1159135117827113063/1159168743985905765/Ly_cartoon_vector_white_background_of_a_Yuri_Ly_sticker_0ef58265-e7d6-4ea9-9c3a-2ffb2aa8fa69.png?ex=651ee784&is=651d9604&hm=1a9a5431da4f252269025446fdcbe5604e4e90930e453b7eaab1d6b706dfd202&'
  //       },
  //       {
  //         uri: 'https://cdn.discordapp.com/ephemeral-attachments/1159135117827113063/1159168768208023673/Ly_cartoon_vector_white_background_of_a_Yuri_Ly_sticker_366f4cc1-fbec-44f7-826c-9acf6a2d5fef.png?ex=651ee78a&is=651d960a&hm=9b1ae15a6149e495c93ba514debff1beb9253bd2431d3eb9096f6f5e171ab5c1&'
  //       }
  //     ]
  //   }
  // }

  const promises = response.result.Upscales.map(async (upscale) => {
    // const timeoutPromise = new Promise((resolve, reject) => {
    //   setTimeout(() => {
    //     reject(new Error('Timeout'))
    //   }, 1000 * 20)
    // })

    // const job = await removebgQueue.add({
    //   fileUrl: upscale.uri,
    //   model: 'isnet-general-use'
    // }, {
    //   priority: 1,
    //   attempts: 1,
    //   removeOnComplete: true
    // })

    // const finish = await Promise.race([job.finished(), timeoutPromise]).catch(err => {
    //   return {
    //     error: err.message
    //   }
    // })

    // if (finish.error) {
    //   return ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.error'))
    // }

    // const trimBuffer = await sharp(Buffer.from(finish.content, 'base64'))
    //   .trim()
    //   .webp()
    //   .toBuffer()

    // return trimBuffer

    const file = await downloadFileByUrl(upscale.uri)

    const jpgBuffer = await sharp(file)
      .jpeg()
      .toBuffer()

    const trimUrl = await removeBackground(jpgBuffer)

    return trimUrl
  })

  const images = await Promise.all(promises)

  // send images
  for (const image of images) {
    ctx.replyWithDocument({
      source: image,
      filename: 'image.webp'
    })
  }
})

aiSticker.on('photo', async (ctx) => {
  const message = await ctx.replyWithHTML(ctx.i18n.t('scenes.aiSticker.processing'))

  const photo = ctx.message.photo[ctx.message.photo.length - 1]

  const fileUrl = await ctx.telegram.getFileLink(photo.file_id)

  const file = await downloadFileByUrl(fileUrl)

  const telegraphUrl = await uploadFile(file)

  const text = ctx.message.caption || ''

  const response = await got.get(`http://localhost:8333/?photo=${telegraphUrl}&q=${text}`).json().catch((err) => {
    return err
  })

  if (!response.result) {
    // something went wrong
    return ctx.reply('error')
  }

  const promises = response.result.Upscales.map(async (upscale) => {
    const timeoutPromise = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('Timeout'))
      }, 1000 * 20)
    })

    const job = await removebgQueue.add({
      fileUrl: upscale.uri,
      model: 'anime-seg'
    }, {
      priority: 1,
      attempts: 1,
      removeOnComplete: true
    })

    const finish = await Promise.race([job.finished(), timeoutPromise]).catch(err => {
      return {
        error: err.message
      }
    })

    if (finish.error) {
      return ctx.replyWithHTML(ctx.i18n.t('scenes.photoClear.error'))
    }

    const trimBuffer = await sharp(Buffer.from(finish.content, 'base64'))
      .trim()
      .webp()
      .toBuffer()

    return trimBuffer
  })

  const images = await Promise.all(promises)

  // send images
  for (const image of images) {
    ctx.replyWithDocument({
      source: image,
      filename: 'image.webp'
    })
  }
})

module.exports = [
  aiSticker
]
