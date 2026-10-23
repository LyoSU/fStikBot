// Telegram refuses a TGS whose rendered output never changes, and reports it as
// `400 Bad Request: wrong file type` — the same error it gives for a genuinely
// corrupt file. Measured against the Bot API: an identical pair of files where
// one has a single animated property is accepted and the static one is not.
//
// A file can end up static in two ways:
//
//   1. It was authored static (a logo, a still exported as Lottie).
//   2. It looks animated but its keyframes are dropped at parse time. rlottie
//      keeps a keyframe only when it carries an interpolator (`i`/`o`) or is a
//      hold (`h: 1`); anything else is discarded. A track whose keyframes all
//      lack those ends up marked animated with an empty keyframe list, so the
//      property evaluates to its zero value and the layer disappears.
//
// So the repair is two-step: first give dropped keyframes their interpolators
// back, because that restores what the author actually drew; only if the file
// is still static do we add motion of our own.

const zlib = require('zlib')

const MAX_TGS_BYTES = 64 * 1024

// Bodymovin's default ease, in the shape rlottie expects.
const ease = (n) => ({
  i: { x: Array(n).fill(0.667), y: Array(n).fill(1) },
  o: { x: Array(n).fill(0.333), y: Array(n).fill(0) }
})

const isKeyframeList = (k) =>
  Array.isArray(k) && k.length > 0 && k.every((f) => f && typeof f === 'object' && !Array.isArray(f) && 't' in f)

/** A keyframe survives parsing only with an interpolator or a hold flag. */
const keyframeSurvives = (f) => f.h === 1 || (f.i != null && f.o != null)

/** Absent or missing `a` both mean "not animated". */
const isStaticTrack = (track) => !track || track.a !== 1

function eachAnimatedTrack (node, fn) {
  if (Array.isArray(node)) return node.forEach((n) => eachAnimatedTrack(n, fn))
  if (!node || typeof node !== 'object') return
  if (node.a === 1 && isKeyframeList(node.k)) fn(node)
  for (const key of Object.keys(node)) eachAnimatedTrack(node[key], fn)
}

/**
 * Restore interpolators on keyframes that would otherwise be discarded. The
 * final keyframe is left alone: it is dropped by design and carries no segment.
 * @returns {number} how many keyframes were given an interpolator back
 */
