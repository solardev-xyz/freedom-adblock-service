import { FilterSet, type ContentBlockingRule, type FilterListMetadata } from 'adblock-rs';

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
}

export function convert(text: string): ConvertResult {
  const lines = text.split(/\r?\n/);
  // For metadata only — adblock-rs handles comments itself. Counts non-blank,
  // non-comment, non-section-header lines as the source's "rule count".
  const inputRuleCount = lines.filter(line => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith('!') && !t.startsWith('[Adblock');
  }).length;

  const fs = new FilterSet(true); // debug=true required for intoContentBlocking()
  const listMeta = fs.addFilters(lines);
  const result = fs.intoContentBlocking();
  if (!result) {
    throw new Error('intoContentBlocking() returned undefined; FilterSet must be debug=true');
  }

  const mainRules = [...result.contentBlockingRules];
  const tailRules: ContentBlockingRule[] = [];
  while (mainRules.length > 0 && isCatchAllSafetyRule(mainRules[mainRules.length - 1]!)) {
    tailRules.unshift(mainRules.pop()!);
  }

  return { mainRules, tailRules, listMeta, inputRuleCount };
}

/// A catch-all safety rule: `ignore-previous-rules` whose URL filter matches
/// everything (`.*`). Domain- or path-scoped `@@`-exceptions also compile to
/// `ignore-previous-rules` but with a specific `url-filter` — those are real
/// content rules and stay in `mainRules`.
function isCatchAllSafetyRule(rule: ContentBlockingRule): boolean {
  return rule.action.type === 'ignore-previous-rules' && rule.trigger['url-filter'] === '.*';
}
