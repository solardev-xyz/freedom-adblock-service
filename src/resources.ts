import { Resources } from '@ghostery/adblocker';
import { sha256Hex } from './hash.ts';

// The scriptlet + redirect resources `+js(...)` rules run: Ghostery's build of
// uBlock Origin's scriptlets, pinned to the exact file desktop bundles
// (freedom-browser scripts/fetch-adblock-lists.js RESOURCES — same tag, same
// sha256; re-pin both together). It is GPL-3.0-only executable code, so it is
// passed through byte-identical — never re-serialized — and the provenance in
// sources.json travels with it.

export interface ResourcesConfig {
  filename: string;
  tag: string;
  source_url: string;
  sha256: string;
  license: string;
  upstream?: unknown; // GPL-3.0 §6 provenance; recorded in metadata.json
}

export interface FetchedResources {
  bytes: Buffer; // exactly the pinned upstream bytes
  json: string;
  scriptletCount: number;
}

/** Download the pinned resources file; refuse anything but the pinned bytes. */
export async function fetchResources(cfg: ResourcesConfig): Promise<FetchedResources> {
  const res = await fetch(cfg.source_url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Fetch ${cfg.source_url} failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = sha256Hex(bytes);
  if (digest !== cfg.sha256) {
    throw new Error(`resources ${cfg.tag}: sha256 mismatch: pinned ${cfg.sha256}, got ${digest}`);
  }
  const json = bytes.toString('utf8');
  const parsed = Resources.parse(json, { checksum: digest });
  if (parsed.scriptlets.length === 0) throw new Error(`resources ${cfg.tag} contain no scriptlets`);
  return { bytes, json, scriptletCount: parsed.scriptlets.length };
}
