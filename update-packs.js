const { telegramApi } = require('./utils')
const Telegram = require('telegraf/telegram')
const {
  db
} = require('./database')

const telegram = new Telegram(process.env.BOT_TOKEN)

function decodeStickerSetId (u64) {
  const u32 = u64 >> 32n
  const u32l = u64 & 0xffffffffn

  if ((u64 >> 24n & 0xffn) === 0xffn) {
    return {
      ownerId: parseInt((u64 >> 32n) + 0x100000000n),
      id: parseInt(u32l)
    }
  }
  return {
    ownerId: parseInt(u32),
    id: parseInt(u32l)
  }
}

async function processStickerSets(stickerSets) {
  const processedStickerSets = [];

  await Promise.all(stickerSets.map(async (stickerSet) => {
    try {
      if (stickerSet.owner) {
        await telegram.getStickerSet(stickerSet.name);

        const owner = await db.User.findById(stickerSet.owner).catch(() => null);

        if (owner) {
          stickerSet.ownerTelegramId = owner.telegram_id;
          await stickerSet.save();

          processedStickerSets.push(stickerSet);
          return;
        }
      }

      const stickerSetInfo = await telegramApi.client.invoke(new telegramApi.Api.messages.GetStickerSet({
        stickerset: new telegramApi.Api.InputStickerSetShortName({
          shortName: stickerSet.name
        }),
        hash: 0
      }));

      const ownerTelegramId = decodeStickerSetId(stickerSetInfo.set.id.value).ownerId;
      const owner = await db.User.findOne({ telegram_id: ownerTelegramId });

      if (owner) {
        stickerSet.owner = owner._id;
      }

      stickerSet.ownerTelegramId = ownerTelegramId;
      await stickerSet.save();

      processedStickerSets.push(stickerSet);
    } catch (err) {
      if (err.message.includes('STICKERSET_INVALID')) {
        console.log(`Sticker set https://t.me/addstickers/${stickerSet.name} is invalid, removing`);
        await stickerSet.remove();
      } else {
        console.error(`${stickerSet.name}: ${err.message}`);
      }
    }
  }));

  console.log(`Processed ${processedStickerSets.length} sticker sets`);

  return processedStickerSets;
}

(async () => {
  const batchSize = 50;

  const cursor = db.StickerSet.find({
    ownerTelegramId: { $exists: false }, // not processed yet
    createdAt: { $lt: new Date(Date.now() - 1000 * 60 * 60 * 24) }, // 24 hours ago
    inline: { $ne: true }, // not inline
  }).sort({
    _id: -1
  }).batchSize(batchSize).cursor();

  let batch = [];
  for await (const stickerSet of cursor) {
    batch.push(stickerSet);

    if (batch.length === batchSize) {
      await processStickerSets(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await processStickerSets(batch);
  }
})();
