import type { ContentBlockingRule } from 'adblock-rs';

// iOS 17+ has an undocumented size-based crash threshold for compiled
// content blockers, well below the documented 150K-rule cap. AdGuard
// 4.5.1 reported crashes at 40-60K rules; their fix was to cap by JSON
// byte size. AdGuard never published their exact threshold; 1.9 MB
// per shard sits comfortably under what they reported as workable.
const MAX_BYTES = 1_900_000;

export interface Shard {
  rules: ContentBlockingRule[];
  json: string;
  byteSize: number;
}

/// Splits `mainRules` into shards under the byte cap, with `tailRules`
/// appended verbatim to the end of every shard. The caller is responsible
/// for promoting catch-all safety rules into `tailRules`; see convert.ts.
export function shardRules(
  mainRules: ContentBlockingRule[],
  tailRules: ContentBlockingRule[] = [],
): Shard[] {
  // Reserve byte budget for the tail rules every shard has to carry.
  const tailByteBudget = tailRules.length === 0
    ? 0
    : tailRules.reduce((s, r) => s + JSON.stringify(r).length + 1, 0);
  const effectiveCap = MAX_BYTES - tailByteBudget;
  if (effectiveCap < 1000) {
    throw new Error(`Tail rules consume too much budget (${tailByteBudget} bytes)`);
  }

  const shards: Shard[] = [];
  let current: ContentBlockingRule[] = [];
  let currentSize = 2; // brackets

  for (const rule of mainRules) {
    const ruleJson = JSON.stringify(rule);
    const addedSize = ruleJson.length + 1; // +1 for separating comma (slight overcount on first; safe)
    if (current.length > 0 && currentSize + addedSize > effectiveCap) {
      shards.push(finalize([...current, ...tailRules]));
      current = [];
      currentSize = 2;
    }
    current.push(rule);
    currentSize += addedSize;
  }
  if (current.length > 0) {
    shards.push(finalize([...current, ...tailRules]));
  } else if (shards.length === 0 && tailRules.length > 0) {
    // No main rules at all but tail rules exist — ship one shard with just
    // the tail. Not expected for EasyList-family inputs; defensive.
    shards.push(finalize([...tailRules]));
  }
  return shards;
}

function finalize(rules: ContentBlockingRule[]): Shard {
  const json = JSON.stringify(rules);
  return { rules, json, byteSize: Buffer.byteLength(json, 'utf8') };
}
