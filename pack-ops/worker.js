// Studio publish worker. The API queues a commit (a draft of a pack plus the
// files it needs, stored as studioassets); this picks it up and carries it
// through, one commit at a time per process:
//
//   queued → preparing   upload the draft's files to Telegram
//          → pending     publishCommit (pack-ops/execute.js) runs it
//          → succeeded   then the bot's own sticker docs are synced
//
// Several bot processes may run it side by side: the claim is one atomic
// update, the publish takes the pack lock, and the sync is idempotent.
// See pack-ops/README.md.

const { runInCopyScope } = require('../utils/retry-api')
const { LOCK_TTL_MS, ownerProblem } = require('./execute')
const { bytesOf } = require('./store')
const log = require('../utils/logger').scope('pack-ops:worker')
const { logError, logEvent } = require('../utils/error-line')
const { logUid } = require('../utils/log-uid')
const { normalize } = require('../utils/fingerprint')
const { emojiContext } = require('./emoji')
const { redactBotToken } = require('../utils/telegram-error')

const TICK_INTERVAL_MS = parseInt(process.env.STUDIO_TICK_INTERVAL_MS, 10) || 2000
// A `preparing` claim older than this is a dead process's. Uploads refresh it.
const CLAIM_STALE_MS = 2 * 60 * 1000
const CLAIM_HEARTBEAT_MS = 30 * 1000
// A failing sync is retried after 10 s, 20 s, 40 s … up to 10 min, and given up
// after this many tries (synced stays false, syncError says why).
const SYNC_MAX_ATTEMPTS = 10
// A refund left owed is tried again once its commit is this old.
const REFUND_RETRY_MS = 60 * 1000
const syncBackoffMs = (attempts) => Math.min(2 ** attempts * 5000, 10 * 60 * 1000)

