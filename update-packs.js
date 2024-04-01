const { telegramApi } = require('./utils')
const Telegram = require('telegraf/telegram')
const {
  db
} = require('./database')

const telegram = new Telegram(process.env.BOT_TOKEN)

let botInfo = null

telegram.getMe().then((info) => {
  botInfo = info
})

function decodeStickerSetId (u64) {
  let u32 = u64 >> 32n
  let u32l = u64 & 0xffffffffn

  if ((u64 >> 24n & 0xffn) === 0xffn) { // for 64-bit ids
    u32 = (u64 >> 32n) + 0x100000000n
    u32l = (u64 & 0xfn)
  }

  return {
    ownerId: parseInt(u32),
    setId: parseInt(u32l)
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

(async () => {
  while (true) {
    const stickersWithoutParentSet = await db.Sticker.aggregate([
      {
        $lookup: {
          from: "stickersets",
          localField: "stickerSet",
          foreignField: "_id",
          as: "parentSet",
        },
      },
      {
        $match: {
          parentSet: {
            $size: 0,
          },
        },
      },
      {
        $limit: 1000,
      },
      {
        $project: {
          _id: 1,
          stickerSet: 1,
        },
      }
    ])

    // delete many
    await db.Sticker.deleteMany({
      _id: {
        $in: stickersWithoutParentSet.map(sticker => sticker._id)
      }
    })
      .catch(err => console.error(err))
      .then(() => console.log(`Deleted ${stickersWithoutParentSet.length} stickers without parent set`));
    await new Promise(resolve => setTimeout(resolve, 60 * 1000));
  }
})();
