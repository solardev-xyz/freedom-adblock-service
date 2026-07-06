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
├── easylist-annoyances.json                                      ┘
├── metadata.json            # iOS build record (per-shard sizes, source hashes)
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

Edit `sources.json` to add/remove lists. Defaults: EasyList (ads), EasyPrivacy (trackers), Fanboy Cookiemonster (cookie banners), Fanboy Annoyances.

## License attribution

Filter list data is © the respective list authors and dual-licensed GPLv3+ / CC BY-SA 3.0+ (EasyList family). Output JSON inherits the spirit of that attribution requirement — Freedom Browser surfaces this in its in-app Filter Credits screen.

`adblock-rs` is MPL-2.0.
