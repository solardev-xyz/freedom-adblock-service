import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publish } from '../src/publish.ts';
import { createSwarmClient } from '../src/swarm.ts';
import { readSwarmEnv, printSwarmBanner } from '../src/swarm-env.ts';
import { FEED_TOPIC, type FeedManifest } from '../src/manifest.ts';

// Publish the freshly-built out/feed-manifest.json to the Swarm feed.
// Run `npm run build` first. Requires a funded local Ant/Bee node.
// Env (see src/swarm-env.ts): FEED_SIGNER_KEY (required), BEE_API_URL, STAMP_BATCH_ID.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, 'out');

const env = readSwarmEnv();
printSwarmBanner(env);

const manifest = JSON.parse(
  await readFile(join(outDir, 'feed-manifest.json'), 'utf8'),
) as FeedManifest;

const client = await createSwarmClient(env);
const result = await publish(manifest, outDir, client, env.signerKey);

if (result.changed) {
  console.log(`\n✓ published version ${result.manifest.version} to feed ${FEED_TOPIC} (owner ${env.address})`);
} else {
  console.log(`\n✓ feed already up to date at version ${result.manifest.version} (nothing to publish)`);
}
