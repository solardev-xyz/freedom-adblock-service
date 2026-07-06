import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { signManifest } from './sign.ts';
import type { FeedManifest } from './manifest.ts';

/**
 * The Swarm operations publish needs, abstracted so the orchestration below is
 * testable without a live node. The live implementation lives in swarm.ts.
 */
export interface SwarmClient {
  /** Upload bytes, return the bzz hex reference. */
  uploadBytes(data: Buffer): Promise<string>;
  /** Latest manifest already on the feed, or null if the feed is empty. */
  readLatestManifest(): Promise<FeedManifest | null>;
  /** Append a new manifest payload to the feed. */
  writeManifest(payload: string): Promise<void>;
}

const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

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

/**
 * Publish a freshly-built manifest (refs empty) to the Swarm feed:
 *   1. read the current feed manifest to learn the last version + prior refs
 *   2. upload every blob whose sha256 is new; reuse the prior ref otherwise
 *   3. set version = lastVersion + 1 (monotonic), sign, write to the feed
 *
 * Skip-if-unchanged keeps network churn minimal: a category that didn't change
 * upstream keeps its existing Swarm reference.
 *
 * @returns the published manifest (with refs + sig filled in)
 */
export async function publish(
  manifest: FeedManifest,
  outDir: string,
  client: SwarmClient,
  signerKey: string,
): Promise<FeedManifest> {
  const previous = await client.readLatestManifest();
  const lastVersion = previous?.version ?? 0;

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
  }

  let uploaded = 0;
  let reused = 0;
  const refFor = async (path: string, sha256: string): Promise<string> => {
    const cached = knownRefs.get(sha256);
    if (cached) {
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

  const withRefs: FeedManifest = {
    ...manifest,
    version: lastVersion + 1,
    platforms: { desktop: { lists: desktopLists }, ios: { lists: iosLists } },
  };

  const signed = await signManifest(withRefs, signerKey);
  await client.writeManifest(JSON.stringify(signed, null, 2) + '\n');

  console.log(
    `published version ${signed.version} — uploaded ${uploaded} blob(s), reused ${reused}`,
  );
  return signed;
}
