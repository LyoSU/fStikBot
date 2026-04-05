const sharp = require('sharp')

const splitImage = async (imageBuffer, rows, cols) => {
  const image = sharp(imageBuffer, {
    failOnError: false,
    limitInputPixels: false
  })

  const metadata = await image.metadata()
  const cellWidth = Math.floor(metadata.width / cols)
  const cellHeight = Math.floor(metadata.height / rows)

  const cells = []

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = await image
        .clone()
        .extract({
          left: c * cellWidth,
          top: r * cellHeight,
          width: cellWidth,
          height: cellHeight
        })
        .resize(100, 100, { fit: 'fill' })
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
