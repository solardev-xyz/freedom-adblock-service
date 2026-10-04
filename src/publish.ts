import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256Hex } from './hash.ts';
import { signManifest } from './sign.ts';
import { canonicalManifestForSigning, serializeManifest, type FeedManifest } from './manifest.ts';

/**
 * The Swarm operations the publisher service needs, abstracted so the
 * orchestration below is testable without a live node. The live implementation
 * lives in swarm.ts.
 */
export interface SwarmClient {
  /** Upload bytes, return the bzz hex reference. */
  uploadBytes(data: Buffer): Promise<string>;
  /** Latest manifest already on the feed, or null if the feed is empty. */
  readLatestManifest(): Promise<FeedManifest | null>;
  /** Append a new manifest payload to the feed. */
  writeManifest(payload: string): Promise<void>;
  /** Health of the postage batch, or null if the query failed. */
  batchStatus(): Promise<BatchStatus | null>;
}

/**
 * Postage-batch health the daemon monitors. `utilization` is bee's "fullest
 * bucket" counter: a batch of depth D has 2^bucketDepth buckets of
 * 2^(D - bucketDepth) slots each, and chunks land in buckets by content hash.
 * When a bucket is full, a MUTABLE batch silently overwrites its oldest stamp
 * — previously published chunks vanish from the network with no error. So
 * utilization must stay clear of the per-bucket slot count.
 */
export interface BatchStatus {
  ttlSeconds: number | null;
  depth: number;
  bucketDepth: number;
  utilization: number;
}

/**
 * Floors that guard against publishing a broken build. A truncated or
 * error-page fetch that slips past fetch.ts's status check would otherwise gut
 * the block lists for every client on the next update — so we refuse to publish
 * a list that is implausibly small, or that shrank sharply versus what's
 * already live.
 */
export interface GuardThresholds {
  /** Reject any list whose blob total is below this many bytes. */
  minBytes: number;
  /** Reject any list below this many rules. */
  minRuleCount: number;
  /** Reject a list that shrank to below (1 - ratio) of its live size. */
  maxShrinkRatio: number;
  /**
   * Reject a scriptlet index below this many rules. uBlock's own lists carry
   * ~9k of the ~12k; a failed uAssets fetch fails the build outright, but a
   * fetch that "succeeds" with a stub would otherwise strip YouTube & co.
   */
  minScriptletRules: number;
}

export const DEFAULT_GUARD: GuardThresholds = {
  minBytes: 1024,
  minRuleCount: 50,
  maxShrinkRatio: 0.5,
  minScriptletRules: 1000,
};

export interface PublishOptions {
  /** Sanity floors; pass false to disable (not recommended). Default DEFAULT_GUARD. */
  guard?: GuardThresholds | false;
  /** Write a new feed version even when content is byte-for-byte unchanged. */
  forceRepublish?: boolean;
  /**
   * Upload every blob even when the previous manifest already carries its
   * ref. Content-addressing keeps the refs identical — this re-stamps and
   * re-pushes the chunks, the recovery move after a batch turned out to be
   * too shallow (bucket overflow on a mutable batch silently drops chunks)
   * or otherwise lost data.
   */
  uploadAll?: boolean;
  /**
   * Lowest version this publish may write — and a declaration that the feed
   * has history. Clients reject any manifest whose version is <= one they have
   * applied, so after a version was written but never stayed retrievable (the
   * 2026-09-19 batch expiry ate v143 within the hour), the next write must
   * skip past it. And since the feed is known to exist, a lookup that finds
   * nothing is a node/network failure, not an empty feed: publishing would
   * restart the feed at version 1, which every client rejects as a downgrade.
   */
  minVersion?: number;
}

export interface PublishResult {
  /** The manifest now current on the feed (newly written, or the unchanged prior one). */
  manifest: FeedManifest;
  /** Whether a new feed version was written this call. */
  changed: boolean;
  uploaded: number;
  reused: number;
}

