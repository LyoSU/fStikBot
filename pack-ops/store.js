// MongoDB-backed store and pack lock for pack-ops/execute.js. The lock lives
// next to the commit state rather than in Redis: one database to reason about
// after a crash, and the bot already depends on it for everything else.

const crypto = require('crypto')

// Mongo hands back a Binary from lean queries (its buffer may be longer than
// the data: `position` is the length), a Buffer from documents.
const bytesOf = (data) => {
  if (Buffer.isBuffer(data)) return data
  if (data?.buffer) return Buffer.from(data.buffer.subarray(0, data.position ?? data.buffer.length))
  return Buffer.from(data)
}

/**
 * @param {Object} db the bot's database (database/index.js)
 */
function mongoStore (db) {
  return {
    async create (commit) {
      const doc = await db.PackCommit.create(commit)
      return doc.toObject()
    },
    async load (id) {
      return db.PackCommit.findById(id).lean()
    },
    async save (commit) {
      await db.PackCommit.replaceOne({ _id: commit._id }, commit)
    }
  }
}

/**
 * Uploaded Studio files, for the steps that send one themselves.
 * @param {Object} db the bot's database (database/index.js)
 */
function mongoAssets (db) {
  return {
    async load (id) {
      const asset = await db.StudioAsset.findById(id).select('format data').lean()
      return asset && { format: asset.format, data: bytesOf(asset.data) }
    }
  }
}

/**
 * @param {Object} db the bot's database (database/index.js)
 */
function mongoLock (db) {
  return {
    // Takes the lock if it is free or expired; null when someone holds it.
    async acquire (name, ttlMs) {
      const token = crypto.randomUUID()
      const now = Date.now()
      try {
        await db.PackLock.updateOne(
          { _id: name, expiresAt: { $lt: new Date(now) } },
          { $set: { token, expiresAt: new Date(now + ttlMs) } },
          { upsert: true }
        )
        return token
      } catch (err) {
        // The row exists and hasn't expired: the upsert's insert collides.
        if (err?.code === 11000) return null
        throw err
      }
    },
    async extend (name, token, ttlMs) {
      const result = await db.PackLock.updateOne({ _id: name, token }, { $set: { expiresAt: new Date(Date.now() + ttlMs) } })
      return result.matchedCount === 1
    },
    async release (name, token) {
      await db.PackLock.deleteOne({ _id: name, token })
    }
  }
}

/**
 * The bot's own records of a pack Studio has just made, the way the /new
 * wizard leaves them: the pack document, the owner's current pack, and the
 * cached pack counts reset so /packs recounts. Safe to repeat.
 *
 * @param {Object} db the bot's database (database/index.js)
 * @returns {(commit: Object) => Promise<*>} the pack document's id
 */
function mongoRegister (db) {
  return async (commit) => {
    const owner = await db.User.findOne({ telegram_id: commit.ownerTelegramId }).select('_id').lean()
    const packType = commit.packType || 'regular'

    let pack = await db.StickerSet.findOne({ name: commit.name, ownerTelegramId: commit.ownerTelegramId }).select('_id').lean()
    if (!pack) {
      // Replaces a stale document of the same name, like the wizard does.
      pack = await db.StickerSet.newSet({
        owner: owner?._id,
        ownerTelegramId: commit.ownerTelegramId,
        name: commit.name,
        title: commit.create.formattedTitle,
        packType,
        // A copy starts with Boost, as the wizard's does (copyEarnsBoost in
        // execute.js; a commit planned before it was there keeps its flag).
        boost: commit.create.copyBoost ?? !!commit.boost,
        emojiSuffix: '🌟',
        create: true
      })
    }

    if (owner) {
      await db.User.updateOne(
        { _id: owner._id },
        { $set: { stickerSet: pack._id, [`packsCount.${packType}`]: 0 } }
      )
    }
    return pack._id
  }
}

module.exports = { mongoStore, mongoLock, mongoAssets, mongoRegister, bytesOf }
