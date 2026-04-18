# fStikBot

Telegram sticker bot. Make packs, copy packs, edit stickers, search a public catalog. Runs [@fStikBot](https://t.me/fStikBot).

## What it does

- Create and edit sticker, emoji and video packs
- Copy any existing pack into your own
- Inline search across a public catalog (plus Tenor GIFs)
- Frame, mosaic, round-video and background-removal tools
- Co-edit packs with other users
- Group-mode packs and boosts
- Admin panel, broadcasts, moderation (OpenAI)

## Stack

Node.js, [telegraf](https://github.com/telegraf/telegraf) for Bot API, [gram.js](https://github.com/gram-js/gramjs) MTProto for large files, MongoDB, Redis + Bull for queues, Sharp for image work.

## Run it

```bash
git clone https://github.com/LyoSU/fStikBot.git
cd fStikBot
cp .env.example .env
cp config.example.json config.json
# fill in BOT_TOKEN and friends
docker compose up -d
```

Without Docker: install Node LTS, MongoDB and Redis, then `npm i && npm start`.

## Configuration

Two files:

- `.env` — runtime secrets (bot token, MTProto keys, MongoDB URI, Redis host, OpenAI key, Tenor key)
- `config.json` — non-secret app config (admin id, log chat, sticker link prefix, messaging limits)

Minimum to boot: `BOT_TOKEN`, `MONGODB_URI`, `REDIS_HOST`. Everything else is optional and disables the matching feature when missing (OpenAI moderation, Tenor, GramAds, large-file downloads).

## Scripts

```bash
npm start               # run the bot
npm run lint            # eslint
npm run lint:fix        # eslint --fix
npm run banners:build   # rebuild banner assets
```

Webhook mode turns on when `BOT_DOMAIN` is set. Otherwise the bot uses long polling.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free for personal, research, educational and nonprofit use. For anything commercial ping [@LyoSU](https://t.me/LyoSU) for a separate license.
