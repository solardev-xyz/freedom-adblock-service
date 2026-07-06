import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publish } from '../src/publish.ts';
import { createSwarmClient } from '../src/swarm.ts';
import { signerAddress } from '../src/sign.ts';
import { FEED_TOPIC, type FeedManifest } from '../src/manifest.ts';

// Publish the freshly-built out/feed-manifest.json to the Swarm feed.
// Run `npm run build` first. Requires a funded local Ant/Bee node.
//
//   FEED_SIGNER_KEY   0x-prefixed hex — feed owner + manifest signer (required)
//   BEE_API_URL       default http://127.0.0.1:1633
//   STAMP_BATCH_ID    optional; auto-selects the batch with most TTL otherwise

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, 'out');

const signerKey = process.env.FEED_SIGNER_KEY;
if (!signerKey) {
  throw new Error('FEED_SIGNER_KEY is required (0x-prefixed hex private key).');
}
const beeUrl = process.env.BEE_API_URL ?? 'http://127.0.0.1:1633';
const batchId = process.env.STAMP_BATCH_ID;

const address = signerAddress(signerKey);
console.log(`Feed owner / signer address: ${address}`);
console.log(`Feed topic:                  ${FEED_TOPIC}`);
console.log(`Bee API:                     ${beeUrl}`);
console.log('→ Pin these in the clients: FEED_OWNER_ADDRESS and MANIFEST_SIG_ADDRESS.\n');

const manifest = JSON.parse(
  await readFile(join(outDir, 'feed-manifest.json'), 'utf8'),
) as FeedManifest;

const client = await createSwarmClient({ beeUrl, signerKey, batchId });
const published = await publish(manifest, outDir, client, signerKey);

console.log(`\n✓ published version ${published.version} to feed ${FEED_TOPIC} (owner ${address})`);
