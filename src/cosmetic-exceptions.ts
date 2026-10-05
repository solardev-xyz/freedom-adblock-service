import type { ContentBlockingRule } from 'adblock-rs';
import { normalizeHostname } from './scriptlets.ts';

// Cosmetic exceptions (`host#@#selector`) for the WebKit conversion.
//
// adblock-rs's content-blocking conversion turns an exception into a HIDE rule
// with the exception's hostnames as `unless-domain` (content_blocking.rs,
// `TryFrom<CosmeticFilter> for CbRule`) and never pairs it with the hide it
// excepts. So `pudelek.pl#@#style + div[class]` — with no generic
// `##style + div[class]` anywhere — became "hide every div after a <style>, on
// every site but pudelek.pl", which blanked the YouTube player. With a
// matching generic rule both survive and the exception does nothing; a generic
// `#@#selector` is dropped and the hide stays global.
//
// The converted shape is indistinguishable from a genuine `~host##selector`,
// so exceptions never reach adblock-rs: they are split off the list text
// before conversion and applied here, within the same list, to the rules it
// produced:
//   - generic hide (no if-domain): the exception's hosts join its
//     unless-domain (as `*host`, which covers subdomains like uBlock does)
//   - domain hide (if-domain): an excepted host is removed from if-domain;
//     the rule is dropped if none remain
//   - `#@#selector` with no hosts: every hide of that selector is dropped
//   - an exception WebKit can't express (entity `site.*`, `~host`, regex)
//     drops the generic hide it targets — over-hiding is what breaks sites,
//     so dropping is the safe direction
//   - an exception with nothing to except in its own list is dropped
//     (cross-list exceptions can't be expressed per WKContentRuleList)
//
// Finally, hostnames get WebKit's `*` prefix. adblock-rs writes cosmetic
// if-/unless-domain entries bare, which WebKit matches against the exact host
// only — `bild.de##.ad` never reached www.bild.de — while uBlock and desktop
// apply a hostname to its subdomains too. One case keeps the bare host: a
// domain hide with an exception on one of its subdomains (`a.com##sel` +
// `sub.a.com#@#sel`), which a single WebKit trigger can't express; the hide
// then stays on a.com itself rather than spreading to the excepted subdomain.
//
// The same pass removes a second shape adblock-rs gets wrong: a HIDE whose
// only positive locations are entities, plus negations —
// `oxy.*,~oxy.edu##[href*=".info"]`. adblock-rs drops the entities it can't
// express and keeps the negation, i.e. "hide every .info link on every site
// but oxy.edu". WebKit can't express entities, so the rule is dropped.

export interface CosmeticException {
  /** Plain hostnames, normalized (lowercase ASCII). */
  hosts: string[];
  /** Has a location WebKit can't express: entity, negation or regex. */
  unexpressible: boolean;
  selector: string;
}

export interface CosmeticExceptionStats {
  /** `#@#` lines split off before conversion (cosmetic, not scriptlet). */
  exceptions: number;
  /** Generic hides that gained unless-domain entries. */
  generic_rules_excepted: number;
  /** Domain hides that lost if-domain entries (kept). */
  domain_rules_narrowed: number;
  /** Hides dropped: generic `#@#sel`, unexpressible exceptions, emptied if-domain. */
  rules_dropped: number;
  /** Exceptions with no hide of their selector in the same list. */
  unmatched: number;
  /** Exceptions with an entity / negated / regex location. */
  unexpressible: number;
  /** Hides with only entity positives plus negations, dropped before conversion. */
  entity_hides_dropped: number;
  /** if-/unless-domain entries given the `*` (subdomains too) prefix. */
  domains_prefixed: number;
  /** Bare if-domain entries kept exact because a subdomain of them is excepted. */
  domains_kept_exact: number;
  /** Domain hides that lost if-domain entries to `$specifichide`/`$elemhide` sites. */
  page_specific_narrowed: number;
  /** Domain hides dropped because every if-domain entry was such a site. */
  page_specific_dropped: number;
}

