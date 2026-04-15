# Security Sweep PR-1 — Design Spec

## Overview

Close 22 Dependabot alerts (including 5 critical: cipher-base, elliptic, form-data, pbkdf2, sha.js) by running `npm audit fix` on transitive dependencies and bumping two direct dependencies with published security fixes.

This is PR-1 of a two-PR security cleanup. **PR-2 is a separate mongoose 5 → 6 migration** — out of scope here.

## Scope

### In scope

**Direct dependency bumps in `package.json`:**
- `moment` `^2.29.2` → `^2.30.1` — closes CVE (high), no breaking API changes
- `@pm2/io` `^5.0.0` → `^6.1.0` — closes CVE (high), public API (`metric`, `.set()`) stable across 5→6

**Transitive fixes via `npm audit fix` (no `--force`):**
- cipher-base, elliptic, form-data, pbkdf2, sha.js (critical)
- cross-spawn, flatted, lodash, minimatch, semver, socks, tar-fs (high)
- ajv, bn.js, brace-expansion, js-yaml, store2 (moderate)

**Not attempted** (`ip` high + elliptic-low + tmp-low): Dependabot marks these as `no-fix`. `npm audit` may speculatively suggest `ip` is fixable, but no patched upstream version exists. These will remain open after the sweep.

### Out of scope

- **mongoose 5 → 6** — PR-2, separate spec/plan
- **stegcloak chain** (inquirer/tmp/external-editor low alerts) — no fix available upstream, stegcloak is used in 4 files, not tractable as a single-PR fix
- **`ip` package (no-fix alert)** — comes in via `telegram` or `socks-proxy-agent`, nothing we can do without upstream fix
- **telegraf 3 → 4** — explicit user decision, stay on v3
- **ioredis, bull, sharp, openai** — not flagged, don't touch

## Call sites (dependency surface)

| Dep | File | Line | Usage |
|---|---|---|---|
| `moment` | `handlers/admin/messaging.js` | 4 | `require('moment')` |
| `moment` | `scenes/messaging.js` | 6 | `require('moment')` |
| `@pm2/io` | `utils/stats.js` | 1 | `io.metric({ name, unit })` + `.set(value)` |

All three sites use stable public APIs. No code changes needed alongside the bumps.

## Procedure

1. `npm install moment@^2.30.1 @pm2/io@^6.1.0` — updates `package.json` and `package-lock.json`
2. `npm audit fix` (no `--force`) — sub-range bumps in lock only
3. `npm audit` — verify criticals cleared (mongoose will remain — by design)
4. `npm run lint` — full lint passes
5. `node -c index.js` + `node -c utils/stats.js` + `node -c scenes/messaging.js` + `node -c handlers/admin/messaging.js` — syntax check
6. Optional: `node -e "require('./utils/stats.js')"` — confirms @pm2/io loads without runtime error
7. Commit as single change: `chore(deps): security sweep (npm audit fix + moment + @pm2/io bumps)`

## Verification

After PR-1 lands:

```bash
npm audit --audit-level=high 2>&1 | tail -10
```

Expected: only mongoose remains as high/critical (it's the PR-2 target).

```bash
gh api repos/LyoSU/fStikBot/dependabot/alerts --paginate | \
  jq '[.[] | select(.state=="open")] | length'
```

Expected: drop from 31 open → 3–6 remaining (mongoose + `ip` + `tmp` + elliptic-low + any others marked `no-fix`). Exact count confirmed post-merge.

## Rollback

If anything breaks:

```bash
git checkout HEAD~1 -- package.json package-lock.json
npm install
```

Restores prior state exactly. No code was modified, so no logic to revert.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `@pm2/io` v5 → v6 changes a signature we rely on | Low | Only 2 call sites use 2 stable methods; lint + syntax check + manual `require` test catches it |
| `npm audit fix` pulls a sub-range bump that breaks a transitive consumer | Low | Not using `--force`; all bumps stay within declared package.json ranges |
| moment 2.30 deprecation warnings | None that matter | No breaking API changes in minor bumps |
| Something loads but breaks in prod only under specific Telegram events | Medium | No tests — rely on manual monitoring after push. Easy rollback above. |

## Success criteria

- `npm audit` shows only mongoose as critical/high
- `npm run lint` passes
- Bot starts (`node index.js` connects to Mongo and Telegram) — done as manual post-push verification by user
- Dependabot open-alerts count drops by ~20 within hours

## Non-goals

- Zero Dependabot alerts
- Modernizing any library (telegraf, ioredis, sharp, mongoose — all deferred)
- Adding tests
- Changing any application code

---

## After PR-1

Proceed to brainstorm PR-2 (mongoose 5 → 6.13.9 migration) as a separate spec. That work will modify ~11 files and requires careful breaking-change review.
