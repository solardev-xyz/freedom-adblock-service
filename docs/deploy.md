# Deploying the publisher daemon (WP5 5.A3)

The publisher is a long-running container (`bin/serve.ts`) that, on a schedule,
rebuilds the filter lists from upstream and publishes them to the Swarm feed the
Freedom Browser clients read. It is a lightweight sibling of the Swarmit curator:
it does **not** run its own Swarm node — it talks to the existing Bee/Ant node
over HTTP and signs the feed with a dedicated key. The node's postage batch pays
for storage.

See `../../freedom-browser/research/adblock-swarm-update-channel.md` for the
design and `../../freedom-browser/research/wp5-build-status.md` for live status.

## What one cycle does

1. `buildArtifacts()` — fetch every list in `sources.json`, convert to desktop
   raw text + iOS WebKit-JSON shards, write `out/`.
2. `publish()` — read the current feed; **sanity-guard** the new build (reject a
   list that is implausibly small or shrank >50% vs live — catches a broken
   upstream fetch); upload only changed blobs; **skip the feed write entirely if
   nothing changed** (no version churn); otherwise bump the monotonic version,
   sign (EIP-191), and write the feed.
3. Report the postage batch's remaining TTL; **warn** below the floor.

A failing cycle (bad build, node down, guard trip) is logged and retried next
tick — the daemon never crashes and the last-good feed stays live.

## Configuration (env)

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `FEED_SIGNER_KEY` | ✅ | — | 0x hex. Feed owner **and** manifest signer. Clients pin its address. Store as a Coolify secret. |
| `BEE_API_URL` | | `http://127.0.0.1:1633` | On Coolify: `http://bee:1633` (the node's network alias). |
| `STAMP_BATCH_ID` | recommended | most-TTL batch | Pin the dedicated adblock batch so it never grabs the curator's. |
| `BUILD_INTERVAL_HOURS` | | `12` | Clients poll every 6h; upstream updates a few times/day. |
| `BATCH_TTL_FLOOR_DAYS` | | `30` | Warn (not fail) below this remaining TTL. |

## Deploying on the Swarmit Coolify server

Server + API details: `../../swarmit-coolify/README.md`. The publisher joins the
same `coolify` network as the `bee` node.

### 1. Buy a dedicated mutable postage batch on the bee node

The feed is a stream of Single-Owner-Chunk rewrites, so the batch **must be
mutable** (`Immutable: false`) or its buckets fill and writes start failing —
the swarmit README learned this the hard way. Buy generously (~1yr):

```bash
# amount ≈ 9.3e8 × days ; depth 17 is ample for a handful of small lists.
# ~365 days: amount ≈ 3.4e11.
ssh root@5.78.195.10 "docker run --rm --network coolify curlimages/curl:latest \
  -s -X POST -H 'Immutable: false' \
  'http://bee:1633/stamps/340000000000/17?label=freedom-adblock'"
# → { "batchID": "…" }   ← this is STAMP_BATCH_ID
```

Confirm it is usable and note the TTL:

```bash
ssh root@5.78.195.10 "docker run --rm --network coolify curlimages/curl:latest \
  -s http://bee:1633/stamps/<BATCH_ID>"
```

### 2. Create the Coolify app

- **Source**: this repo (public), branch `main`.
- **Build pack**: **Dockerfile** (the multi-stage Dockerfile in this repo — the
  builder compiles adblock-rs's native module; the runtime is node + tsx).
- **Network**: `coolify` (default) — reaches the node as `http://bee:1633`.
- **No public port / domain** — it's a background worker, not an HTTP service.
- **Env vars** (via API or UI — see swarmit README for the API recipe):
  - `BEE_API_URL=http://bee:1633`
  - `STAMP_BATCH_ID=<the batch from step 1>`
  - `BUILD_INTERVAL_HOURS=12`
  - `BATCH_TTL_FLOOR_DAYS=30`
  - `FEED_SIGNER_KEY=<key>` — **secret**. For the test server this is the
    throwaway key (address `0xf6aa…FCE0`); production uses a fresh durable key
    whose address is then hard-coded into the desktop client's `feed-config.js`
    and the iOS anchor.

### 3. Verify

Tail the container logs (see swarmit README for the `docker logs` recipe). A
healthy first run prints the signer address + topic, then per cycle:

```
[publish] wrote version N (uploaded X, reused Y)   # or "no change; feed stays at version N"
[stamp] batch TTL 360d
```

Then confirm a client can read it — point a dev desktop build at the feed with
`FREEDOM_ADBLOCK_FEED_OWNER` / `FREEDOM_ADBLOCK_SIG_ADDRESS = <signer address>`.

## Ongoing operations

- **Batch TTL**: the daemon only *warns* below the floor; **topping up is a
  human action** (keeps the daemon keyless and out of the node's wallet):

  ```bash
  ssh root@5.78.195.10 "docker run --rm --network coolify curlimages/curl:latest \
    -s -X PATCH 'http://bee:1633/stamps/topup/<BATCH_ID>/<amount>'"
  ```

  Expired batches are gone for good — top up before the TTL date. (Auto-topup
  via the node API is a possible later enhancement.)

- **Node xBZZ**: top-up spends from the node wallet; keep it funded. If low, move
  BZZ from the chequebook first (`POST /chequebook/withdraw` — see swarmit README).

- **Rollback**: publishing is monotonic and clients reject downgrades, so you
  cannot un-publish a bad version by rewinding — you publish a *newer* good one.
  The guard is the primary defense against shipping a broken build in the first
  place.
