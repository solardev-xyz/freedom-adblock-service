# freedom-adblock-service

Builds Safari/WebKit content-blocker JSON for [Freedom Browser iOS](https://github.com/solardev-xyz/freedom-browser-ios) from EasyList-family filter lists.

For now this is a one-shot CLI that fetches the upstream lists, converts them via [`adblock-rs`](https://www.npmjs.com/package/adblock-rs) (Brave's adblock engine, MPL-2.0), shards each output below the iOS 17 size-crash threshold, and writes everything to `./out/`. Later it grows into a long-running service that signs and publishes the same artifacts to a Swarm Feed.

## Usage

```bash
npm install      # postinstall builds adblock-rs from Rust source — first run takes ~1 min
npm run build    # fetches, converts, writes to ./out/
```

Output layout:
```
out/
├── easylist.json (or easylist-1.json, easylist-2.json … if sharded past 1.9 MB)
├── easyprivacy.json
├── easylist-cookies.json
├── easylist-annoyances.json
└── metadata.json
```

## Sources

Edit `sources.json` to add/remove lists. Defaults: EasyList (ads), EasyPrivacy (trackers), Fanboy Cookiemonster (cookie banners), Fanboy Annoyances.

## License attribution

Filter list data is © the respective list authors and dual-licensed GPLv3+ / CC BY-SA 3.0+ (EasyList family). Output JSON inherits the spirit of that attribution requirement — Freedom Browser surfaces this in its in-app Filter Credits screen.

`adblock-rs` is MPL-2.0.
