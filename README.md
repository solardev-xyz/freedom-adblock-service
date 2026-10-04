# freedom-adblock-service

Builds ad-block filter artifacts for both Freedom Browser clients — [iOS](https://github.com/solardev-xyz/freedom-browser-ios) (Safari/WebKit content-blocker JSON) and desktop (raw ABP list text, compiled by the browser's engine) — from EasyList-family filter lists.

The one-shot CLI (`npm run build`) fetches the upstream lists, converts them via [`adblock-rs`](https://www.npmjs.com/package/adblock-rs) (Brave's adblock engine, MPL-2.0) into WebKit JSON shards below the iOS 17 size-crash threshold, emits the raw list text for desktop, and writes a shared **feed manifest** describing both. It is [growing](../../freedom-browser/research/adblock-swarm-update-channel.md) into a long-running service that signs and publishes these artifacts to a Swarm Feed the clients pull from (WP5) — the build already emits the manifest; the publish step fills in each artifact's Swarm reference.

## Usage

```bash
npm install      # postinstall builds adblock-rs from Rust source — first run takes ~1 min
npm run build    # fetches, converts, writes to ./out/
```

Output layout:
```
out/
├── easylist.json (or easylist-1.json … if sharded past 1.9 MB)   ┐
├── easyprivacy.json                                              │ iOS: WebKit JSON shards
├── easylist-cookies.json                                         │
├── easylist-annoyances.json                                      │
├── ublock.json              # uBlock filters + Quick fixes (iOS only) ┘
├── scriptlets.json          # iOS: every +js() rule of all five lists, pre-parsed (src/scriptlets.ts)
├── resources.json           # iOS: the scriptlet bodies, byte-identical to desktop's pin
├── metadata.json            # build record (per-shard sizes, source hashes, uAssets commit, drop counts)
├── desktop/
│   ├── easylist.txt         ┐
│   ├── easyprivacy.txt      │ desktop: raw ABP list text
│   ├── easylist-cookies.txt │
│   └── easylist-annoyances.txt ┘
└── feed-manifest.json       # shared cross-client manifest (src/manifest.ts) —
                             #   per-platform sections; `ref`s empty until publish
```

The **feed manifest** (`src/manifest.ts`) is the source-of-truth contract shared with both client readers: schema version, a monotonic `version`, per-platform list entries each carrying `sha256`/`bytes`/`rule_count`, and (at publish time) a Swarm `ref` per blob plus a top-level `sig`. See the design note linked above.

## Sources

Edit `sources.json` to add/remove lists. Defaults: EasyList (ads), EasyPrivacy (trackers), Fanboy Cookiemonster (cookie banners), Fanboy Annoyances — on both platforms — plus, for iOS only, uBlock Origin's own "uBlock filters" + "Quick fixes" (fetched at the current uAssets `gh-pages` commit, `!#if` evaluated for `env_safari`/`env_mobile`/`ext_ublock`; desktop bundles its own copy).

`sources.json` also pins `resources.json` (tag + sha256), in lockstep with desktop's `scripts/fetch-adblock-lists.js` — re-pin both together.

### Cosmetic exceptions (iOS)

adblock-rs's WebKit conversion turns a `host#@#selector` exception into a *hide* everywhere except `host`, and turns `site.*,~host##selector` into a hide everywhere except `host`. Both are global over-hides, which is how v145 blanked the YouTube player. `src/cosmetic-exceptions.ts` keeps both shapes away from adblock-rs:

- An exception is applied to the hides from its own list. It joins a generic hide's `unless-domain` as `*host`, or removes its host from a domain hide's `if-domain`.
- `#@#selector` with no host drops every hide of that selector.
- Anything WebKit can't express is dropped (entities, cross-list exceptions).
- Per-list counts go in `metadata.json` → `cosmetic_exceptions`.

### Scriptlets (iOS)

`scriptlets.json` mirrors what desktop's `@ghostery/adblocker` (same pinned release) does with each `+js()` line: generic injections, unknown names and regex hostnames are dropped, `trusted-*` scriptlets are allowed only from the uBlock list, JS surrogates (`+js(nofab)` …) are kept as `kind: "surrogate"`. Every drop is counted in the file's `dropped`. Output is deterministic, so its sha256 only changes when the rules do.

## License attribution

Filter list data is © the respective list authors and dual-licensed GPLv3+ / CC BY-SA 3.0+ (EasyList family). Output JSON inherits the spirit of that attribution requirement — Freedom Browser surfaces this in its in-app Filter Credits screen.

uBlock Origin's filters (uAssets) and the scriptlets in `resources.json` are GPL-3.0-only; `metadata.json` records the exact uAssets commit and the resources' upstream provenance (see `sources.json`).

`adblock-rs` is MPL-2.0. `@ghostery/adblocker` is MPL-2.0.