// hostnames, `#@`, optional procedural/style marker, `#`, body.
const EXCEPTION_RE = /^([^#]*)#@[?$%]?#(.*)$/;
// A cosmetic hide's hostnames (any `##` / `#?#` / `#$#` flavour).
const HIDE_RE = /^([^#]*)#[?$%]?#/;

/** `foo.*,~foo.com##…`: entity positives only, plus a negation. */
function isEntityNegationHide(line: string): boolean {
  const m = HIDE_RE.exec(line);
  if (!m || m[1]!.length === 0) return false;
  const entries = m[1]!.split(',').map((e) => e.trim()).filter(Boolean);
  const positive = entries.filter((e) => !e.startsWith('~'));
  return positive.length > 0 && positive.every((e) => e.endsWith('.*')) && positive.length < entries.length;
}

/**
 * Split cosmetic exceptions off a list's text. Scriptlet exceptions
 * (`#@#+js(...)`) are removed too — adblock-rs never converts scriptlets —
 * but not collected; HTML filters (`^…`) likewise.
 */
export function splitCosmeticExceptions(
  text: string,
): { text: string; exceptions: CosmeticException[]; entityHidesDropped: number } {
  const kept: string[] = [];
  const exceptions: CosmeticException[] = [];
  let entityHidesDropped = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const comment = t.startsWith('!') || t.startsWith('[');
    const m = comment ? null : EXCEPTION_RE.exec(t);
    if (!m) {
      if (!comment && isEntityNegationHide(t)) entityHidesDropped++;
      else kept.push(line);
      continue;
    }
    const [, hostsPart, body] = m;
    const selector = body!.trim();
    if (selector.length === 0 || selector.startsWith('+js(') || selector.startsWith('^')) continue;
    const hosts: string[] = [];
    let unexpressible = false;
    for (const entry of hostsPart!.split(',').map((e) => e.trim()).filter(Boolean)) {
      const host = entry.startsWith('~') || entry.startsWith('/') || entry.endsWith('.*') ? null : normalizeHostname(entry);
      if (host === null) unexpressible = true;
      else hosts.push(host);
    }
    exceptions.push({ hosts, unexpressible, selector });
  }
  return { text: kept.join('\n'), exceptions, entityHidesDropped };
}

const isHide = (r: ContentBlockingRule) => r.action.type === 'css-display-none';

/** Apply one list's exceptions to the rules converted from that same list. */
export function applyCosmeticExceptions(
  rules: ContentBlockingRule[],
  exceptions: CosmeticException[],
  entityHidesDropped = 0,
  /** `$specifichide` / `$elemhide` sites (page-hide-exceptions.ts), all lists. */
  specificHideSites: string[] = [],
): { rules: ContentBlockingRule[]; stats: CosmeticExceptionStats } {
  const stats: CosmeticExceptionStats = {
    entity_hides_dropped: entityHidesDropped,
    exceptions: exceptions.length,
    generic_rules_excepted: 0,
    domain_rules_narrowed: 0,
    rules_dropped: 0,
    unmatched: 0,
    unexpressible: 0,
    domains_prefixed: 0,
    domains_kept_exact: 0,
    page_specific_narrowed: 0,
    page_specific_dropped: 0,
  };
  const bySelector = new Map<string, ContentBlockingRule[]>();
  for (const rule of rules) {
    if (!isHide(rule) || rule.action.selector === undefined) continue;
    const list = bySelector.get(rule.action.selector) ?? [];
    list.push(rule);
    bySelector.set(rule.action.selector, list);
  }

  const dropped = new Set<ContentBlockingRule>();
  const excepted = new Set<ContentBlockingRule>();
  const narrowed = new Set<ContentBlockingRule>();
  // Domain hides' bare if-domain entries that an exception's subdomain sits under.
  const keepExact = new Map<ContentBlockingRule, Set<string>>();
  for (const ex of exceptions) {
    if (ex.unexpressible) stats.unexpressible++;
    const targets = (bySelector.get(ex.selector) ?? []).filter((r) => !dropped.has(r));
    if (targets.length === 0) {
      stats.unmatched++;
      continue;
    }
    for (const rule of targets) {
      const ifDomain = rule.trigger['if-domain'];
      if (ex.hosts.length === 0 && !ex.unexpressible) {
        dropped.add(rule); // generic `#@#selector`: never hide it
      } else if (ifDomain === undefined) {
        if (ex.unexpressible) {
          dropped.add(rule);
          continue;
        }
        const unless = new Set(rule.trigger['unless-domain'] ?? []);
        for (const h of ex.hosts) unless.add(`*${h}`);
        rule.trigger['unless-domain'] = [...unless];
        excepted.add(rule);
      } else {
        const remaining = ifDomain.filter((d) => !ex.hosts.includes(d.replace(/^\*/, '')));
        for (const d of remaining) {
          const base = d.replace(/^\*/, '');
          if (ex.hosts.some((h) => h.endsWith(`.${base}`))) {
            const set = keepExact.get(rule) ?? new Set<string>();
            set.add(d);
            keepExact.set(rule, set);
          }
        }
        if (remaining.length === ifDomain.length) continue;
        if (remaining.length === 0) dropped.add(rule);
        else {
          rule.trigger['if-domain'] = remaining;
          narrowed.add(rule);
        }
      }
    }
  }

  // `$specifichide` / `$elemhide`: a site (and its subdomains) gets no domain
  // hides. An entry the site covers is removed; an entry the site sits under
  // (`*a.com` vs `sub.a.com`) can't be carved out, so it stays exact.
  if (specificHideSites.length > 0) {
    const covers = (site: string, host: string) => host === site || host.endsWith(`.${site}`);
    for (const rule of rules) {
      const ifDomain = rule.trigger['if-domain'];
      if (!isHide(rule) || dropped.has(rule) || ifDomain === undefined) continue;
      const remaining = ifDomain.filter((d) => !specificHideSites.some((s) => covers(s, d.replace(/^\*/, ''))));
      for (const d of remaining) {
        const base = d.replace(/^\*/, '');
        if (specificHideSites.some((s) => s.endsWith(`.${base}`))) {
          const set = keepExact.get(rule) ?? new Set<string>();
          set.add(d);
          keepExact.set(rule, set);
        }
      }
      if (remaining.length === ifDomain.length) continue;
      if (remaining.length === 0) {
        dropped.add(rule);
        stats.page_specific_dropped++;
      } else {
        rule.trigger['if-domain'] = remaining;
        stats.page_specific_narrowed++;
      }
    }
  }

  const kept = rules.filter((r) => !dropped.has(r));
  const prefix = (entries: string[], exact?: Set<string>) => {
    const out = new Set<string>();
    for (const d of entries) {
      if (d.startsWith('*')) out.add(d);
      else if (exact?.has(d)) {
        out.add(d);
        stats.domains_kept_exact++;
      } else {
        out.add(`*${d}`);
        stats.domains_prefixed++;
      }
    }
    return [...out];
  };
  for (const rule of kept) {
    if (!isHide(rule)) continue;
    const t = rule.trigger;
    if (t['if-domain']) t['if-domain'] = prefix(t['if-domain'], keepExact.get(rule));
    if (t['unless-domain']) t['unless-domain'] = prefix(t['unless-domain']);
  }

  stats.rules_dropped = dropped.size - stats.page_specific_dropped;
  stats.generic_rules_excepted = [...excepted].filter((r) => !dropped.has(r)).length;
  stats.domain_rules_narrowed = [...narrowed].filter((r) => !dropped.has(r)).length;
  return { rules: kept, stats };
}
