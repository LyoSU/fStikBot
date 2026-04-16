const sharp = require('sharp')

const generatePreview = async (imageBuffer, rows, cols) => {
  const image = sharp(imageBuffer, {
    failOnError: false,
    limitInputPixels: 268402689
  })

  const metadata = await image.metadata()

  // Crop to target ratio first (same logic as splitImage)
  const targetRatio = cols / rows
  const sourceRatio = metadata.width / metadata.height
  let srcCropW = metadata.width
  let srcCropH = metadata.height
  let srcCropLeft = 0
  let srcCropTop = 0

  if (sourceRatio > targetRatio) {
    srcCropW = Math.round(metadata.height * targetRatio)
    srcCropLeft = Math.floor((metadata.width - srcCropW) / 2)
  } else if (sourceRatio < targetRatio) {
    srcCropH = Math.round(metadata.width / targetRatio)
    srcCropTop = Math.floor((metadata.height - srcCropH) / 2)
  }

  // Resize cropped area to max 512px on longest side
  const scale = Math.min(512 / srcCropW, 512 / srcCropH, 1)
  const previewWidth = Math.round(srcCropW * scale)
  const previewHeight = Math.round(srcCropH * scale)

  const cellW = Math.floor(previewWidth / cols)
  const cellH = Math.floor(previewHeight / rows)
  const cropWidth = cellW * cols
  const cropHeight = cellH * rows

  const strokeWidth = 2
  const lines = []

  // Vertical lines (at floor-based cell boundaries)
  for (let c = 1; c < cols; c++) {
    const x = c * cellW
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${cropHeight}" stroke="white" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-opacity="0.85"/>`)
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${cropHeight}" stroke="black" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-dashoffset="8" stroke-opacity="0.4"/>`)
  }

  // Horizontal lines (at floor-based cell boundaries)
  for (let r = 1; r < rows; r++) {
    const y = r * cellH
    lines.push(`<line x1="0" y1="${y}" x2="${cropWidth}" y2="${y}" stroke="white" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-opacity="0.85"/>`)
    lines.push(`<line x1="0" y1="${y}" x2="${cropWidth}" y2="${y}" stroke="black" stroke-width="${strokeWidth}" stroke-dasharray="8,6" stroke-dashoffset="8" stroke-opacity="0.4"/>`)
  }

  // Grid size label in center
  const label = `${rows}×${cols}`
  const fontSize = Math.max(24, Math.round(previewWidth / 10))
  lines.push(`<rect x="${cropWidth / 2 - fontSize * 1.5}" y="${cropHeight / 2 - fontSize * 0.7}" width="${fontSize * 3}" height="${fontSize * 1.4}" rx="8" fill="rgba(0,0,0,0.6)"/>`)
  lines.push(`<text x="${cropWidth / 2}" y="${cropHeight / 2 + fontSize * 0.3}" text-anchor="middle" font-size="${fontSize}" font-family="Arial,sans-serif" font-weight="bold" fill="white">${label}</text>`)

  const svgOverlay = Buffer.from(
    `<svg width="${cropWidth}" height="${cropHeight}">${lines.join('')}</svg>`
  )

  const result = await image
    .clone()
    .extract({ left: srcCropLeft, top: srcCropTop, width: srcCropW, height: srcCropH })
    .resize(previewWidth, previewHeight)
    .extract({ left: 0, top: 0, width: cropWidth, height: cropHeight })
    .composite([{ input: svgOverlay, top: 0, left: 0 }])
    .webp({ quality: 80 })
    .toBuffer()

  return result
}

module.exports = { generatePreview }
