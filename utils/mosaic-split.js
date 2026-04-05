const sharp = require('sharp')

const splitImage = async (imageBuffer, rows, cols) => {
  const image = sharp(imageBuffer, {
    failOnError: false,
    limitInputPixels: false
  })

  const metadata = await image.metadata()

  // Crop source image so cells are square
  // Target aspect ratio: cols/rows
  // Crop whichever dimension is too large (center crop)
  const targetRatio = cols / rows
  const sourceRatio = metadata.width / metadata.height
  let cropWidth = metadata.width
  let cropHeight = metadata.height
  let cropLeft = 0
  let cropTop = 0

  if (sourceRatio > targetRatio) {
    // Image too wide — crop sides
    cropWidth = Math.round(metadata.height * targetRatio)
    cropLeft = Math.floor((metadata.width - cropWidth) / 2)
  } else if (sourceRatio < targetRatio) {
    // Image too tall — crop top/bottom
    cropHeight = Math.round(metadata.width / targetRatio)
    cropTop = Math.floor((metadata.height - cropHeight) / 2)
  }

  // Crop to target ratio first
  const croppedBuf = await image.clone().extract({
    left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight
  }).toBuffer()

  const croppedImg = sharp(croppedBuf, { failOnError: false, limitInputPixels: false })
  const cellWidth = Math.floor(cropWidth / cols)
  const cellHeight = Math.floor(cropHeight / rows)

  const cells = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = await croppedImg
        .clone()
        .extract({
          left: c * cellWidth,
          top: r * cellHeight,
          width: cellWidth,
          height: cellHeight
        })
        .resize(100, 100)
        .webp({ quality: 90 })
        .toBuffer()

      cells.push(cell)
    }
  }

  return cells
}

const checkMinCellSize = (width, height, rows, cols) => {
  const cellWidth = Math.floor(width / cols)
  const cellHeight = Math.floor(height / rows)
  return cellWidth >= 80 && cellHeight >= 80
}

module.exports = { splitImage, checkMinCellSize }
