import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPublishCycle, runServeLoop, type ServeIO, type Logger } from '../src/serve.ts';
import type { SwarmClient, PublishResult } from '../src/publish.ts';
import type { BuildResult } from '../src/build.ts';
import type { FeedManifest } from '../src/manifest.ts';

const CONFIG = { signerKey: '0xabc', intervalMs: 1000, batchTtlFloorSec: 30 * 24 * 60 * 60 };

function collectingLogger() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
  return { log, lines };
}

function fakeManifest(version: number): FeedManifest {
  return {
    schema: 1,
    version,
    generated_at: '2026-07-06T00:00:00Z',
    engines: {},
    platforms: { desktop: { lists: [] }, ios: { lists: [] } },
  };
}

// A ServeIO whose build/publish/client are all stubs, so the loop mechanics can
// be tested without a node or upstream fetches.
function fakeIO(opts: {
  ttl?: number | null;
  depth?: number;
  utilization?: number;
  changed?: boolean;
  publishErr?: Error;
  log?: Logger;
}): ServeIO {
  const client: SwarmClient = {
    async uploadBytes() { return 'ref'; },
    async readLatestManifest() { return null; },
    async writeManifest() {},
    async batchStatus() {
      if ('ttl' in opts && opts.ttl === null) return null; // query failed
      return {
        ttlSeconds: opts.ttl ?? 90 * 24 * 60 * 60,
        depth: opts.depth ?? 20,
        bucketDepth: 16,
        utilization: opts.utilization ?? 1,
      };
    },
  };
  return {
    build: async (): Promise<BuildResult> => ({ manifest: fakeManifest(2), outDir: '/tmp/x' }),
    client,
    log: opts.log,
    publish: async (): Promise<PublishResult> => {
      if (opts.publishErr) throw opts.publishErr;
      return { manifest: fakeManifest(2), changed: opts.changed ?? true, uploaded: 1, reused: 0 };
    },
  };
}

test('runPublishCycle reports version, change, and TTL', async () => {
  const { log, lines } = collectingLogger();
  const result = await runPublishCycle(CONFIG, fakeIO({ ttl: 90 * 24 * 60 * 60, log }));
  assert.equal(result.changed, true);
  assert.equal(result.version, 2);
  assert.ok(lines.some((l) => l.includes('wrote version 2')));
  assert.ok(lines.some((l) => l.includes('batch TTL 90d')));
});

test('runPublishCycle warns when the batch TTL is below the floor', async () => {
  const { log, lines } = collectingLogger();
  await runPublishCycle(CONFIG, fakeIO({ ttl: 10 * 24 * 60 * 60, log }));
  assert.ok(lines.some((l) => l.startsWith('warn') && l.includes('below the')));
});

test('runPublishCycle warns when the batch status is unknown', async () => {
  const { log, lines } = collectingLogger();
  await runPublishCycle(CONFIG, fakeIO({ ttl: null, log }));
  assert.ok(lines.some((l) => l.startsWith('warn') && l.includes('status unknown')));
});

test('runPublishCycle warns on a too-shallow batch (silent chunk loss)', async () => {
  const { log, lines } = collectingLogger();
  await runPublishCycle(CONFIG, fakeIO({ depth: 17, utilization: 0, log }));
  assert.ok(
    lines.some((l) => l.startsWith('warn') && l.includes('below the safe floor')),
    lines.join('\n'),
  );
});

test('runPublishCycle warns when the fullest bucket nears its slot count', async () => {
  const { log, lines } = collectingLogger();
  // depth 20 -> 16 slots/bucket; utilization 13 crosses the 16 - 4 threshold.
  await runPublishCycle(CONFIG, fakeIO({ depth: 20, utilization: 13, log }));
  assert.ok(
    lines.some((l) => l.startsWith('warn') && l.includes('nearing overflow')),
    lines.join('\n'),
  );
});

test('runPublishCycle stays quiet on a healthy deep batch', async () => {
  const { log, lines } = collectingLogger();
  await runPublishCycle(CONFIG, fakeIO({ depth: 20, utilization: 3, log }));
  assert.ok(!lines.some((l) => l.startsWith('warn')), lines.join('\n'));
});

test('runServeLoop runs until aborted and a failing cycle does not stop it', async () => {
  const { log, lines } = collectingLogger();
  const controller = new AbortController();

  let cycles = 0;
  const io: ServeIO = {
    ...fakeIO({ log }),
    build: async (): Promise<BuildResult> => {
      cycles += 1;
      if (cycles === 1) throw new Error('boom'); // first cycle fails
      if (cycles >= 3) controller.abort(); // stop after a few
      return { manifest: fakeManifest(2), outDir: '/tmp/x' };
    },
    // No real sleeping between cycles.
    sleep: async () => {},
  };

  await runServeLoop(CONFIG, io, controller.signal);

  assert.ok(cycles >= 3, 'looped multiple times');
  assert.ok(lines.some((l) => l.startsWith('error') && l.includes('boom')), 'logged the failure');
  assert.ok(lines.some((l) => l.includes('[serve] stopped')), 'stopped cleanly');
});

test('runServeLoop stops immediately if already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let built = false;
  const io: ServeIO = { ...fakeIO({}), build: async () => { built = true; return { manifest: fakeManifest(1), outDir: '/x' }; } };
  await runServeLoop(CONFIG, io, controller.signal);
  assert.equal(built, false, 'no cycle ran');
});
