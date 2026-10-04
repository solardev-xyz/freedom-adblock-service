import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from './hash.ts';
import { fetchSource } from './fetch.ts';
import { convert } from './convert.ts';
import { shardRules } from './shard.ts';
import { writeMetadata, type CategoryMetadata, type BuildMetadata } from './metadata.ts';
import { fetchUblockSource, type UblockPin } from './ublock.ts';
import { fetchResources, type ResourcesConfig } from './resources.ts';
import {
  SCRIPTLETS_FORMAT,
  emptyDropCounts,
  extractScriptletRules,
  indexResources,
  serializeScriptletsDoc,
  type ScriptletRule,
} from './scriptlets.ts';
import {
  MANIFEST_SCHEMA,
  writeFeedManifest,
  type FeedManifest,
  type DesktopListEntry,
  type IosListEntry,
} from './manifest.ts';

interface SourcesFile {
  categories: Array<{
    id: string;
    url: string;
    /** Absent on lists that only ship to iOS. */
    desktop_category?: string;
    license: string;
    /** Manifest sections that carry this list. */
    platforms: Array<'desktop' | 'ios'>;
    /** 'ublock': fetched at a uAssets commit and preprocessed (src/ublock.ts). */
    format?: 'ublock';
    extra_urls?: string[];
    pin?: UblockPin;
    /** May invoke trust-requiring scriptlets (desktop: TRUSTED_SCRIPTLET_CATEGORIES). */
    trusted_scriptlets?: boolean;
  }>;
  /** `!#if` tokens for uBlock-format lists; any token not listed is false. */
  ublock_env: Record<string, boolean>;
  resources: ResourcesConfig & { title: string };
}

export interface BuildResult {
  manifest: FeedManifest;
  outDir: string;
}

export interface BuildOptions {
  /**
   * Placeholder manifest version for the standalone build. The publish step
   * overrides it from the live feed (lastVersion + 1); for a local build with
   * no feed we fall back to seconds-since-epoch (always increasing).
   */
  manifestVersion?: number;
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Fetch every source list, convert to desktop raw-text + iOS WebKit-JSON
 * shards, and write out/ (raw lists, shards, metadata.json, feed-manifest.json
 * with empty refs). Returns the freshly-built manifest so callers don't re-read
 * it from disk. Extracted from bin/build.ts so the daemon (5.A3) can rebuild on
 * each tick without shelling out.
 */
export async function buildArtifacts(options: BuildOptions = {}): Promise<BuildResult> {
  const outDir = join(repoRoot, 'out');
  const desktopDir = join(outDir, 'desktop');

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
  // Every list's text, in sources.json order, for the scriptlet index.
  const scriptletInputs: Array<{ id: string; text: string; trusted: boolean }> = [];
  const ublockEnv = new Map(Object.entries(sources.ublock_env));

  for (const category of sources.categories) {
    const { id, url, desktop_category, license, platforms } = category;
    console.log(`\n→ ${id}`);
    console.log(`  source: ${url}${category.extra_urls ? ` (+${category.extra_urls.length})` : ''}`);

    const t0 = performance.now();
    let fetched: { text: string; sha256: string; byteSize: number };
    let ublockSource: CategoryMetadata['source'];
    if (category.format === 'ublock') {
      if (!category.pin) throw new Error(`${id}: uBlock-format list needs a pin`);
      const src = await fetchUblockSource({ url, extra_urls: category.extra_urls, pin: category.pin }, ublockEnv);
      fetched = src;
      ublockSource = {
        repo: category.pin.repo,
        commit: src.commit,
        urls: src.urls,
        fetched_at: src.fetchedAt,
        preprocessor_env: [...ublockEnv].filter(([, on]) => on).map(([token]) => token),
      };
      console.log(`  uAssets ${src.commit ?? '(commit unresolved — live Pages)'}, ${src.urls.length} file(s)`);
    } else {
      fetched = await fetchSource(url);
    }
    console.log(
      `  fetched ${fetched.byteSize.toLocaleString()} bytes ` +
      `(sha256 ${fetched.sha256.slice(0, 12)}…) in ${Math.round(performance.now() - t0)}ms`,
    );
    scriptletInputs.push({ id, text: fetched.text, trusted: category.trusted_scriptlets === true });

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
    if (platforms.includes('desktop')) {
      if (!desktop_category) throw new Error(`${id}: desktop lists need a desktop_category`);
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
      console.log(`  desktop: ${id}.txt — ${fetched.byteSize.toLocaleString()} bytes`);
    }
    if (!platforms.includes('ios')) {
      categoriesMeta.push({
        id, platforms, source_url: url, source_sha256: fetched.sha256, source_byte_size: fetched.byteSize,
        ...(ublockSource ? { source: ublockSource } : {}),
        list_title: listMeta.title, list_homepage: listMeta.homepage, list_expires: listMeta.expires,
        input_rule_count: inputRuleCount, output_rule_count: totalRules, shards: [],
      });
      continue;
    }

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
      shards: shardMeta.map(({ shard, filename, fileBytes, sha256 }) => ({
        filename,
        ref: '',
        sha256,
        // Size of the exact on-disk/blob bytes (shard JSON + trailing
        // newline) — must agree with sha256, which hashes fileBytes.
        bytes: Buffer.byteLength(fileBytes),
        rule_count: shard.rules.length,
      })),
    });

