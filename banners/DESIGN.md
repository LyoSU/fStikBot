# Banner Design System

Visual language for the hero banners that sit above `/start` and section
entry messages. Reference this doc when adding new banners or adjusting
existing ones — palette choices, type decisions, and pattern density are
all encoded here.

---

## 1. Concept

**fStikBot promo slides.** Each banner is one issue in a consistent series,
the same way Telegram's own promo banners (Premium, Stars, Business) share
one layout language and change only the colour/icon/title per product.

Three ingredients define every banner:

1. **Coloured gradient page** with a soft bottom-vignette for depth
2. **Doodle-pattern wallpaper** (Tabler Icons stroked white) tiled over the
   gradient via `mix-blend-mode: soft-light`
3. **Left wordmark + right tile** composition — bold italic condensed
   typography on the left, a rounded-square app-icon-style tile on the right

What makes the series recognisable is the **combination**: cohesive bold
italic type + doodle texture + tilted app-icon tile. Change any one and it
stops feeling like fStikBot.

---

## 2. Canvas

| Spec | Value | Why |
|---|---|---|
| Output size | 960 × 360 (2.67:1) | Wide short header that doesn't get cropped by Telegram's mobile client. Original 1200 × 630 OG format was too tall and 1200 × 400 was too wide on phones. |
| Retina scale | 2× | Final PNG ships at 1920 × 720. Sharp on high-DPI devices, ~500–700 KB per file. |
| Safe margins | 48–56 px | Left brand padding 56 px, right tile 48 px. Keeps content off edges so Telegram client padding doesn't clip type. |

---

## 3. Colour

### 3.1 Palette structure

Every banner defines **3 gradient stops** (lightest → mid → deepest) plus
**2 ink shadow values** (mid + deep) that are derived from the palette's
deepest colour at low opacity. Centralising this in three vars means each
banner file is ~4 lines of palette override.

```css
.page {
  --sky-0: #5BAEEF;        /* lightest — top-left of gradient */
  --sky-1: #4693DA;        /* mid — middle of gradient */
  --sky-2: #2E7BC8;        /* deepest — bottom-right, used as icon stroke */
  --ink-shadow: rgba(10, 45, 95, 0.22);       /* soft press shadow */
  --ink-shadow-deep: rgba(10, 45, 95, 0.32);  /* deep drop shadow */
}
```

### 3.2 Per-issue palettes

