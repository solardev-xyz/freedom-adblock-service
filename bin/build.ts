import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchSource } from '../src/fetch.ts';
import { convert } from '../src/convert.ts';
import { shardRules } from '../src/shard.ts';
import { writeMetadata, type CategoryMetadata, type BuildMetadata } from '../src/metadata.ts';
import {
  MANIFEST_SCHEMA,
  writeFeedManifest,
  type FeedManifest,
  type DesktopListEntry,
  type IosListEntry,
} from '../src/manifest.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, 'out');
const desktopDir = join(outDir, 'desktop');

const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

interface SourcesFile {
  categories: Array<{
    id: string;
    url: string;
    desktop_category: string;
    license: string;
  }>;
}

const adblockRsPkg = JSON.parse(
  await readFile(join(repoRoot, 'node_modules/adblock-rs/package.json'), 'utf8'),
) as { version: string };

const sources = JSON.parse(
  await readFile(join(repoRoot, 'sources.json'), 'utf8'),
) as SourcesFile;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(desktopDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const generatedAt = new Date().toISOString();
const categoriesMeta: CategoryMetadata[] = [];
// Shared Swarm-feed manifest entries (WP5). `ref` stays '' here — the publish
// step (5.A2) uploads each blob and fills in its bzz reference.
const desktopLists: DesktopListEntry[] = [];
const iosLists: IosListEntry[] = [];

for (const { id, url, desktop_category, license } of sources.categories) {
  console.log(`\n→ ${id}`);
  console.log(`  source: ${url}`);

  const t0 = performance.now();
  const fetched = await fetchSource(url);
  console.log(
    `  fetched ${fetched.byteSize.toLocaleString()} bytes ` +
    `(sha256 ${fetched.sha256.slice(0, 12)}…) in ${Math.round(performance.now() - t0)}ms`,
  );

  const t1 = performance.now();
  const { mainRules, tailRules, listMeta, inputRuleCount } = convert(fetched.text);
  const totalRules = mainRules.length + tailRules.length;
  console.log(
    `  converted ${inputRuleCount.toLocaleString()} input lines → ` +
    `${totalRules.toLocaleString()} rules ` +
    `(${mainRules.length.toLocaleString()} main + ${tailRules.length} safety-tail) ` +
    `in ${Math.round(performance.now() - t1)}ms`,
  );

  // ── Desktop artifact: the raw ABP list text, compiled by the browser
  //    engine. The uploaded blob (and its sha256) IS this exact text, so the
  //    manifest entry reuses fetched.sha256 / byteSize.
  await writeFile(join(desktopDir, `${id}.txt`), fetched.text, 'utf8');
  desktopLists.push({
    category: desktop_category,
    list_id: id,
    title: listMeta.title,
    source_url: url,
    license,
    ref: '',
    sha256: fetched.sha256,
    bytes: fetched.byteSize,
    rule_count: inputRuleCount,
  });

  // ── iOS artifact: WebKit-JSON shards. Hash the exact on-disk bytes
  //    (shard JSON + trailing newline) so the manifest sha256 == the file ==
  //    the blob the publisher uploads == what the client downloads and writes.
  const shards = shardRules(mainRules, tailRules);
  const shardMeta = shards.map((shard, i) => {
    const fileBytes = shard.json + '\n';
    return {
      shard,
      filename: shards.length === 1 ? `${id}.json` : `${id}-${i + 1}.json`,
      fileBytes,
      sha256: sha256Hex(fileBytes),
    };
  });

  for (const { filename, fileBytes } of shardMeta) {
    await writeFile(join(outDir, filename), fileBytes, 'utf8');
  }

  iosLists.push({
    list_id: id,
    shards: shardMeta.map(({ shard, filename, sha256 }) => ({
      filename,
      ref: '',
      sha256,
      bytes: shard.byteSize,
      rule_count: shard.rules.length,
    })),
  });

  const totalBytes = shards.reduce((s, sh) => s + sh.byteSize, 0);
  console.log(`  desktop: ${id}.txt — ${fetched.byteSize.toLocaleString()} bytes`);
  console.log(`  ios: wrote ${shards.length} shard(s), ${totalBytes.toLocaleString()} bytes total`);
  for (const { shard, filename } of shardMeta) {
    console.log(`    ${filename} — ${shard.rules.length.toLocaleString()} rules, ${shard.byteSize.toLocaleString()} bytes`);
  }

  categoriesMeta.push({
    id,
    source_url: url,
    source_sha256: fetched.sha256,
    source_byte_size: fetched.byteSize,
    list_title: listMeta.title,
    list_homepage: listMeta.homepage,
    list_expires: listMeta.expires,
    input_rule_count: inputRuleCount,
    output_rule_count: totalRules,
    shards: shardMeta.map(({ shard, filename }) => ({
      filename,
      rule_count: shard.rules.length,
      byte_size: shard.byteSize,
    })),
  });
}

const meta: BuildMetadata = {
  version: today,
  generated_at: generatedAt,
  lib_version: `adblock-rs@${adblockRsPkg.version}`,
  categories: categoriesMeta,
};
await writeMetadata(outDir, meta);

// Shared Swarm-feed manifest (WP5). `version` is a monotonic integer; the
// publish step (5.A2/5.A3) sets it to lastFeedVersion + 1. For a local build
// with no feed, default to seconds-since-epoch (always increasing) or an
// explicit MANIFEST_VERSION override. `sig` is added at publish time.
const manifestVersion = Number(process.env.MANIFEST_VERSION) || Math.floor(Date.now() / 1000);
const feedManifest: FeedManifest = {
  schema: MANIFEST_SCHEMA,
  version: manifestVersion,
  generated_at: generatedAt,
  engines: { adblock_rs: adblockRsPkg.version },
  platforms: {
    desktop: { lists: desktopLists },
    ios: { lists: iosLists },
  },
};
await writeFeedManifest(join(outDir, 'feed-manifest.json'), feedManifest);

console.log(`\n✓ wrote out/metadata.json`);
console.log(`✓ wrote out/feed-manifest.json (version ${manifestVersion}, refs empty until publish)`);
console.log(`✓ wrote out/desktop/*.txt (${desktopLists.length} raw lists)`);
console.log(`✓ build complete (version ${today})`);
