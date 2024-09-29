const { db } = require('../database')
const OpenAI = require('openai')
const got = require('got')
const sharp = require('sharp')
const Telegram = require('telegraf/telegram')

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

const telegram = new Telegram(process.env.BOT_TOKEN)
const RELEVANT_CATEGORIES = [
  'sexual/minors',
  'violence/graphic',
  'self-harm',
  'hate',
  'harassment',
  'illicit/violent'
]

const SCORE_THRESHOLDS = {
  'sexual/minors': 0.2,
  'violence/graphic': 0.5,
  'self-harm': 0.5,
  'hate': 0.5,
  'harassment': 0.5,
  'illicit/violent': 0.5
}

async function combineImages (imageBuffers) {
  try {
    imageBuffers = imageBuffers.slice(0, 200)

    const resizedBuffers = await Promise.all(imageBuffers.map(async (buffer) => {
      const metadata = await sharp(buffer).metadata()
      const resizeOptions = metadata.width > metadata.height
        ? { width: 128 }
        : { height: 128 }
      return sharp(buffer).resize(resizeOptions).toBuffer()
    }))

    const imageWidth = 128
    const imageHeight = 128
    const columns = 5
    const rows = Math.ceil(resizedBuffers.length / columns)
    const combinedWidth = imageWidth * columns
    const combinedHeight = imageHeight * rows

    const compositeArray = resizedBuffers.map((buffer, index) => {
      const x = (index % columns) * imageWidth
      const y = Math.floor(index / columns) * imageHeight
      return { input: buffer, top: y, left: x }
    })

    const combinedImageBuffer = await sharp({
      create: {
        width: combinedWidth,
        height: combinedHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    }).composite(compositeArray).png().toBuffer()

    return combinedImageBuffer
  } catch (error) {
    console.error('Error combining images:', error)
    throw error
  }
}

async function moderateImage (fileLink, packTitle = '', packName = '') {
  try {
    const moderation = await openai.moderations.create({
      model: 'omni-moderation-latest',
      input: [
        { type: 'text', text: `User created sticker pack: ${packTitle} (${packName})` },
        {
          type: 'image_url',
          image_url: {
            url: fileLink
          }
        }
      ]
    })

    return moderation.results[0]
  } catch (error) {
    console.error('Error during NSFW check:', error)
    return null
  }
}

async function moderatePack (packName) {
  const stickers = await telegram.getStickerSet(packName).catch(() => null)

  if (!stickers || !stickers.stickers || stickers.stickers.length === 0) {
    return null
  }

  const stickerFiles = stickers.stickers.map((sticker) => sticker?.thumb?.file_id).filter((f) => f).slice(0, 200)

  const stickerImages = await Promise.all(stickerFiles.map(async (fileId) => {
    const fileLink = await telegram.getFileLink(fileId).catch(() => null)
    if (!fileLink) {
      return null
    }
    return got(fileLink, { responseType: 'buffer' }).then((response) => response.body)
  })).then((images) => images.filter((image) => image !== null))

  if (stickerImages.length === 0) {
    return null
  }

  const combinedImageBuffer = await combineImages(stickerImages)

  const moderation = await moderateImage(`data:image/png;base64,${combinedImageBuffer.toString('base64')}`, stickers.title, packName)

  if (!moderation) {
    return null
  }

  let isFlagged = false
  const categoryScores = {}

  for (const category of RELEVANT_CATEGORIES) {
    if (moderation.category_applied_input_types[category]) {
      if (moderation.category_scores[category] > SCORE_THRESHOLDS[category]) {
        isFlagged = true
        categoryScores[category] = moderation.category_scores[category]
      }
    }
  }

  return {
    name: packName,
    isFlagged,
    categoryScores
  }
}

async function moderatePacks (skip = 0) {
  const packs = await db.StickerSet.find({
    thirdParty: false,
    inline: { $ne: true },
    "aiModeration.checked": { $ne: true }
  }).sort({ createdAt: -1 }).skip(skip).limit(100).select('name').lean()

  const results = (await Promise.all(packs.map((pack) => moderatePack(pack.name)))).filter((result) => result !== null)

  results.filter((result) => result?.isFlagged).forEach((result) => {
    console.log(result)
  })

  await Promise.all(results.map(async (result) => {
    await db.StickerSet.updateOne({ name: result.name }, { $set: { aiModeration: { checked: true, isFlagged: result.isFlagged, categoryScores: result.categoryScores } } })
  }))

  return moderatePacks(skip + 100 - results.length)
}

// moderatePacks(50000)

module.exports = moderatePack