Colour is the primary signal for which section you're in. Palettes are
picked so adjacent sections in the flow contrast (welcome blue → catalog
teal doesn't feel samey) and so warm/cool alternate nicely across the set.

| Issue | Spot hue | Intent |
|---|---|---|
| `welcome` | sky blue `#2E7BC8` | Brand primary, matches marketplace promos |
| `packs` | indigo/violet `#3A3BAF` | Personal collection, inward/private energy |
| `catalog` | teal/mint `#0C8A78` | Discovery, freshness |
| `new-pack` | amber/orange `#D86820` | Creation, action, warm |
| `boost` | magenta/pink `#A62A6E` | High energy, promotion |
| `help` | green/sage `#2C8F46` | Calm, supportive |
| `donate` | gold/yellow `#C88617` | Appreciation, Stars-adjacent |

**Adjacent-section rule**: if you add a new banner, pick a hue ≥ 60° away
on the wheel from any banner it's reachable from. Keeps the transition
visible even in quick navigation.

### 3.3 Text / foreground

All wordmarks are white `#FFFFFF`. Taglines are `rgba(255,255,255,0.88)`.
This is intentional — coloured bg + white text reads as app promo; white
bg + coloured text would read as SaaS landing. Do not break this.

---

## 4. Typography

### 4.1 Font

**Barlow Condensed** (Google Fonts, OFL) — one family, two voices:

- **Wordmark**: 900 italic at 140 px, line-height 1, tracking −0.01em
- **Tagline**: 700 italic at 26 px UPPERCASE, tracking 0.04em

Why Barlow Condensed:
- Has proper italic designs (not slanted upright) — critical for the
  App Store promo look
- Condensed fits bold big wordmarks without crowding
- Full Cyrillic coverage (needed when we localise later)
- Not overused by AI landing pages the way Inter / Unbounded are

**Don't use**: Inter, Unbounded, Space Grotesk, Poppins — they read as
generic AI output. Don't mix a second typeface in — one family, two
weights, two styles is the whole system.

### 4.2 Shadows (critical for legibility)

White text on coloured bg with a busy pattern underneath needs layered
shadow to lift off the surface:

```css
text-shadow:
  0 3px 0 var(--ink-shadow),              /* crisp press shadow — old-poster feel */
  0 12px 24px var(--ink-shadow),          /* soft drop — implies elevation */
  0 0 36px rgba(255, 255, 255, 0.18);     /* halo — ties text to the glossy tile */
```

The third layer (white halo) is what separates the S-tier polish from
flat-print. It visually links the wordmark to the glass tile on the right.

### 4.3 Descender clearance

Wordmark line-height is `1` and tag margin-top is `18 px`. This prevents
"g" / "p" / "y" descenders from touching the tagline. If you add a
wordmark with a descender on its last character and tag underneath, check
visually — nudge margin-top if needed.

---

## 5. Layout

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│  ┌─── .brand (left 56px, vcentered)                   │
│  │                              ┌─── .tile (right 48px,
│  │  Wordmark                    │      vcentered,
│  │  TAGLINE · DOTS              │      230×230,
│  │                              │      rotate 8deg)
│  │                              │
│  └────────────                  └────
│                                                       │
└───────────────────────────────────────────────────────┘
                    960 × 360
```

- **Absolutely positioned**: both `.brand` and `.tile` use absolute
  positioning with `top: 50%; transform: translateY(-50%)`. Keeps vertical
  centre math trivial regardless of content length.
- **Max-width 620 px on .brand**: prevents long titles from overlapping
  the tile area.
- **Tile rotates 8°** — signature "sticker peeled onto page" feel.
  Always the same angle across all banners for consistency.

---

## 6. Pattern wallpaper

One SVG (`assets/pattern.svg`) is tiled across every banner. It's a
480×480 composition of 18 Tabler Icons (star, heart, sparkles, cloud,
leaf, bolt, music, gift, feather, ghost, mushroom) positioned at varied
angles, strokes white, licensed MIT.

**`soft-light` blend mode** lets the underlying palette tint through the
strokes — same asset reads differently against every hue without needing
re-export per colour.

### 6.1 Per-issue density tuning

Each banner overrides two vars:

```css
.page {
  --pattern-size: 340px;        /* smaller = denser */
  --pattern-opacity: 0.48;      /* higher = more visible */
}
```

| Issue | Size | Opacity | Intent |
|---|---|---|---|
| `welcome` | 340 px | 0.48 | Vibrant, "lots going on" |
| `packs` | 420 px | 0.36 | Subtle — focus is the collection |
| `catalog` | 320 px | 0.46 | Busy, "many discoveries" |
| `new-pack` | 460 px | 0.55 | Sparse + bold — creation space |
| `boost` | 300 px | 0.55 | Dense + loud — high energy |
| `help` | 520 px | 0.32 | Sparsest — calm, quiet |
| `donate` | 380 px | 0.42 | Balanced baseline |

Rule of thumb: denser pattern = higher energy. Quieter sections (help)
use larger tile + lower opacity; energetic sections (boost, new-pack) go
denser + more visible.

---

## 7. Tile (right-side hero)

Two variants, same position/size/tilt so the family feels cohesive.

### 7.1 `.tile--mascot` — the fStikBot app icon

Used on `welcome` only. The actual bot avatar (yellow star on blue-yellow
gradient) inside a rounded-square frame at 8° tilt. Treats the real brand
asset as the hero — no synthetic illustration.

### 7.2 `.tile--icon` — section glyph on a glass tile

Used on every other banner. A white rounded-square with:

- Subtle tonal gradient (`#FFFFFF` → `#EFF3F9` at 100%) — adds depth so
  it doesn't read as flat paper
- Glossy top-half highlight (`.tile--icon::before`) — curved gradient
  fading to transparent, masks as an enamel/glass app icon would catch
  overhead light
- Tabler icon inside at 134 px, stroke `var(--sky-2)` — icon takes the
  banner's deepest palette colour so it connects to the bg

### 7.3 Picking an icon

Every section icon comes from Tabler Icons (outline set, MIT licensed).
When adding a new banner:

1. Pick an icon that directly represents the section's *verb* (what the
   user does there), not a decoration of its *noun*. `search` for catalog
   (user searches), not `book` (which would decorate "catalog" as a
   concept).
