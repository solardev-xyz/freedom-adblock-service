import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ShardMetadata {
  filename: string;
  rule_count: number;
  byte_size: number;
}

export interface CategoryMetadata {
  id: string;
  source_url: string;
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
}

export async function writeMetadata(outDir: string, meta: BuildMetadata): Promise<void> {
  await writeFile(join(outDir, 'metadata.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}
