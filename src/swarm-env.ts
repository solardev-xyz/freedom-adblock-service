import { signerAddress } from './sign.ts';
import { FEED_TOPIC } from './manifest.ts';

// Shared decoding of the Swarm publisher env + startup banner, used by both the
// one-shot publish CLI (bin/publish.ts) and the daemon (bin/serve.ts).

export interface SwarmEnv {
  signerKey: string; // feed owner + manifest signer
  beeUrl: string;
  batchId?: string;
  address: string; // derived from signerKey; clients pin this
  /** FEED_MIN_VERSION — see PublishOptions.minVersion. */
  minVersion?: number;
}

export function readSwarmEnv(): SwarmEnv {
  const signerKey = process.env.FEED_SIGNER_KEY;
  if (!signerKey) {
    throw new Error('FEED_SIGNER_KEY is required (0x-prefixed hex private key).');
  }
  const beeUrl = process.env.BEE_API_URL ?? 'http://127.0.0.1:1633';
  const batchId = process.env.STAMP_BATCH_ID;
  const minVersion = process.env.FEED_MIN_VERSION ? Number(process.env.FEED_MIN_VERSION) : undefined;
  if (minVersion !== undefined && !(Number.isInteger(minVersion) && minVersion >= 1)) {
    throw new Error(`FEED_MIN_VERSION must be a positive integer, got ${process.env.FEED_MIN_VERSION}`);
  }
  return { signerKey, beeUrl, batchId, address: signerAddress(signerKey), minVersion };
}

export function printSwarmBanner(env: SwarmEnv): void {
  console.log(`Feed owner / signer: ${env.address}`);
  console.log(`Feed topic:          ${FEED_TOPIC}`);
  console.log(`Bee API:             ${env.beeUrl}`);
  console.log(`Batch:               ${env.batchId ?? '(auto-select most TTL)'}`);
  console.log(`Min version:         ${env.minVersion ?? '(none — an empty feed lookup starts at 1)'}`);
  console.log('→ Clients must pin this owner/signer as FEED_OWNER_ADDRESS / MANIFEST_SIG_ADDRESS.\n');
}
