# Banners

Build-time generated hero banners that sit above `/start` and section entry
messages. Built from HTML+CSS with Puppeteer, shipped as PNGs in `dist/`,
uploaded to Telegram on first send, then reused by `file_id`.

## Layout

```
banners/
├── src/                    # templates (dev)
│   ├── _system.css         # shared design system — palette, pattern, wordmark
│   ├── welcome.html        # /start
│   ├── catalog.html        # search_catalog
│   ├── new-pack.html       # (available, not yet wired)
│   └── assets/
│       ├── mascot.jpg      # fStikBot app icon
│       └── pattern.svg     # doodle wallpaper (Tabler Icons, MIT)
├── dist/                   # committed PNG output
│   └── *.png               # 2400×800 (retina), ship these
├── build.js                # Puppeteer → PNG export
└── index.js                # bot runtime: sendBanner / editBanner / editMenu
```

## Adding a new banner

1. `cp src/welcome.html src/<name>.html`
2. Change the `.page` palette vars (3 gradient stops + 2 shadow colors) and
   the `.brand__name` / `.brand__tag` copy.
3. Add `{ name: '<name>', file: '<name>.html' }` to `BANNERS` in `build.js`.
4. `npm run banners:build` → check `dist/<name>.png`.
5. Commit both `src/<name>.html` and `dist/<name>.png`.

To iterate on design: open the HTML file directly in a browser. Tweak CSS,
refresh. Run `npm run banners:build` only when ready to export.

## Using in handlers

```js
const { sendBanner, editBanner, editMenu } = require('../banners')

// Fresh send (from /command or plain message)
await sendBanner(ctx, 'welcome', captionHTML, {
  reply_markup: Markup.inlineKeyboard(keyboard)
})

// Navigate between different banners (swap media + caption)
await editBanner(ctx, 'catalog', captionHTML, {
  reply_markup: Markup.inlineKeyboard(keyboard)
})

// Stay on same banner, just update text/keyboard
await editMenu(ctx, captionHTML, {
  reply_markup: Markup.inlineKeyboard(keyboard)
})
```

## Caching

First `sendBanner` reads the PNG from disk → Telegram returns a `file_id` →
we cache it in RAM keyed by `{name}:{mtimeMs}`. Subsequent sends reuse the
`file_id` string — no file transfer, served from Telegram's CDN.

Cache wipes on process restart; one re-upload per banner per deploy is
acceptable overhead. Rebuilding a PNG changes its mtime → new cache key →
automatic invalidation, no manual bust.

## Telegram edit-API note

Telegram allows **text → text+media** (`editMessageMedia`), but NOT the
reverse. Once a message is a photo, it stays a photo; you can only swap the
photo, caption, or buttons. Helpers respect this:

- `editBanner` — uses `editMessageMedia`, works from either text or photo
  source.
- `editMenu` — auto-picks `editMessageCaption` (photo source) or
  `editMessageText` (text source) to update text without touching the banner.
