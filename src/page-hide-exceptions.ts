import type { ContentBlockingRule } from 'adblock-rs';
import { normalizeHostname } from './scriptlets.ts';

// Page-level cosmetic exceptions — `@@||site^$generichide` (`$ghide`),
// `$elemhide` (`$ehide`), `$specifichide` (`$shide`) — for the WebKit
// conversion. adblock-rs drops them, so iOS kept hiding on the ~1,050 sites
// where uBlock deliberately switches hiding off (often because it breaks the
// page or trips anti-adblock).
//
// They are page switches, not per-selector rules, and desktop's engine merges
// every list, so a `$ghide` in the uBlock list also stops EasyList's generic
// hides. The build therefore unions them across lists and applies the union to
// every list:
//   - generic (generichide, elemhide): each list's generic hides go in their
//     own shard(s), which end with `ignore-previous-rules` on those sites —
//     ignore-previous-rules is per WKContentRuleList, so it cancels only them
//   - specific (specifichide, elemhide): the sites are removed from domain
//     hides' if-domain at build time (cosmetic-exceptions.ts)
// With a list enabled whose excepting list is off, this only under-hides.
//
// Supported forms: `@@||host^$ghide`, `@@||host$ghide`, `@@*$ghide,domain=a|b`
// (and the empty pattern), plus `badfilter` cancelling one of those. Anything
// else (paths, IP prefixes, type/party options, `to=`, entities) is skipped
// and counted — skipping keeps the previous behaviour.

export interface PageHideExceptions {
  /** Sites (and their subdomains) where generic hides must not apply. */
  generic: string[];
  /** Sites (and their subdomains) where domain-specific hides must not apply. */
  specific: string[];
}

export interface PageHideStats {
  generic: number;
  specific: number;
  badfiltered: number;
  unsupported: number;
}

const GENERIC = new Set(['generichide', 'ghide']);
const SPECIFIC = new Set(['specifichide', 'shide']);
// `$document` whitelists the whole page, cosmetics included.
const BOTH = new Set(['elemhide', 'ehide', 'document', 'doc']);
const HOST_PATTERN = /^\|\|([a-z0-9.-]+)\^?$/i;

interface Parsed {
  kinds: Array<'generic' | 'specific'>;
  sites: string[];
  badfilter: boolean;
}

function parseLine(line: string): Parsed | 'unsupported' | null {
  if (!line.startsWith('@@')) return null;
  const dollar = line.lastIndexOf('$');
  if (dollar < 0) return null;
  const options = line.slice(dollar + 1).split(',').map((o) => o.trim().toLowerCase());
  const kinds = new Set<'generic' | 'specific'>();
  let domains: string[] | undefined;
  let badfilter = false;
  let other = false;
  for (const o of options) {
    if (GENERIC.has(o)) kinds.add('generic');
    else if (SPECIFIC.has(o)) kinds.add('specific');
    else if (BOTH.has(o)) kinds.add('generic').add('specific');
    else if (o === 'badfilter') badfilter = true;
    else if (o.startsWith('domain=')) domains = o.slice(7).split('|');
    else other = true;
  }
  if (kinds.size === 0) return null;
  if (other) return 'unsupported';

  const pattern = line.slice(2, dollar);
  let raw: string[];
  const host = HOST_PATTERN.exec(pattern);
  if (host && domains === undefined) raw = [host[1]!];
  else if ((pattern === '' || pattern === '*') && domains !== undefined) raw = domains;
  else return 'unsupported';

  const sites: string[] = [];
  for (const d of raw) {
    // Negations, entities (`gmx.*`) and partial hosts (`asd.`) can't be expressed.
    const site = d.startsWith('~') || d.endsWith('.*') || d.endsWith('.') ? null : normalizeHostname(d);
    if (site === null || !site.includes('.')) return 'unsupported';
    sites.push(site);
  }
  return { kinds: [...kinds], sites, badfilter };
}

/** Page-level hide exceptions from one list's text. */
export function collectPageHideExceptions(text: string): { exceptions: PageHideExceptions; stats: PageHideStats } {
  const add = { generic: new Set<string>(), specific: new Set<string>() };
  const cancel = { generic: new Set<string>(), specific: new Set<string>() };
  const stats: PageHideStats = { generic: 0, specific: 0, badfiltered: 0, unsupported: 0 };
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line.trim());
    if (parsed === null) continue;
    if (parsed === 'unsupported') {
      stats.unsupported++;
      continue;
    }
    for (const kind of parsed.kinds) {
      for (const site of parsed.sites) (parsed.badfilter ? cancel : add)[kind].add(site);
    }
  }
  const result = (kind: 'generic' | 'specific') => {
    const sites = [...add[kind]].filter((s) => !cancel[kind].has(s)).sort();
    stats.badfiltered += add[kind].size - sites.length;
    return sites;
  };
  const exceptions = { generic: result('generic'), specific: result('specific') };
  stats.generic = exceptions.generic.length;
  stats.specific = exceptions.specific.length;
  return { exceptions, stats };
}

/** Union several lists' exceptions (sorted, deduplicated). */
export function mergePageHideExceptions(all: PageHideExceptions[]): PageHideExceptions {
  const union = (k: keyof PageHideExceptions) => [...new Set(all.flatMap((e) => e[k]))].sort();
  return { generic: union('generic'), specific: union('specific') };
}

/** Sites per ignore-previous-rules rule: keeps each trigger a modest size. */
const SITES_PER_RULE = 200;

/**
 * The rules that end each generic-hide shard: `ignore-previous-rules` on the
 * generichide sites, cancelling the shard's generic hides there.
 */
export function genericHideIgnoreRules(sites: string[]): ContentBlockingRule[] {
  const rules: ContentBlockingRule[] = [];
  for (let i = 0; i < sites.length; i += SITES_PER_RULE) {
    rules.push({
      action: { type: 'ignore-previous-rules' },
      trigger: { 'url-filter': '.*', 'if-domain': sites.slice(i, i + SITES_PER_RULE).map((s) => `*${s}`) },
    });
  }
  return rules;
}

/** A generic hide: css-display-none with no if-domain (unless-domain allowed). */
export const isGenericHide = (rule: ContentBlockingRule): boolean =>
  rule.action.type === 'css-display-none' && rule.trigger['if-domain'] === undefined;