// Same split as the executor: an answer from Telegram is final, anything else
// (a timeout, a reset connection) says nothing about what Telegram did.
const errorCode = (err) => err?.code ?? err?.response?.error_code
// Stored on the commit and shown in Studio: never with the bot token in it.
const errorText = (err) => redactBotToken(err?.description || err?.response?.description || err?.message || String(err))
const formatOf = (sticker) => (sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static')
const isRefusal = (err) => Number.isInteger(errorCode(err)) && errorCode(err) >= 400 && errorCode(err) < 500 && errorCode(err) !== 429

// What a commit did, for the log line: never its pack's name or its owner.
const opOf = (commit) => (commit.remove ? 'remove' : commit.create ? 'create' : 'edit')
// Who published it, as the salted hash Studio's API lines carry too.
const uidOf = (commit) => logUid(commit.actorTelegramId ?? commit.ownerTelegramId)

// A failure's reason as a code that stays the same between two commits: the
// worker's own (copy_missing), Telegram's (STICKERSET_INVALID), or else the
// text without ids and numbers.
function commitCode (error) {
  const text = String(error || 'unknown')
  if (/^[a-z][a-z_]*$/.test(text)) return text
  const token = text.match(/\b[A-Z][A-Z0-9_]{3,}\b/)
  if (token) return token[0]
  return normalize(text.replace(/\b\w+_by_\w+\b/gi, '<pack>')).slice(0, 80)
}

// The owner's to fix (start or unblock the bot), not the worker's fault.
const OWNER_CODES = new Set(['bot_not_started', 'bot_blocked'])

// Where a commit stopped: its phase once the run gave it one; before that,
// uploading its files (prepare), or in the run, making the new pack
// (createPack) or planning the steps (plan).
function phaseOf (commit, ran) {
  if (commit.phase) return commit.phase
  if (!ran) return 'prepare'
  return commit.create && commit.create.state !== 'done' ? 'createPack' : 'plan'
}

// A commit that ended without publishing, as one JSON line. A conflict is the
// pack changing under the draft and an owner code the owner's to fix, so
// warnings; any other failure is an error. `ran`: it got past prepare.
function logOutcome (commit, { ran = false } = {}) {
  if (!commit || (commit.status !== 'failed' && commit.status !== 'conflict')) return
  const code = commitCode(commit.error)
  const op = opOf(commit)
  logError(code, {
    kind: 'pack_commit',
    where: `pack_commit:${op}`,
    level: commit.status === 'conflict' || OWNER_CODES.has(code) ? 'warn' : 'error',
    fields: {
      status: commit.status,
      code,
      op,
      phase: phaseOf(commit, ran),
      commitId: String(commit._id),
      packType: commit.packType,
      uid: uidOf(commit),
      // Which sticker's emoji Telegram refused; its error doesn't say.
      ...emojiContext(commit)
    }
  })
}

// A published commit, as one info line beside the failures': how big it was
// and how long it took from the tap on "Publish", queue and uploads included.
function logDone (commit, at = new Date()) {
  if (commit?.status !== 'succeeded') return
  const op = opOf(commit)
  const stickers = commit.remove ? 0 : (commit.draft || []).length
  const ops = (commit.steps || []).length
  const durationMs = commit.createdAt ? at - new Date(commit.createdAt) : undefined
  logEvent('pack_commit', `${op} done: ${stickers} stickers, ${ops} steps`, {
    fields: { status: 'done', op, packType: commit.packType, stickers, ops, durationMs, commitId: String(commit._id), uid: uidOf(commit) }
  })
}

/**
 * @param {Object} deps
 * @param {Object} deps.repo database access (worker-repo.js)
 * @param {{save: Function}} deps.store commit persistence (store.js)
 * @param {{callApi: Function}} deps.telegram
 * @param {Function} deps.publish (commitId) => commit, runs a pending commit
 * @param {Function} [deps.now]
 */
function createWorker ({ repo, store, telegram, publish, now = () => new Date() }) {
  let timer = null
  let active = null
  let stopping = false

  const uploadsOf = (commit) => commit.draft.filter((item) => item.file)

  // A sticker copied from another set goes in by the file_id this bot is
  // given for it: the API reads sets with a token of its own, and a file_id is
  // only good for the bot it was issued to. file_unique_id is the same for both.
  async function copiedSticker (sets, copy) {
    if (!sets.has(copy.set)) {
      const set = await runInCopyScope(() => telegram.callApi('getStickerSet', { name: copy.set }))
        .catch((err) => {
          if (isRefusal(err)) return { stickers: [] }
          throw err
        })
      sets.set(copy.set, set)
    }
    return sets.get(copy.set).stickers.find((sticker) => sticker.file_unique_id === copy.fileUniqueId)
  }

  // A sticker brought back from the pack's archive goes in by the file_id its
  // row has; the original upload's is kept as the fallback for the executor.
  // Null when the pack has no such archived sticker.
  // A restored pack has no document yet (`~new:`): its stickers are the rows of
  // the deleted one.
  async function restoredSticker (commit, restore) {
    const from = commit.create?.restoreFrom
    const pack = from ? { _id: from } : await repo.findPack(commit)
    const row = pack && await repo.findArchived(pack._id, restore.fileUniqueId, now())
    if (!row?.fileId) return null
    return {
      fileId: row.fileId,
      fallbackFileId: row.originalFileId && row.originalFileId !== row.fileId ? row.originalFileId : undefined,
      format: row.format
    }
  }

  // Uploads every file the draft still lacks a file_id for, saving the commit
  // after each so a crash resumes with the rest. Returns the commit with its
  // new status.
  async function prepare (commit) {
    const heartbeat = setInterval(() => {
      repo.touchClaim(commit._id, now()).catch((err) => log.warn('claim heartbeat failed:', err.message))
    }, CLAIM_HEARTBEAT_MS)
    heartbeat.unref()

    const settle = async (status, error = null) => {
      commit.status = status
      commit.error = error
      commit.updatedAt = now()
      await store.save(commit)
      return commit
    }

    const sets = new Map()

    try {
      for (const item of uploadsOf(commit)) {
        if (item.file.fileId) continue

        if (item.file.copy) {
          const sticker = await copiedSticker(sets, item.file.copy)
          if (!sticker) return await settle('failed', 'copy_missing')
          item.file.fileId = sticker.file_id
          item.file.format = formatOf(sticker)
          commit.updatedAt = now()
          await store.save(commit)
          continue
        }

        if (item.file.restore) {
          const sticker = await restoredSticker(commit, item.file.restore)
          if (!sticker) return await settle('failed', 'restore_unavailable')
          item.file.fileId = sticker.fileId
          if (sticker.fallbackFileId) item.file.fallbackFileId = sticker.fallbackFileId
          if (sticker.format) item.file.format = sticker.format
          commit.updatedAt = now()
          await store.save(commit)
          continue
        }

        const asset = await repo.loadAsset(item.file.studioAssetId)
        if (!asset) return await settle('failed', 'asset_missing')

        // A file_id from an earlier attempt, if it was made for this owner.
        let fileId = asset.fileId && asset.fileOwner === commit.ownerTelegramId ? asset.fileId : null
        if (!fileId) {
          // Its bytes went once Telegram had it for another owner; Studio
          // sends the file again for this one.
          if (!asset.data) return await settle('failed', 'asset_missing')
          const uploaded = await runInCopyScope(() => telegram.callApi('uploadStickerFile', {
            user_id: commit.ownerTelegramId,
            sticker: { source: bytesOf(asset.data) },
            sticker_format: item.file.format || asset.format
          }))
          fileId = uploaded.file_id
          // Telegram has the file now: its bytes leave the database, unless
          // this commit still sends them itself, as the pack's thumbnail.
          const keepData = commit.settings?.thumbnail?.assetId === String(asset._id)
          await repo.setAssetFileId(asset._id, fileId, commit.ownerTelegramId, { keepData })
        }

        item.file.fileId = fileId
        commit.claimedAt = now()
        commit.updatedAt = now()
        await store.save(commit)
      }
      return await settle('pending')
    } catch (err) {
      // An owner who hasn't started the bot, or blocked it, is theirs to fix.
      const owner = isRefusal(err) && ownerProblem(err)
      if (owner) {
        log.info(`commit ${commit._id} preparing stopped: ${owner}`)
        return settle('failed', owner)
      }
      log.warn(`commit ${commit._id} preparing stopped:`, errorText(err))
      return settle(isRefusal(err) ? 'failed' : 'interrupted', errorText(err))
    } finally {
      clearInterval(heartbeat)
    }
  }

  // Makes the bot's sticker docs match the pack as published. Reads the pack
  // back from Telegram rather than trusting the commit: file_ids and the final
  // order are Telegram's.
  async function sync (commit) {
    const pack = await repo.findPack(commit)
    if (!pack) {
      log.warn(`commit ${commit._id}: pack ${commit.name} is not in the database, nothing to sync`)
      return repo.markSynced(commit._id)
    }

    // A deleted set: the bot's records say so, as after its own "Delete pack".
    if (commit.remove) {
      // The owner's own delete: restorable, with the order the pack had.
      const order = (commit.base || []).filter((uid) => uid !== pack.placeholderFileUniqueId)
      await repo.writeRemoved(pack, now(), { order })
      await repo.markSynced(commit._id)
      log.info(`commit ${commit._id}: ${commit.name} deleted`)
      return
    }

    const set = await telegram.callApi('getStickerSet', { name: commit.name })
    const inPack = new Map(set.stickers.map((s) => [s.file_unique_id, s]))

    const stickers = []
    for (const item of commit.draft) {
      const sticker = inPack.get(commit.mapping?.[item.assetId])
      if (!sticker) continue
      stickers.push({
        fileUniqueId: sticker.file_unique_id,
        fileId: sticker.file_id,
        format: formatOf(sticker),
        thumbFileId: sticker.thumbnail?.file_id,
        emojiList: item.emojiList,
        keywords: item.keywords
      })
    }

    const live = await repo.liveStickerUids(pack._id)
    const deletedUids = live.filter((uid) => !inPack.has(uid))
    // Where each removed sticker stood, for the archive: the pack as it was
    // before the commit (`base`). One not in it has no known place.
    const positions = {}
    for (const uid of deletedUids) {
      const at = (commit.base || []).indexOf(uid)
      if (at >= 0) positions[uid] = { position: at, after: commit.base[at - 1] ?? null }
    }
    await repo.writeSync(pack._id, {
      stickers,
      deletedUids,
      positions,
      placeholderUid: pack.placeholderFileUniqueId || undefined,
      clearPlaceholder: !!pack.placeholderFileUniqueId && !inPack.has(pack.placeholderFileUniqueId),
      // The title as Telegram has it, suffix and all.
      title: commit.settings?.title !== undefined ? set.title : undefined
    }, now())
    // A restored sticker that came back as a different file sits in the pack
    // under its new uid; the archived row is marked so it isn't offered again.
    // (Under the same uid the upsert above has already flipped the row back.)
    // A restored pack's rows are the deleted pack's, not this one's. The first
    // batch of a create lost its `file` when the pack was made (`restoredUid`).
    const archivePack = commit.create?.restoreFrom || pack._id
    for (const item of commit.draft) {
      const was = item.file?.restore?.fileUniqueId || item.restoredUid
      const uid = was && commit.mapping?.[item.assetId]
      if (uid && inPack.has(uid) && uid !== was) {
        await repo.markRestored(archivePack, was, now())
      }
    }
    await repo.markSynced(commit._id)
    log.info(`commit ${commit._id}: synced ${stickers.length} stickers of ${commit.name}`)
  }

  // A sync that fails is scheduled again later instead of retried every tick.
  async function trySync (commit) {
    try {
      await sync(commit)
    } catch (err) {
      const attempts = (commit.syncAttempts || 0) + 1
      const after = new Date(now().getTime() + syncBackoffMs(attempts))
      await repo.recordSyncFailure(commit._id, { attempts, after, error: errorText(err) })
      const outcome = attempts >= SYNC_MAX_ATTEMPTS ? 'giving up' : `retrying after ${after.toISOString()}`
      log.warn(`commit ${commit._id}: sync failed (attempt ${attempts}), ${outcome}:`, errorText(err))
    }
  }

  // A copy into another pack type is paid for when the API takes it. A commit
  // that ends without making the pack gives the credit back, as the /new
  // wizard does when its copy fails.
  async function refundIfUnmade (commit) {
    const { charge } = commit || {}
    if (!charge?.credits || charge.refunded) return
    if (commit.status !== 'failed' && commit.status !== 'conflict') return
    if (commit.create && ['created', 'done'].includes(commit.create.state)) return

    try {
      if (await repo.refundCharge(commit._id, charge)) log.info(`commit ${commit._id}: ${charge.credits} credit(s) refunded`)
      charge.refunded = true
    } catch (err) {
      logError(err, { where: 'pack_commit:refund', fields: { commitId: String(commit._id) } })
      // findUnrefunded tries again once this has aged.
      await repo.touch(commit._id, now()).catch(() => {})
    }
  }

  // A pack Telegram no longer has (deleted in @Stickers or a Telegram app) is
  // marked deleted, as after the bot's own delete, so neither Studio nor the
  // bot offers it again. The commit is final either way; a failed write here
  // happens again on the next commit that finds the pack gone.
  async function writeGone (commit) {
    try {
      const pack = await repo.findPack(commit)
      if (pack) await repo.writeRemoved(pack, now())
      log.info(`commit ${commit._id}: ${commit.name} is gone from Telegram, marked deleted`)
    } catch (err) {
      logError(err, { where: 'pack_commit:mark_deleted', fields: { commitId: String(commit._id) } })
    }
  }

  async function run (commit) {
    const result = await publish(commit._id)
    if (result?.status === 'succeeded') {
      logDone(result, now())
      await trySync(result)
    } else {
      logOutcome(result, { ran: true })
      if (result?.packGone) await writeGone(result)
      await refundIfUnmade(result)
    }
    return result
  }

  // One unit of work. Returns false when there was nothing to do.
  async function step () {
    const claimed = await repo.claimForPrepare(now(), CLAIM_STALE_MS)
    if (claimed) {
      const prepared = await prepare(claimed)
      if (prepared.status === 'pending') await run(prepared)
      else {
        logOutcome(prepared)
        await refundIfUnmade(prepared)
      }
      return true
    }

    const runnable = await repo.findRunnable(now(), LOCK_TTL_MS)
    if (runnable) {
      await run(runnable)
      return true
    }

    // A refund a dead process or a failed write left owed.
    const owed = await repo.findUnrefunded(now(), REFUND_RETRY_MS)
    if (owed) {
      await refundIfUnmade(owed)
      return true
    }

    // Last, so a commit whose sync keeps failing doesn't hold up the others.
    const unsynced = await repo.findUnsynced(now(), SYNC_MAX_ATTEMPTS)
    if (unsynced) {
      await trySync(unsynced)
      return true
    }
    return false
  }

  async function tick () {
    if (active || stopping) return
    active = (async () => {
      try {
        // Keep going while there is work: no need to wait a tick between commits.
        let worked
        do {
          worked = !stopping && await step()
        } while (worked)
      } catch (err) {
        logError(err, { where: 'pack-ops:tick' })
      } finally {
        active = null
      }
    })()
    await active
  }

  function start () {
    if (timer) return
    log.info(`studio worker started (interval=${TICK_INTERVAL_MS}ms)`)
    timer = setInterval(() => { tick() }, TICK_INTERVAL_MS)
    timer.unref()
  }

  // Lets the commit in hand finish its current run (it is resumable anyway),
  // starts no new one.
  async function stop () {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
    if (active) await active.catch(() => {})
  }

  return { start, stop, tick, step, prepare, sync }
}

let instance = null

// The bot's worker, wired to the real database and Telegram client. Built on
// first use so requiring this file stays free of side effects.
function getWorker () {
  if (!instance) {
    const { db } = require('../database')
    const telegram = require('../utils/telegram')
    const { publishCommit, mongoStore } = require('./index')
    const { mongoRepo } = require('./worker-repo')
    instance = createWorker({
      repo: mongoRepo(db),
      store: mongoStore(db),
      telegram,
      publish: (id) => publishCommit(db, telegram, id)
    })
  }
  return instance
}

module.exports = {
  createWorker,
  commitCode,
  logOutcome,
  logDone,
  getWorker,
  start: () => getWorker().start(),
  stop: () => (instance ? instance.stop() : Promise.resolve())
}
