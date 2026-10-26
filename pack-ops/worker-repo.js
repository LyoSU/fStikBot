// MongoDB side of the publish worker (pack-ops/worker.js): every query it
// makes lives here, so the worker itself can be tested against a fake.

const truncate = (str, max) => (str.length > max ? str.slice(0, max) : str)

/**
 * @param {Object} db the bot's database (database/index.js)
 */
function mongoRepo (db) {
  return {
    // A fresh queued commit, else a `preparing` one whose claim went stale
    // (the process that held it died). One atomic update, so two processes
    // never get the same commit.
    async claimForPrepare (now, staleMs) {
      const claim = { $set: { status: 'preparing', claimedAt: now } }
      const options = { sort: { createdAt: 1 }, returnDocument: 'after', lean: true }
      return await db.PackCommit.findOneAndUpdate({ status: 'queued' }, claim, options) ||
        db.PackCommit.findOneAndUpdate({ status: 'preparing', claimedAt: { $lt: new Date(now.getTime() - staleMs) } }, claim, options)
    },
    // Only while this process still holds the claim.
    async touchClaim (id, now) {
      await db.PackCommit.updateOne({ _id: id, status: 'preparing' }, { $set: { claimedAt: now } })
    },
    // Ready to publish, or `running` with nobody refreshing it any more. Packs
    // whose lock is held are skipped: they are being run (maybe through a long
    // 429 wait), and offering them again would starve the commits behind them.
    async findRunnable (now, staleMs) {
      const locked = await db.PackLock.find({ expiresAt: { $gt: now } }).select('_id').lean()
      return db.PackCommit.findOne({
        name: { $nin: locked.map((lock) => lock._id) },
        // A new pack changes its name once it is made; its lock keeps the first.
        lockName: { $nin: locked.map((lock) => lock._id) },
        $or: [
          { status: 'pending' },
          { status: 'running', updatedAt: { $lt: new Date(now.getTime() - staleMs) } }
        ]
      }).sort({ createdAt: 1 }).lean()
    },
    // Succeeded but not synced, if its retry is due and it hasn't been given up.
    async findUnsynced (now, maxAttempts) {
      return db.PackCommit.findOne({
        status: 'succeeded',
        synced: { $ne: true },
        syncAttempts: { $not: { $gte: maxAttempts } },
        $or: [{ syncAfter: null }, { syncAfter: { $lte: now } }]
      }).sort({ createdAt: 1 }).lean()
    },
    async recordSyncFailure (id, { attempts, after, error }) {
      await db.PackCommit.updateOne({ _id: id }, { $set: { syncAttempts: attempts, syncAfter: after, syncError: error } })
    },
    async markSynced (id) {
      await db.PackCommit.updateOne({ _id: id }, { $set: { synced: true }, $unset: { syncError: '' } })
    },

    async loadAsset (id) {
      return db.StudioAsset.findById(id).lean()
    },
    // The bytes are dropped with it unless `keepData`: a retry finds the
    // file_id on the commit, and Studio sends the file again if it is needed
    // for another owner.
    async setAssetFileId (id, fileId, owner, { keepData = false } = {}) {
      await db.StudioAsset.updateOne({ _id: id }, {
        $set: { fileId, fileOwner: owner },
        ...(keepData ? {} : { $unset: { data: '' } })
      })
    },

    // The credit and a mark of it on the user are one update, so it is paid
    // once however often this runs (two workers, a retry after a crash); the
    // commit is marked after. A crash in between leaves the commit unmarked,
    // and findUnrefunded brings it back. True when this call paid it.
    async refundCharge (id, charge) {
      const paid = await db.User.updateOne(
        { _id: charge.user, refundedCommits: { $ne: id } },
        { $inc: { balance: charge.credits }, $push: { refundedCommits: { $each: [id], $slice: -100 } } }
      )
      await db.PackCommit.updateOne({ _id: id }, { $set: { 'charge.refunded': true } })
      return paid.modifiedCount > 0
    },
    // A charge still owed back: the commit ended without making the pack, and
    // the refund didn't get marked (the process died, or the database failed).
    async findUnrefunded (now, afterMs) {
      return db.PackCommit.findOne({
        status: { $in: ['failed', 'conflict'] },
        'charge.credits': { $gt: 0 },
        'charge.refunded': { $ne: true },
        'create.state': { $nin: ['created', 'done'] },
        updatedAt: { $lt: new Date(now.getTime() - afterMs) }
      }).lean()
    },
    async touch (id, now) {
      await db.PackCommit.updateOne({ _id: id }, { $set: { updatedAt: now } })
    },

    async findPack (commit) {
      const query = commit.stickerSet ? { _id: commit.stickerSet } : { name: commit.name }
      return db.StickerSet.findOne(query).select('_id placeholderFileUniqueId owner editors packType').lean()
    },
    // What scenes/pack-delete.js writes after deleteStickerSet: the pack and its
    // stickers marked deleted, and nobody left with it as their current pack.
    // The owner's cached pack count is reset so /packs recounts.
    async writeRemoved (pack, now) {
      await db.StickerSet.updateOne({ _id: pack._id }, { $set: { deleted: true } })
      await db.Sticker.updateMany({ stickerSet: pack._id, deleted: { $ne: true } }, { $set: { deleted: true, deletedAt: now } })
      const members = (pack.editors || []).map((entry) => entry.telegramId).filter((id) => id != null)
      const users = { $or: [{ _id: pack.owner }, ...(members.length ? [{ telegram_id: { $in: members } }] : [])] }
      await db.User.updateMany({ ...users, stickerSet: pack._id }, { $set: { stickerSet: null } })
      await db.User.updateMany({ ...users, inlineStickerSet: pack._id }, { $set: { inlineStickerSet: null } })
      await db.User.updateOne({ _id: pack.owner }, { $set: { [`packsCount.${pack.packType || 'regular'}`]: 0 } })
    },
    async liveStickerUids (packId) {
      const docs = await db.Sticker.find({ stickerSet: packId, deleted: { $ne: true } }).select('fileUniqueId').lean()
      return docs.map((doc) => doc.fileUniqueId)
    },
    // `stickers`: [{ fileUniqueId, fileId, emojiList, keywords? }] as they are in
    // the pack now. Everything the pack no longer holds is marked deleted
    // (like the bot's own delete does), not removed.
    async writeSync (packId, { stickers, deletedUids, clearPlaceholder, title }, now) {
      if (stickers.length) {
        await db.Sticker.bulkWrite(stickers.map((s) => {
          const set = {
            emojis: truncate(s.emojiList.join(' '), 150),
            emojiList: s.emojiList,
            fileId: s.fileId,
            stickerType: 'sticker',
            deleted: false,
            deletedAt: null
          }
          const update = { $set: set }
          if (s.keywords?.length) set.keywords = s.keywords
          else if (s.keywords) update.$unset = { keywords: '' }
          return {
            updateOne: { filter: { stickerSet: packId, fileUniqueId: s.fileUniqueId }, update, upsert: true }
          }
        }))
      }
      if (deletedUids.length) {
        await db.Sticker.updateMany(
          { stickerSet: packId, fileUniqueId: { $in: deletedUids }, deleted: { $ne: true } },
          { $set: { deleted: true, deletedAt: now } }
        )
      }
      const update = { $set: { updatedAt: now } }
      if (title) update.$set.title = title
      if (clearPlaceholder) update.$unset = { placeholderFileUniqueId: '' }
      await db.StickerSet.updateOne({ _id: packId }, update)
    }
  }
}

module.exports = { mongoRepo }
