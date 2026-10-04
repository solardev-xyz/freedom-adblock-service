import { FilterSet, type ContentBlockingRule, type FilterListMetadata } from 'adblock-rs';
import {
  applyCosmeticExceptions,
  splitCosmeticExceptions,
  type CosmeticExceptionStats,
} from './cosmetic-exceptions.ts';

export interface ConvertResult {
  /// Block / css-display-none / domain-scoped exception rules — sharded freely.
  mainRules: ContentBlockingRule[];
  /// Catch-all `ignore-previous-rules` safety rules adblock-rs auto-appends
  /// (e.g. "first-party document loads are never blocked"). WebKit's
  /// `ignore-previous-rules` action is per-list, so when we shard one logical
  /// blocker into multiple WKContentRuleLists, these have to be replicated
  /// at the end of every shard for the same guarantee to hold.
  tailRules: ContentBlockingRule[];
  listMeta: FilterListMetadata;
  inputRuleCount: number;
  /** How the list's `#@#` exceptions were applied (see cosmetic-exceptions.ts). */
  exceptionStats: CosmeticExceptionStats;
}

export function convert(text: string): ConvertResult {
  const lines = text.split(/\r?\n/);
  // For metadata only — adblock-rs handles comments itself. Counts non-blank,
  // non-comment, non-section-header lines as the source's "rule count".
  const inputRuleCount = lines.filter(line => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith('!') && !t.startsWith('[Adblock');
  }).length;

  // Cosmetic exceptions never reach adblock-rs: it would turn each into a
  // global hide (cosmetic-exceptions.ts). They're applied after conversion.
  const { text: withoutExceptions, exceptions, entityHidesDropped } = splitCosmeticExceptions(text);

  const fs = new FilterSet(true); // debug=true required for intoContentBlocking()
  const listMeta = fs.addFilters(withoutExceptions.split(/\r?\n/));
  const result = fs.intoContentBlocking();
  if (!result) {
    throw new Error('intoContentBlocking() returned undefined; FilterSet must be debug=true');
  }

  const converted = [...result.contentBlockingRules];
  const tailRules: ContentBlockingRule[] = [];
  while (converted.length > 0 && isCatchAllSafetyRule(converted[converted.length - 1]!)) {
    tailRules.unshift(converted.pop()!);
  }
  const { rules: mainRules, stats: exceptionStats } = applyCosmeticExceptions(converted, exceptions, entityHidesDropped);

  return { mainRules, tailRules, listMeta, inputRuleCount, exceptionStats };
}

/// A catch-all safety rule: `ignore-previous-rules` whose URL filter matches
/// everything (`.*`). Domain- or path-scoped `@@`-exceptions also compile to
/// `ignore-previous-rules` but with a specific `url-filter` — those are real
/// content rules and stay in `mainRules`.
function isCatchAllSafetyRule(rule: ContentBlockingRule): boolean {
  return rule.action.type === 'ignore-previous-rules' && rule.trigger['url-filter'] === '.*';
}
