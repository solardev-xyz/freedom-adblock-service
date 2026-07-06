import { abortableSleep } from './sleep.ts';
import type { BuildResult } from './build.ts';
import { publish as defaultPublish, type SwarmClient } from './publish.ts';

// The long-running publisher daemon (WP5 5.A3). Each cycle rebuilds the lists
// from upstream, publishes only when something changed, and reports the postage
// batch's remaining TTL so a lapse gets noticed before the feed vanishes.
//
// Deliberately dependency-injected (build / client / publish / sleep / log) so
// the loop is unit-testable without a live node or network fetches.

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export interface ServeConfig {
  /** Feed owner + manifest signer key (0x hex). */
  signerKey: string;
  /** Delay between cycles. */
  intervalMs: number;
  /** Warn when the postage batch drops below this many seconds of TTL. */
  batchTtlFloorSec: number;
}

export interface ServeIO {
  build: () => Promise<BuildResult>;
  client: SwarmClient;
  publish?: typeof defaultPublish;
  log?: Logger;
  /** Interruptible sleep; defaults to an AbortSignal-aware timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CycleResult {
  changed: boolean;
  version: number;
  uploaded: number;
  reused: number;
  ttlSeconds: number | null;
}

const DAY_SEC = 24 * 60 * 60;

/**
 * One publish cycle: build → publish-if-changed → report batch TTL. Throws on
 * any failure (bad build, node down, guard trip); the loop catches and retries
 * next tick, so the last-good feed stays live.
 */
export async function runPublishCycle(config: ServeConfig, io: ServeIO): Promise<CycleResult> {
  const log = io.log ?? consoleLogger;
  const publishFn = io.publish ?? defaultPublish;

  const { manifest, outDir } = await io.build();
  const result = await publishFn(manifest, outDir, io.client, config.signerKey);

  if (result.changed) {
    log.info(
      `[publish] wrote version ${result.manifest.version} ` +
      `(uploaded ${result.uploaded}, reused ${result.reused})`,
    );
  } else {
    log.info(`[publish] no change; feed stays at version ${result.manifest.version}`);
  }

  const ttl = await io.client.batchTtlSeconds();
  if (ttl == null) {
    log.warn('[stamp] batch TTL unknown (query failed) — check the node');
  } else if (ttl < config.batchTtlFloorSec) {
    log.warn(
      `[stamp] batch TTL ${Math.round(ttl / DAY_SEC)}d is below the ` +
      `${Math.round(config.batchTtlFloorSec / DAY_SEC)}d floor — top it up before it lapses`,
    );
  } else {
    log.info(`[stamp] batch TTL ${Math.round(ttl / DAY_SEC)}d`);
  }

  return {
    changed: result.changed,
    version: result.manifest.version,
    uploaded: result.uploaded,
    reused: result.reused,
    ttlSeconds: ttl,
  };
}

/**
 * Run publish cycles forever, one immediately then every intervalMs, until the
 * signal aborts. A failing cycle is logged and skipped — the daemon never
 * crashes on a transient upstream or node hiccup.
 */
export async function runServeLoop(
  config: ServeConfig,
  io: ServeIO,
  signal?: AbortSignal,
): Promise<void> {
  const log = io.log ?? consoleLogger;
  const sleep = io.sleep ?? abortableSleep;

  log.info(
    `[serve] starting — publishing every ${Math.round(config.intervalMs / 1000)}s, ` +
    `TTL floor ${Math.round(config.batchTtlFloorSec / DAY_SEC)}d`,
  );

  while (!signal?.aborted) {
    try {
      await runPublishCycle(config, io);
    } catch (err) {
      log.error(`[serve] cycle failed, will retry next tick: ${(err as Error).message}`);
    }
    try {
      await sleep(config.intervalMs, signal);
    } catch {
      break; // sleep rejected because the signal aborted
    }
  }

  log.info('[serve] stopped');
}
