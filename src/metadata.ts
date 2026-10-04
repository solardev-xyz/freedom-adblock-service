import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ShardMetadata {
  filename: string;
  rule_count: number;
  byte_size: number;
}

export interface CategoryMetadata {
  id: string;
  platforms: string[]; // which manifest sections carry this list (desktop / ios)
  source_url: string;
  /** uBlock-format lists: the exact upstream revision (GPL-3.0 source) and env. */
  source?: {
    repo: string;
    commit: string | null; // null: fetched from the live Pages site on fetched_at
    urls: string[];
    fetched_at: string;
    preprocessor_env: string[]; // `!#if` tokens evaluated true
  };
  source_sha256: string;
  source_byte_size: number;
  list_title: string | null;
  list_homepage: string | null;
  list_expires: unknown; // upstream serializes a Rust enum, e.g. `{ "Days": 4 }`
  input_rule_count: number;
  output_rule_count: number;
  shards: ShardMetadata[];
}

export interface BuildMetadata {
  version: string;       // YYYY-MM-DD; cache key for the iOS-side update check
  generated_at: string;  // full ISO timestamp
  lib_version: string;   // e.g. "adblock-rs@0.12.3"
  categories: CategoryMetadata[];
  scriptlets?: {
    filename: string;
    format: number;
    rule_count: number;
    per_list: Record<string, number>;
    dropped: Record<string, number>;
  };
  resources?: {
    filename: string;
    title: string;
    tag: string;
    source_url: string;
    sha256: string;
    license: string;
    bytes: number;
    scriptlet_count: number;
    upstream?: unknown;
  };
}

export async function writeMetadata(outDir: string, meta: BuildMetadata): Promise<void> {
  await writeFile(join(outDir, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}
