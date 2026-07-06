import { Bee, PrivateKey, Topic, BeeResponseError } from '@ethersphere/bee-js';
import { FEED_TOPIC, type FeedManifest } from './manifest.ts';
import type { SwarmClient } from './publish.ts';

// Live SwarmClient over bee-js, talking to a local Ant/Bee node. Mirrors the
// browser's feed-service.js primitives (makeFeedReader/Writer, uploadData).
// Requires a funded node with a usable postage batch — validated end-to-end
// during the funded publish run, not in unit tests.

function isNotFound(err: unknown): boolean {
  return err instanceof BeeResponseError && (err.status === 404 || err.status === 500);
}

// bee-js returns typed wrappers (Reference, BatchId, …) with a .toHex(); fall
// back to String for plain values.
function toHex(value: unknown): string {
  if (value && typeof (value as { toHex?: () => string }).toHex === 'function') {
    return (value as { toHex: () => string }).toHex();
  }
  return String(value);
}

export interface SwarmConfig {
  beeUrl: string;
  signerKey: string; // feed-write key (also the SOC owner / feed owner)
  batchId?: string; // postage batch; auto-selected (most TTL) if omitted
}

async function selectBatch(bee: Bee): Promise<string | null> {
  const batches = await bee.getPostageBatches();
  let best: (typeof batches)[number] | null = null;
  let bestTtl = -1;
  for (const b of batches) {
    if (!b.usable) continue;
    const ttl = b.duration && typeof b.duration.toSeconds === 'function' ? b.duration.toSeconds() : 0;
    if (ttl > bestTtl) {
      best = b;
      bestTtl = ttl;
    }
  }
  return best ? toHex(best.batchID) : null;
}

export async function createSwarmClient(cfg: SwarmConfig): Promise<SwarmClient> {
  const bee = new Bee(cfg.beeUrl);
  const signer = new PrivateKey(cfg.signerKey);
  const owner = signer.publicKey().address();
  const topic = Topic.fromString(FEED_TOPIC);

  const batchId = cfg.batchId ?? (await selectBatch(bee));
  if (!batchId) {
    throw new Error(
      'No usable postage batch available. Fund the node (BZZ + xDAI) and buy a stamp.',
    );
  }

  const reader = bee.makeFeedReader(topic, owner);
  const writer = bee.makeFeedWriter(topic, signer);

  async function nextIndex(): Promise<number> {
    try {
      const latest = await reader.downloadPayload();
      return latest.feedIndexNext
        ? Number(latest.feedIndexNext.toBigInt())
        : Number(latest.feedIndex.toBigInt()) + 1;
    } catch (err) {
      if (isNotFound(err)) return 0;
      throw err;
    }
  }

  return {
    async uploadBytes(data: Buffer): Promise<string> {
      const res = await bee.uploadData(batchId, data);
      return toHex(res.reference);
    },
    async readLatestManifest(): Promise<FeedManifest | null> {
      try {
        const latest = await reader.downloadPayload();
        const text = Buffer.from(latest.payload.toUint8Array()).toString('utf8');
        return JSON.parse(text) as FeedManifest;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async writeManifest(payload: string): Promise<void> {
      const index = await nextIndex();
      await writer.uploadPayload(batchId, payload, { index });
    },
    async batchStatus() {
      try {
        const batch = await bee.getPostageBatch(batchId);
        const ttl = batch.duration;
        return {
          ttlSeconds: ttl && typeof ttl.toSeconds === 'function' ? ttl.toSeconds() : null,
          depth: batch.depth,
          bucketDepth: batch.bucketDepth,
          utilization: batch.utilization,
        };
      } catch {
        return null;
      }
    },
  };
}