    const totalBytes = shards.reduce((s, sh) => s + sh.byteSize, 0);
    console.log(`  ios: wrote ${shards.length} shard(s), ${totalBytes.toLocaleString()} bytes total`);
    for (const { shard, filename } of shardMeta) {
      console.log(`    ${filename} — ${shard.rules.length.toLocaleString()} rules, ${shard.byteSize.toLocaleString()} bytes`);
    }

    categoriesMeta.push({
      id,
      platforms,
      source_url: url,
      source_sha256: fetched.sha256,
      source_byte_size: fetched.byteSize,
      ...(ublockSource ? { source: ublockSource } : {}),
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

  // ── iOS scriptlet artifacts: resources.json passed through byte-identical
  //    to desktop's pin, and scriptlets.json, every `+js(...)` rule of every
  //    list parsed against it (src/scriptlets.ts).
  const resourcesCfg = sources.resources;
  console.log(`\n→ scriptlets`);
  const resources = await fetchResources(resourcesCfg);
  await writeFile(join(outDir, resourcesCfg.filename), resources.bytes);
  console.log(
    `  resources: ${resourcesCfg.filename} ${resourcesCfg.tag} — ` +
    `${resources.bytes.byteLength.toLocaleString()} bytes, ${resources.scriptletCount} scriptlets`,
  );

  const index = indexResources(resources.json);
  const dropped = emptyDropCounts();
  const rules: ScriptletRule[] = [];
  const perList: Record<string, number> = {};
  for (const { id, text, trusted } of scriptletInputs) {
    const listRules = extractScriptletRules(id, text, index, { trusted }, dropped);
    perList[id] = listRules.length;
    rules.push(...listRules);
  }
  const scriptletsFile = 'scriptlets.json';
  const scriptletsBytes = serializeScriptletsDoc({
    format: SCRIPTLETS_FORMAT,
    resources: { tag: resourcesCfg.tag, sha256: resourcesCfg.sha256 },
    sources: scriptletInputs.map(({ id }) => ({ list_id: id, rule_count: perList[id]! })),
    rule_count: rules.length,
    dropped,
    rules,
  });
  await writeFile(join(outDir, scriptletsFile), scriptletsBytes, 'utf8');
  console.log(
    `  ${scriptletsFile} — ${rules.length.toLocaleString()} rules, ` +
    `${Buffer.byteLength(scriptletsBytes).toLocaleString()} bytes ` +
    `(${Object.entries(perList).map(([k, v]) => `${k} ${v}`).join(', ')})`,
  );
  console.log(`  dropped: ${Object.entries(dropped).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  const meta: BuildMetadata = {
    version: today,
    generated_at: generatedAt,
    lib_version: `adblock-rs@${adblockRsPkg.version}`,
    categories: categoriesMeta,
    scriptlets: { filename: scriptletsFile, format: SCRIPTLETS_FORMAT, rule_count: rules.length, per_list: perList, dropped },
    resources: {
      filename: resourcesCfg.filename,
      title: resourcesCfg.title,
      tag: resourcesCfg.tag,
      source_url: resourcesCfg.source_url,
      sha256: resourcesCfg.sha256,
      license: resourcesCfg.license,
      bytes: resources.bytes.byteLength,
      scriptlet_count: resources.scriptletCount,
      upstream: resourcesCfg.upstream,
    },
  };
  await writeMetadata(outDir, meta);

  // Shared Swarm-feed manifest (WP5). `version` is a monotonic integer; the
  // publish step (5.A2/5.A3) sets it to lastFeedVersion + 1. For a local build
  // with no feed, default to seconds-since-epoch (always increasing).
  const manifestVersion = options.manifestVersion ?? Math.floor(Date.now() / 1000);
  const manifest: FeedManifest = {
    schema: MANIFEST_SCHEMA,
    version: manifestVersion,
    generated_at: generatedAt,
    engines: { adblock_rs: adblockRsPkg.version },
    platforms: {
      desktop: { lists: desktopLists },
      ios: {
        lists: iosLists,
        scriptlets: {
          filename: scriptletsFile,
          ref: '',
          sha256: sha256Hex(scriptletsBytes),
          bytes: Buffer.byteLength(scriptletsBytes),
          rule_count: rules.length,
          format: SCRIPTLETS_FORMAT,
        },
        resources: {
          filename: resourcesCfg.filename,
          ref: '',
          sha256: resourcesCfg.sha256,
          bytes: resources.bytes.byteLength,
          source_url: resourcesCfg.source_url,
          tag: resourcesCfg.tag,
          license: resourcesCfg.license,
        },
      },
    },
  };
  await writeFeedManifest(join(outDir, 'feed-manifest.json'), manifest);

  console.log(`\n✓ wrote out/metadata.json`);
  console.log(`✓ wrote out/feed-manifest.json (version ${manifestVersion}, refs empty until publish)`);
  console.log(`✓ wrote out/desktop/*.txt (${desktopLists.length} raw lists)`);
  console.log(`✓ build complete (version ${today})`);

  return { manifest, outDir };
}
