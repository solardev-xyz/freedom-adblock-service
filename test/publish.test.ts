import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';

import { publish, type SwarmClient } from '../src/publish.ts';
import { canonicalManifestForSigning, type FeedManifest } from '../src/manifest.ts';

const SIGNER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SIGNER_ADDRESS = new Wallet(SIGNER).address;
const sha256Hex = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// A fake feed: records uploads and stores the last written manifest.
function fakeClient(initial: FeedManifest | null = null) {
  const uploads: Buffer[] = [];
  let latest: FeedManifest | null = initial;
  const client: SwarmClient = {
    async uploadBytes(data) {
      uploads.push(data);
      // Deterministic fake ref derived from content.
      return `ref-${sha256Hex(data.toString('utf8')).slice(0, 8)}`;
    },
    async readLatestManifest() {
      return latest;
    },
    async writeManifest(payload) {
      latest = JSON.parse(payload) as FeedManifest;
    },
    async batchTtlSeconds() {
      return 30 * 24 * 60 * 60;
    },
  };
  return { client, uploads, get latest() { return latest; } };
}

// Build a temp out/ dir with one desktop list + one iOS shard whose bytes hash
// to the manifest entries, and return the manifest (refs empty).
async function fixture() {
  const outDir = await mkdtemp(join(tmpdir(), 'pub-'));
  await mkdir(join(outDir, 'desktop'), { recursive: true });
  const desktopText = '||ads.example^\n';
  const iosText = '[{"action":{"type":"block"},"trigger":{"url-filter":"ads"}}]\n';
  await writeFile(join(outDir, 'desktop', 'easylist.txt'), desktopText, 'utf8');
  await writeFile(join(outDir, 'easylist-1.json'), iosText, 'utf8');

  const manifest: FeedManifest = {
    schema: 1,
    version: 1, // placeholder; publish overrides from the feed
    generated_at: '2026-07-06T00:00:00Z',
    engines: { adblock_rs: '0.12.3' },
    platforms: {
      desktop: {
        lists: [
          {
            category: 'ads',
            list_id: 'easylist',
            title: 'EasyList',
            source_url: 'https://easylist.to/easylist/easylist.txt',
            license: 'GPLv3+ / CC BY-SA 3.0+',
            ref: '',
            sha256: sha256Hex(desktopText),
            bytes: Buffer.byteLength(desktopText),
            rule_count: 1,
          },
        ],
      },
      ios: {
        lists: [
          {
            list_id: 'easylist',
            shards: [
              {
                filename: 'easylist-1.json',
                ref: '',
                sha256: sha256Hex(iosText),
                bytes: Buffer.byteLength(iosText),
                rule_count: 1,
              },
            ],
          },
        ],
      },
    },
  };
  return { outDir, manifest };
}

// The fixture lists are intentionally tiny, so the sanity guard is disabled for
// tests that exercise upload/version/sig mechanics (guard has its own tests).
const NO_GUARD = { guard: false } as const;

test('publish uploads blobs, fills refs, versions from 1, and signs verifiably', async () => {
  const { outDir, manifest } = await fixture();
  const fake = fakeClient(null);

  const { manifest: published, changed } = await publish(manifest, outDir, fake.client, SIGNER, NO_GUARD);

  assert.equal(changed, true, 'first publish writes the feed');
  assert.equal(published.version, 1, 'empty feed -> version 1');
  assert.equal(fake.uploads.length, 2, 'uploaded both blobs');
  assert.ok(published.platforms.desktop.lists[0].ref.startsWith('ref-'), 'desktop ref filled');
  assert.ok(published.platforms.ios.lists[0].shards[0].ref.startsWith('ref-'), 'ios ref filled');

  // Signature recovers to the signer, over the canonical (ref-filled) manifest.
  const recovered = verifyMessage(canonicalManifestForSigning(published), published.sig!);
  assert.equal(recovered, SIGNER_ADDRESS);

  await rm(outDir, { recursive: true, force: true });
});

test('publish skips the write when content is unchanged (no version churn)', async () => {
  const { outDir, manifest } = await fixture();
  const first = (await publish(manifest, outDir, fakeClient(null).client, SIGNER, NO_GUARD)).manifest;

  // Second publish against a feed that already has `first` and identical lists.
  const fake = fakeClient(first);
  const second = await publish(manifest, outDir, fake.client, SIGNER, NO_GUARD);

  assert.equal(second.changed, false, 'unchanged content -> no write');
  assert.equal(second.manifest.version, first.version, 'version not bumped');
  assert.equal(fake.uploads.length, 0, 'nothing re-uploaded (same hashes)');
});

test('forceRepublish bumps the version even when content is unchanged', async () => {
  const { outDir, manifest } = await fixture();
  const first = (await publish(manifest, outDir, fakeClient(null).client, SIGNER, NO_GUARD)).manifest;

  const fake = fakeClient(first);
  const second = await publish(manifest, outDir, fake.client, SIGNER, { guard: false, forceRepublish: true });

  assert.equal(second.changed, true, 'forced -> write');
  assert.equal(second.manifest.version, first.version + 1, 'version bumped');
  assert.equal(fake.uploads.length, 0, 'still nothing re-uploaded (same hashes)');
});

test('publish rejects a blob whose bytes do not match the manifest sha256', async () => {
  const { outDir, manifest } = await fixture();
  manifest.platforms.desktop.lists[0].sha256 = 'deadbeef'; // wrong hash
  await assert.rejects(
    () => publish(manifest, outDir, fakeClient(null).client, SIGNER, NO_GUARD),
    /sha256 mismatch/,
  );
  await rm(outDir, { recursive: true, force: true });
});

test('guard rejects an implausibly small list (broken upstream fetch)', async () => {
  const { outDir, manifest } = await fixture(); // 15-byte desktop list, 1 rule
  await assert.rejects(
    () => publish(manifest, outDir, fakeClient(null).client, SIGNER),
    /guard: desktop:easylist too small/,
  );
  await rm(outDir, { recursive: true, force: true });
});

test('guard rejects a list that shrank sharply versus the live feed', async () => {
  const { outDir, manifest } = await fixture();
  // Live feed says easylist was 100k bytes / 10k rules; the new build is tiny.
  const previous: FeedManifest = JSON.parse(JSON.stringify(manifest));
  previous.version = 5;
  previous.platforms.desktop.lists[0].bytes = 100_000;
  previous.platforms.desktop.lists[0].rule_count = 10_000;
  previous.platforms.ios.lists[0].shards[0].bytes = 100_000;
  previous.platforms.ios.lists[0].shards[0].rule_count = 10_000;

  await assert.rejects(
    () => publish(manifest, outDir, fakeClient(previous).client, SIGNER, {
      guard: { minBytes: 1, minRuleCount: 1, maxShrinkRatio: 0.5 },
    }),
    /shrank/,
  );
  await rm(outDir, { recursive: true, force: true });
});