2. Paste the path data from `https://tabler.io/icons/icon/<name>` into
   the banner's `.tile--icon svg` slot.
3. Keep stroke-width at 2.2 — matches the wordmark's visual weight.

**Current icon choices:**

| Issue | Icon | Why |
|---|---|---|
| `welcome` | mascot PNG | Real brand |
| `packs` | `stack-2` | Three horizontal layers = stacked sticker packs |
| `catalog` | `search` | Direct verb — "find packs" |
| `new-pack` | `sparkles` | Creation/magic hint, more interesting than a plus |
| `boost` | `bolt` | Energy/reach — common promotion metaphor |
| `help` | `help-circle` | Universal — question in circle |
| `donate` | `heart` | Universal — appreciation |

---

## 8. What NOT to put on banners

Things we explicitly rejected during design, listed here so we don't drift
back to them:

- **Personalised text** ("Hi, Yuri!" "You have 12 packs") — kills the
  file_id cache, forces per-user render. Put dynamic state in the message
  caption below the banner.
- **Slogans** ("Create magic from every moment!") — read as AI-slop.
  Subtitles stay functional: section title + at most one short tagline.
- **Multiple decorative SVGs** (ribbons, registration marks, washi tape,
  starbursts, etc.) — tried during early iteration, felt fussy. One
  strong visual element (tile) beats ten small ones.
- **Pastel gradient with centered title + 3 overlapping rounded cards** —
  the textbook AI-generated hero. Banned.
- **Kicker labels** with a coloured dot ("● TELEGRAM · STICKER BOT") —
  Vercel / Linear cliché.
- **Gradient words** (`f` in blue, rest in white) — early attempt, reads
  as tired SaaS.
- **Emoji characters** in SVG/type — font rendering is unreliable across
  librsvg / Puppeteer / Chromium versions. Use Tabler paths instead.

---

## 9. Adding a new banner

1. `cp src/help.html src/<name>.html` — pick the existing banner closest
   in tone to what you're making.
2. Update the `.page` block:
   - 3 palette stops (use tools like [huemint](https://huemint.com/) to
     pick a palette ≥60° from adjacent banners)
   - 2 `--ink-shadow*` values derived from the deepest palette colour at
     0.22 / 0.32 opacity
   - `--pattern-size` and `--pattern-opacity` matched to the section's
     energy (see 6.1)
3. Change `.brand__name` to the section title (one or two words max) and
   `.brand__tag` to a factual sub-line (no slogans — see §8).
4. Swap the `<svg viewBox="0 0 24 24">…</svg>` inside `.tile--icon` with
   a new Tabler icon's paths.
5. Add `{ name: '<name>', file: '<name>.html' }` to the `BANNERS` array in
   `build.js`.
6. `npm run banners:build` → verify `dist/<name>.png` visually.
7. Commit both the `src/<name>.html` and `dist/<name>.png`.
8. Wire it up in the relevant handler using `sendBanner` / `editBanner` /
   `replyOrEditBanner` from `banners/index.js`.

---

## 10. Future extensions

Design-space decisions deferred for later:

- **Per-locale titles** — 7 banners × 3 locales = 21 PNGs (~10 MB). Would
  require a per-locale output dir and a lookup in `sendBanner`. Skipped
  at v1, worth doing when a non-English market actually matters.
- **Seasonal variants** — swap `welcome.png` → `welcome-holiday.png` on a
  date range. `sendBanner` wouldn't need to change; the build script
  would pick a variant.
- **Stats footer on welcome** (e.g. "14M+ packs created") — doesn't break
  file_id caching because the banner stays static between rebuilds. Would
  require a build-time DB query to avoid fabricated numbers.
- **Transparent mascot** — current mascot carries its own blue-yellow
  square bg. On welcome it reads fine as an "app icon". If we ever want
  the mascot "peeking" from behind a tile edge, we'd need a transparent
  PNG.
