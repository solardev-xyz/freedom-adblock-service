import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchSource } from '../src/fetch.ts';
import { convert } from '../src/convert.ts';
import { shardRules } from '../src/shard.ts';
import { writeMetadata, type CategoryMetadata, type BuildMetadata } from '../src/metadata.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(repoRoot, 'out');

interface SourcesFile {
  categories: Array<{ id: string; url: string }>;
}

const adblockRsPkg = JSON.parse(
  await readFile(join(repoRoot, 'node_modules/adblock-rs/package.json'), 'utf8'),
) as { version: string };

const sources = JSON.parse(
  await readFile(join(repoRoot, 'sources.json'), 'utf8'),
) as SourcesFile;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const generatedAt = new Date().toISOString();
const categoriesMeta: CategoryMetadata[] = [];

for (const { id, url } of sources.categories) {
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

  const shards = shardRules(mainRules, tailRules);
  const shardMeta = shards.map((shard, i) => ({
    shard,
    filename: shards.length === 1 ? `${id}.json` : `${id}-${i + 1}.json`,
  }));

  for (const { shard, filename } of shardMeta) {
    await writeFile(join(outDir, filename), shard.json + '\n', 'utf8');
  }

  const totalBytes = shards.reduce((s, sh) => s + sh.byteSize, 0);
  console.log(`  wrote ${shards.length} file(s), ${totalBytes.toLocaleString()} bytes total`);
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

console.log(`\n✓ wrote out/metadata.json`);
console.log(`✓ build complete (version ${today})`);