/** On-disk path of a manifest blob relative to the build's out/ dir. */
function blobPath(outDir: string, kind: 'desktop' | 'ios', name: string): string {
  return kind === 'desktop' ? join(outDir, 'desktop', `${name}.txt`) : join(outDir, name);
}

/**
 * Read a blob, assert its bytes match the manifest sha256 (guards against any
 * build/format drift between the manifest and the files on disk), and return
 * the bytes + hash.
 */
async function readVerifiedBlob(path: string, expectedSha256: string): Promise<Buffer> {
  const bytes = await readFile(path);
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`sha256 mismatch for ${path}: manifest ${expectedSha256}, file ${actual}`);
  }
  return bytes;
}

/** {bytes, rules} totals per list_id, aggregating iOS shards. */
function listSizes(manifest: FeedManifest): Map<string, { bytes: number; rules: number }> {
  const sizes = new Map<string, { bytes: number; rules: number }>();
  for (const list of manifest.platforms.desktop.lists) {
    sizes.set(`desktop:${list.list_id}`, { bytes: list.bytes, rules: list.rule_count });
  }
  for (const list of manifest.platforms.ios.lists) {
    const total = list.shards.reduce(
      (acc, s) => ({ bytes: acc.bytes + s.bytes, rules: acc.rules + s.rule_count }),
      { bytes: 0, rules: 0 },
    );
    sizes.set(`ios:${list.list_id}`, total);
  }
  const { scriptlets } = manifest.platforms.ios;
  if (scriptlets) sizes.set('ios:scriptlets', { bytes: scriptlets.bytes, rules: scriptlets.rule_count });
  return sizes;
}

/**
 * Throw if any list in `next` looks broken: below the absolute floors, or
 * shrank past maxShrinkRatio versus the live `previous` manifest. Runs before
 * any upload so a bad build costs nothing and the last-good feed stays live.
 */
export function assertSaneManifest(
  next: FeedManifest,
  previous: FeedManifest | null,
  t: GuardThresholds,
): void {
  const prevSizes = previous ? listSizes(previous) : new Map();
  for (const [key, size] of listSizes(next)) {
    if (size.bytes < t.minBytes || size.rules < t.minRuleCount) {
      throw new Error(
        `guard: ${key} too small (${size.bytes} bytes, ${size.rules} rules; ` +
        `floor ${t.minBytes} bytes / ${t.minRuleCount} rules) — refusing to publish`,
      );
    }
    const prev = prevSizes.get(key);
    if (prev && size.bytes < prev.bytes * (1 - t.maxShrinkRatio)) {
      throw new Error(
        `guard: ${key} shrank ${prev.bytes} → ${size.bytes} bytes ` +
        `(>${Math.round(t.maxShrinkRatio * 100)}% drop) — refusing to publish`,
      );
    }
  }
  const { scriptlets, resources } = next.platforms.ios;
  if (scriptlets && scriptlets.rule_count < t.minScriptletRules) {
    throw new Error(
      `guard: ios:scriptlets has ${scriptlets.rule_count} rules ` +
      `(floor ${t.minScriptletRules}) — refusing to publish`,
    );
  }
  if (resources && resources.bytes < t.minBytes) {
    throw new Error(`guard: ios:resources too small (${resources.bytes} bytes) — refusing to publish`);
  }
}

/**
 * Content fingerprint that ignores the fields expected to change every build
 * (version, generated_at) and the signature — so two builds with identical
 * lists compare equal and we skip a needless feed write.
 */
function contentKey(manifest: FeedManifest): string {
  return canonicalManifestForSigning({ ...manifest, version: 0, generated_at: '' });
}

