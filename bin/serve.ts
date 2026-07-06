import { buildArtifacts } from '../src/build.ts';
import { createSwarmClient } from '../src/swarm.ts';
import { runServeLoop } from '../src/serve.ts';
import { readSwarmEnv, printSwarmBanner } from '../src/swarm-env.ts';
import { abortableSleep } from '../src/sleep.ts';

// The publisher daemon (WP5 5.A3). Rebuilds the filter lists from upstream on a
// schedule and publishes only when they change; monitors the postage batch TTL.
// Deployed as a long-running container alongside a Bee/Ant node (see Dockerfile
// and docs/deploy.md).
//
// Env — FEED_SIGNER_KEY / BEE_API_URL / STAMP_BATCH_ID (see src/swarm-env.ts), plus:
//   BUILD_INTERVAL_HOURS  cycle cadence, default 12
//   BATCH_TTL_FLOOR_DAYS  warn below this TTL, default 30

const env = readSwarmEnv();
const intervalMs = (Number(process.env.BUILD_INTERVAL_HOURS) || 12) * 60 * 60 * 1000;
const batchTtlFloorSec = (Number(process.env.BATCH_TTL_FLOOR_DAYS) || 30) * 24 * 60 * 60;

printSwarmBanner(env);

// Clean shutdown for the orchestrator: SIGTERM/SIGINT abort the loop, which
// finishes the current sleep/cycle and returns.
const controller = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`\n[serve] ${sig} received — shutting down`);
    controller.abort();
  });
}

// The node may not be ready when the container starts (Coolify brings both up
// together, and Bee re-syncs postage data for a while). Retry client creation
// with backoff instead of crash-looping.
async function connectWithRetry() {
  let delayMs = 5_000;
  for (;;) {
    try {
      return await createSwarmClient(env);
    } catch (err) {
      console.warn(`[serve] node not ready (${(err as Error).message}); retrying in ${delayMs / 1000}s`);
      try {
        await abortableSleep(delayMs, controller.signal);
      } catch {
        return null; // aborted during backoff
      }
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }
}

const client = await connectWithRetry();
if (!client) {
  console.log('[serve] aborted before connecting');
  process.exit(0);
}

await runServeLoop(
  { signerKey: env.signerKey, intervalMs, batchTtlFloorSec },
  { build: () => buildArtifacts(), client },
  controller.signal,
);
