import { signerAddress } from './sign.ts';
import { FEED_TOPIC } from './manifest.ts';

// Shared decoding of the Swarm publisher env + startup banner, used by both the
// one-shot publish CLI (bin/publish.ts) and the daemon (bin/serve.ts).

export interface SwarmEnv {
  signerKey: string; // feed owner + manifest signer
  beeUrl: string;
  batchId?: string;
  address: string; // derived from signerKey; clients pin this
}

export function readSwarmEnv(): SwarmEnv {
  const signerKey = process.env.FEED_SIGNER_KEY;
  if (!signerKey) {
    throw new Error('FEED_SIGNER_KEY is required (0x-prefixed hex private key).');
  }
  const beeUrl = process.env.BEE_API_URL ?? 'http://127.0.0.1:1633';
  const batchId = process.env.STAMP_BATCH_ID;
  return { signerKey, beeUrl, batchId, address: signerAddress(signerKey) };
}

export function printSwarmBanner(env: SwarmEnv): void {
  console.log(`Feed owner / signer: ${env.address}`);
  console.log(`Feed topic:          ${FEED_TOPIC}`);
  console.log(`Bee API:             ${env.beeUrl}`);
  console.log(`Batch:               ${env.batchId ?? '(auto-select most TTL)'}`);
  console.log('→ Clients must pin this owner/signer as FEED_OWNER_ADDRESS / MANIFEST_SIG_ADDRESS.\n');
}
