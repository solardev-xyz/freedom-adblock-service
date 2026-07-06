import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Shared contract (WP5 "5.0"): the Swarm-feed filter-list manifest.
//
// This is the source of truth for the on-wire manifest that the publisher
// writes to the Swarm feed and that BOTH clients (freedom-browser desktop and
// swarm-mobile-ios) read. Keep this schema and its constants in sync with the
// client-side readers — a change here is a change to a cross-repo contract.
//
// Wire conventions:
//  - snake_case keys (matches the existing iOS metadata.json convention and
//    the manifest sketch in swarm-mobile-ios/docs/cc-research-adblock.md).
//  - One manifest document with per-platform sections, so the publisher writes
//    once and each client reads only its own section: desktop gets raw ABP
//    list text (compiles locally — engine serialized formats are version-
//    locked), iOS gets pre-compiled WebKit content-blocker JSON shards.
//  - `version` is a monotonic integer; clients reject any manifest whose
//    version is <= the one they have already applied (downgrade protection).
//  - Every referenced blob carries a `sha256` over its exact bytes; clients
//    verify before trusting.
//  - `sig` is an application-level signature (see canonicalManifestForSigning)
//    over the manifest sans `sig`, verifiable against a client-pinned public
//    key — independent of the feed's Single-Owner-Chunk owner signature, to
//    give key-rotation headroom.
// ---------------------------------------------------------------------------

/** Bump only on an incompatible change to the wire shape below. */
export const MANIFEST_SCHEMA = 1;

/**
 * Swarm feed topic the manifest is published under. Versioned in the string so
 * a future incompatible schema can move to a new topic without disturbing
 * readers of the old one. Clients hardcode this together with the feed owner
 * address as their trust anchor.
 */
export const FEED_TOPIC = 'freedom/adblock/lists/v1';

/** A desktop filter list: raw ABP text, compiled by the browser's engine. */
export interface DesktopListEntry {
  category: string; // browser category key: ads | privacy | cookies | annoyances
  list_id: string; // source list id: easylist | easyprivacy | easylist-cookies | easylist-annoyances
  title: string | null;
  source_url: string;
  license: string;
  ref: string; // bzz hex of the raw-text blob; '' until uploaded (5.A2)
  sha256: string; // over the exact raw list bytes
  bytes: number;
  rule_count: number;
}

/** One WebKit-JSON shard, compiled on iOS under the `freedom-adblock.<stem>` id. */
export interface IosShardEntry {
  filename: string; // e.g. "easylist-1.json"; its stem is the WKContentRuleList identifier
  ref: string; // bzz hex of the shard-JSON blob; '' until uploaded (5.A2)
  sha256: string; // over the exact shard-JSON bytes
  bytes: number;
  rule_count: number;
}

export interface IosListEntry {
  list_id: string;
  shards: IosShardEntry[];
}

export interface FeedManifest {
  schema: number; // MANIFEST_SCHEMA
  version: number; // monotonic; clients reject <= their applied version
  generated_at: string; // ISO 8601
  engines: Record<string, string>; // provenance, e.g. { adblock_rs: "0.12.3" }
  platforms: {
    desktop: { lists: DesktopListEntry[] };
    ios: { lists: IosListEntry[] };
  };
  sig?: string; // 0x… secp256k1 over canonicalManifestForSigning(this)
}

/** Recursively sort object keys so serialization is deterministic. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * The exact bytes `sig` is computed and verified over: the manifest without
 * its `sig` field, keys recursively sorted, compact (no whitespace). Both the
 * publisher (signing) and every client (verifying) MUST derive the signed
 * bytes this way, so the scheme is portable across languages (JS + Swift) and
 * independent of key ordering or pretty-printing in the stored payload.
 */
export function canonicalManifestForSigning(manifest: FeedManifest): string {
  const rest: Partial<FeedManifest> = { ...manifest };
  delete rest.sig;
  return JSON.stringify(sortDeep(rest));
}

/** Human-readable feed payload (pretty-printed). The stored feed entry is this. */
export function serializeManifest(manifest: FeedManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

export async function writeFeedManifest(path: string, manifest: FeedManifest): Promise<void> {
  await writeFile(path, serializeManifest(manifest), 'utf8');
}
