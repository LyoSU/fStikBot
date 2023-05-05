const got = require('got')

function rembg (url, model = 'silueta') {
  const params = new URLSearchParams({
    url,
    model
  })

  return got(`${process.env.REMBG_URL}/?${params.toString()}`, {
    responseType: 'buffer'
  })
}

module.exports = rembg
