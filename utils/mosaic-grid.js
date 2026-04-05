const getGridSuggestions = (width, height, freeSlots = 200) => {
  const ratio = width / height

  // Determine type
  if (ratio >= 2.5) return getStripSuggestions(ratio, 'horizontal', freeSlots)
  if (ratio <= 0.4) return getStripSuggestions(1 / ratio, 'vertical', freeSlots)
  return getGridOptions(ratio, freeSlots)
}

const getStripSuggestions = (ratio, direction, freeSlots) => {
  const count = Math.max(3, Math.min(10, Math.round(ratio)))
  const isHorizontal = direction === 'horizontal'

  const options = []
  for (let delta = -2; delta <= 2; delta++) {
    const n = count + delta
    if (n < 3 || n > 10 || n > freeSlots) continue
    const rows = isHorizontal ? 1 : n
    const cols = isHorizontal ? n : 1
    options.push({ rows, cols, total: n })
  }

  if (options.length === 0) return { type: 'no_space', options: [] }

  const recommended = options.find(o => o.total === count) || options[Math.floor(options.length / 2)]
  const alternatives = options.filter(o => o !== recommended).slice(0, 3)

  return { type: 'strip', recommended, alternatives }
}

const getGridOptions = (ratio, freeSlots) => {
  const candidates = []

  for (let rows = 2; rows <= 10; rows++) {
    for (let cols = 2; cols <= 10; cols++) {
      const total = rows * cols
      if (total > 50 || total > freeSlots) continue

      const gridRatio = cols / rows
      const ratioScore = Math.abs(gridRatio - ratio) / ratio
      const cellRatio = (ratio / gridRatio)
      const squareScore = Math.abs(1 - cellRatio)
      const sizeScore = Math.abs(total - 12) / 50

      const score = ratioScore * 2 + squareScore + sizeScore * 0.5
      candidates.push({ rows, cols, total, score })
    }
  }

  if (candidates.length === 0) return { type: 'no_space', options: [] }

  candidates.sort((a, b) => a.score - b.score)

  const recommended = candidates[0]
  const smaller = candidates.find(c => c.total < recommended.total && c !== recommended)
  const larger = candidates.find(c => c.total > recommended.total && c !== recommended)
  const largest = candidates.find(c => c.total > (larger?.total || 0) && c !== recommended && c !== larger)

  const alternatives = [smaller, larger, largest].filter(Boolean).slice(0, 3)

  return { type: 'grid', recommended, alternatives }
}

module.exports = { getGridSuggestions }