/**
 * Publish a freshly-built manifest (refs empty) to the Swarm feed:
 *   1. read the current feed manifest to learn the last version + prior refs
 *   2. sanity-guard the new build against it (floors + max shrink)
 *   3. upload every blob whose sha256 is new; reuse the prior ref otherwise
 *      (or upload all of them, with uploadAll)
 *   4. if content is unchanged, skip the write (no version churn); otherwise
 *      set version = max(lastVersion + 1, minVersion) (monotonic), sign, and
 *      write to the feed
 *
 * @returns what is now current on the feed + whether a new version was written
 */
export async function publish(
  manifest: FeedManifest,
  outDir: string,
  client: SwarmClient,
  signerKey: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const guard = options.guard ?? DEFAULT_GUARD;
  const previous = await client.readLatestManifest();
  const minVersion = options.minVersion ?? 1;
  if (!previous && minVersion > 1) {
    throw new Error(
      `feed lookup found no manifest, but the feed has history (min version ${minVersion}) — ` +
      `refusing to restart it at version 1; check the node`,
    );
  }
  const lastVersion = previous?.version ?? 0;

  if (guard) assertSaneManifest(manifest, previous, guard);

  // sha256 -> ref from the previous manifest, so unchanged blobs skip re-upload.
  const knownRefs = new Map<string, string>();
  if (previous) {
    for (const list of previous.platforms.desktop.lists) {
      if (list.ref) knownRefs.set(list.sha256, list.ref);
    }
    for (const list of previous.platforms.ios.lists) {
      for (const shard of list.shards) {
        if (shard.ref) knownRefs.set(shard.sha256, shard.ref);
      }
    }
    for (const blob of [previous.platforms.ios.scriptlets, previous.platforms.ios.resources]) {
      if (blob?.ref) knownRefs.set(blob.sha256, blob.ref);
    }
  }

  let uploaded = 0;
  let reused = 0;
  const refFor = async (path: string, sha256: string): Promise<string> => {
    const cached = knownRefs.get(sha256);
    if (cached && !options.uploadAll) {
      reused++;
      return cached;
    }
    const ref = await client.uploadBytes(await readVerifiedBlob(path, sha256));
    knownRefs.set(sha256, ref);
    uploaded++;
    return ref;
  };

  const desktopLists = [];
  for (const list of manifest.platforms.desktop.lists) {
    desktopLists.push({ ...list, ref: await refFor(blobPath(outDir, 'desktop', list.list_id), list.sha256) });
  }

  const iosLists = [];
  for (const list of manifest.platforms.ios.lists) {
    const shards = [];
    for (const shard of list.shards) {
      shards.push({ ...shard, ref: await refFor(blobPath(outDir, 'ios', shard.filename), shard.sha256) });
    }
    iosLists.push({ ...list, shards });
  }

  // Optional iOS scriptlet artifacts (scriptlets.json + resources.json).
  const { scriptlets, resources } = manifest.platforms.ios;
  const iosExtras = {
    ...(scriptlets && {
      scriptlets: { ...scriptlets, ref: await refFor(blobPath(outDir, 'ios', scriptlets.filename), scriptlets.sha256) },
    }),
    ...(resources && {
      resources: { ...resources, ref: await refFor(blobPath(outDir, 'ios', resources.filename), resources.sha256) },
    }),
  };

  const withRefs: FeedManifest = {
    ...manifest,
    version: Math.max(lastVersion + 1, minVersion),
    platforms: { desktop: { lists: desktopLists }, ios: { lists: iosLists, ...iosExtras } },
  };

  if (!options.forceRepublish && previous && contentKey(withRefs) === contentKey(previous)) {
    console.log(`unchanged — feed stays at version ${previous.version} (${reused} ref(s) reused)`);
    return { manifest: previous, changed: false, uploaded, reused };
  }

  const signed = await signManifest(withRefs, signerKey);
  await client.writeManifest(serializeManifest(signed));

  console.log(
    `published version ${signed.version} — uploaded ${uploaded} blob(s), reused ${reused}`,
  );
  return { manifest: signed, changed: true, uploaded, reused };
}