function reviveKeyframes (doc) {
  let fixed = 0
  eachAnimatedTrack(doc, (track) => {
    const frames = track.k
    for (let i = 0; i < frames.length - 1; i++) {
      if (keyframeSurvives(frames[i])) continue
      const width = Array.isArray(frames[i].s) ? frames[i].s.length : 1
      Object.assign(frames[i], ease(width))
      fixed++
    }
  })
  return fixed
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Whether any track would still animate after parsing.
 *
 * A track counts only when two surviving keyframes hold *different* values: a
 * timeline of constant values is collapsed, and a file built that way is still
 * refused (measured, and matching how Telegram's own renderer folds constant
 * timelines before deciding a composition is static).
 *
 * This remains a structural check, so it cannot tell that a genuine animation
 * drives a layer nothing can see — treat `true` as "probably fine", not proof.
 */
function hasSurvivingAnimation (doc) {
  let found = false
  eachAnimatedTrack(doc, (track) => {
    if (found) return
    for (let i = 0; i < track.k.length - 1; i++) {
      if (!keyframeSurvives(track.k[i])) continue
      const from = track.k[i].s
      const to = track.k[i].e != null ? track.k[i].e : track.k[i + 1].s
      if (!sameValue(from, to)) { found = true; return }
    }
  })
  return found
}

const scalarTrack = (from, mid, dur) => ({
  a: 1,
  k: [
    { ...ease(1), t: 0, s: [from] },
    { ...ease(1), t: Math.round(dur / 2), s: [mid] },
    { t: dur, s: [from] }
  ]
})

const vectorTrack = (from, mid, dur) => ({
  a: 1,
  k: [
    { ...ease(from.length), t: 0, s: [...from] },
    { ...ease(from.length), t: Math.round(dur / 2), s: [...mid] },
    { t: dur, s: [...from] }
  ]
})

/** First number of a track that is not animated, or null. */
function staticValue (track) {
  if (!isStaticTrack(track)) return null
  const k = track && track.k
  if (typeof k === 'number') return k
  if (Array.isArray(k) && typeof k[0] === 'number') return k[0]
  return null
}

/**
 * Add motion too small to see but large enough to change pixels.
 *
 * Opacity is the dependable lever: it shifts the alpha byte of every opaque
 * pixel, whatever its colour and whatever the render resolution. Measured in
 * rlottie at 512/128/64px, a 1% drop moves the byte by 5 on a near-black fill
 * exactly as much as on a white one. Its one hole is content already below
 * roughly 20% alpha, where 1% of very little rounds away.
 *
 * Scale is the supplement, not the main lever: it only moves antialiased edges,
 * so a full-bleed background or geometry clipped by the canvas gives *zero*
 * difference, and the effect weakens at small render sizes. Both are applied
 * because between them they cover each other's blind spot.
 */
function addMicroAnimation (doc) {
  const dur = Math.max(2, Math.round((doc.op || 0) - (doc.ip || 0)))
  let touched = 0
  for (const layer of doc.layers || []) {
    // Null layers paint nothing, a matte source is not drawn on its own, and a
    // hidden layer cannot contribute a changed pixel.
    if (layer.ty === 3 || layer.td != null || layer.hd === true) continue
    layer.ks = layer.ks || {}

    // `a` is optional and defaults to 0, so a track counts as static unless it
    // says `a: 1` — testing for `a === 0` alone silently skips exporters that
    // omit it.
    if (isStaticTrack(layer.ks.s)) {
      const base = Array.isArray(layer.ks.s && layer.ks.s.k) ? layer.ks.s.k : [100, 100, 100]
      layer.ks.s = vectorTrack(base, base.map((v, i) => (i < 2 ? v * 1.001 : v)), dur)
    }
    if (isStaticTrack(layer.ks.o)) {
      // Dip from whatever the layer's opacity already is, never from 100: a
      // deliberately faint layer (a shadow, a glow) would otherwise be forced
      // to full strength, which is a visible change, not a wobble. Faint layers
      // also need a proportionally larger dip to shift a byte at all.
      const from = staticValue(layer.ks.o)
      const base = from == null ? 100 : from
      const dip = base >= 50 ? base * 0.99 : Math.max(0, base - 1)
      layer.ks.o = scalarTrack(base, dip, dur)
    }

    // Every paintable layer gets the wobble, not just the first: picking one
    // risks picking a layer that happens to be invisible, which would leave the
    // rendered output unchanged and the file still refused.
    touched++
  }
  return touched
}

/**
 * @param {Buffer} buffer gzipped Lottie
 * @returns {{ buffer: Buffer, changed: boolean, revived: number, micro: boolean } | { error: string }}
 */
function fixStaticTgs (buffer) {
  let doc
  try {
    doc = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
  } catch (err) {
    return { error: 'not a gzipped Lottie: ' + err.message }
  }
  if (!Array.isArray(doc.layers) || !doc.layers.length) return { error: 'no layers' }

  // Telegram compares rendered frames, not the JSON: a file carrying animated
  // tracks whose values never differ is still refused (measured). So a
  // surviving track is not proof the file will pass — revived keyframes may
  // only drive a layer that is invisible anyway. Whenever the file arrived
  // static in any sense, add the wobble as well. It costs nothing visually and
  // it is the only part that is guaranteed to move pixels.
  const wasStatic = !hasSurvivingAnimation(doc)
  const revived = reviveKeyframes(doc)
  const micro = (wasStatic || revived > 0) && addMicroAnimation(doc) > 0

  if (!revived && !micro) return { buffer, changed: false, revived: 0, micro: false }

  const out = zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 })
  if (out.length > MAX_TGS_BYTES) return { error: 'repaired file exceeds 64KB' }
  return { buffer: out, changed: true, revived, micro }
}

module.exports = { fixStaticTgs, hasSurvivingAnimation, reviveKeyframes, addMicroAnimation }
