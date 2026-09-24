// Largest decoded image accepted from users, in pixels. sharp's default
// (0x3FFF², ~268 MP) lets a small PNG unpack to about 1 GB; 64 MP (8000²)
// still takes photos from 50 MP phone cameras, at up to ~256 MB each.
const MAX_INPUT_PIXELS = 64 * 1000 * 1000

module.exports = { MAX_INPUT_PIXELS }
