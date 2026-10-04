import { domainToASCII } from 'node:url';
import { CosmeticFilter } from '@ghostery/adblocker';

// ---------------------------------------------------------------------------
// scriptlets.json — the iOS scriptlet index (`+js(...)` rules).
//
// Desktop runs uBlock Origin scriptlets through @ghostery/adblocker's engine.
// iOS (WKWebView) can't run a filter engine in the page, so it injects
// scriptlets per navigation from this flat, pre-parsed list instead. To keep
// the two in step, every rule is parsed by the same @ghostery release desktop
// pins (CosmeticFilter.parse / parseScript), and every rule @ghostery would
// reject is dropped here and counted. Hostnames are taken from the raw line,
// because @ghostery only keeps their hashes.
//
// Output is deterministic (list order, then line order; fixed key order; no
// timestamps), so the blob's sha256 — and its Swarm ref — only change when the
// rules do.
// ---------------------------------------------------------------------------

/** Bump on an incompatible change to the shape below. */
export const SCRIPTLETS_FORMAT = 1;

export type DropReason =
  /** `##+js(…)` with no positive hostname: @ghostery rejects generic injections. */
  | 'generic_injection'
  /** `/regex/##+js(…)`: no regex hostnames. */
  | 'regex_hostname'
  /** Names neither a scriptlet nor a JS surrogate in resources.json. */
  | 'unknown_scriptlet'
  /** `trusted-*` / requiresTrust injection outside the scriptlet authors' own list. */
  | 'trusted_outside_ublock'
  /** A hostname that isn't a valid (IDNA-convertible) hostname or entity. */
  | 'invalid_hostname'
  /** Anything else @ghostery's parser rejects (`#$#+js`, empty `##+js()`, …). */
  | 'unparseable'
  /** An exact repeat of an earlier rule from the same list. */
  | 'duplicate';

export const DROP_REASONS: readonly DropReason[] = [
  'generic_injection',
  'regex_hostname',
  'unknown_scriptlet',
  'trusted_outside_ublock',
  'invalid_hostname',
  'unparseable',
  'duplicate',
];

export type DropCounts = Record<DropReason, number>;

export const emptyDropCounts = (): DropCounts =>
  Object.fromEntries(DROP_REASONS.map((r) => [r, 0])) as DropCounts;

export interface ScriptletRule {
  list_id: string;
  /**
   * 'scriptlet': `scriptlet` is the canonical scriptlet name (aliases resolved,
   * `.js` stripped) and `args` are passed to it. 'surrogate': `scriptlet` is
   * the exact `redirects[].name` of a JS resource injected verbatim with no
   * args — desktop's getScriptlet() falls back to these.
   */
  kind: 'scriptlet' | 'surrogate';
  /** '' (with args []) only on the `#@#+js()` "disable all on this host" exception. */
  scriptlet: string;
  /** Unquoted/unescaped as @ghostery's parseScript returns them — NOT URI-decoded. */
  args: string[];
  /** Lowercase ASCII (punycode); entities like `google.*` kept as written. */
  domains: string[];
  exclude_domains: string[];
  /** Only on `host>>##+js(…)` rules: inject in frames with an ancestor on these hosts. */
  parent_domains?: string[];
  exception: boolean;
}

export interface ScriptletsDoc {
  format: number;
  resources: { tag: string; sha256: string };
  sources: Array<{ list_id: string; rule_count: number }>;
  rule_count: number;
  dropped: DropCounts;
  rules: ScriptletRule[];
}

// ── resources.json lookups ─────────────────────────────────────────────────

interface ResourcesJson {
  scriptlets: Array<{ name: string; aliases: string[]; requiresTrust?: boolean }>;
  redirects: Array<{ name: string; aliases: string[]; contentType: string }>;
}

export interface ResourceIndex {
  /** Canonical scriptlet name (e.g. "set-constant.js") for a name or alias. */
  scriptlet(name: string): string | undefined;
  /** Exact redirects[].name of the JS surrogate a name resolves to. */
  surrogate(name: string): string | undefined;
  /** Whether a raw `+js(name…)` token names a trust-requiring scriptlet. */
  requiresTrust(name: string): boolean;
}

/**
 * Lookups over resources.json that mirror @ghostery 2.18.2's Resources:
 * a name is looked up as-is if it ends in `.js`, else with `.js` appended;
 * `.fn` names are dependencies, never scriptlets; the surrogate fallback only
 * accepts `application/javascript` resources. The trusted-name set mirrors
 * desktop's trustedScriptletNames (service.js): names and aliases, with and
 * without their `.js`/`.fn` suffix.
 */
export function indexResources(json: string): ResourceIndex {
  const parsed = JSON.parse(json) as ResourcesJson;
  const key = (name: string) => (name.endsWith('.js') ? name : `${name}.js`);

  const scriptlets = new Map<string, string>();
  const trusted = new Set<string>();
  for (const s of parsed.scriptlets) {
    for (const n of [s.name, ...s.aliases]) {
      scriptlets.set(n, s.name);
      if (s.requiresTrust === true) {
        trusted.add(n);
        trusted.add(n.replace(/\.(js|fn)$/, ''));
      }
    }
  }
  const resources = new Map<string, ResourcesJson['redirects'][number]>();
  for (const r of parsed.redirects) {
    for (const n of [r.name, ...r.aliases]) resources.set(n, r);
  }

  return {
    scriptlet: (name) => (name.endsWith('.fn') ? undefined : scriptlets.get(key(name))),
    surrogate: (name) => {
      const r = resources.get(key(name));
      return r?.contentType === 'application/javascript' ? r.name : undefined;
    },
    requiresTrust: (name) => trusted.has(name),
  };
}

// ── rule extraction ────────────────────────────────────────────────────────

// A scriptlet rule: hostnames, `#` + optional `@`/`?`/`$` + `#`, then `+js(`.
// @ghostery itself splits on the first `#`, so hostnames never contain one.
const SCRIPTLET_LINE_RE = /^([^#]*)#([@?$]?)#\+js\(/;
// The raw first token desktop's stripTrustedScriptlets keys on.
const RAW_NAME_RE = /\+js\(\s*([^,)\s]+)/;

/**
 * Hostname or entity → lowercase ASCII (punycode), or null if invalid.
 * `google.*` keeps its `.*`; only the labels before it are converted.
 */
export function normalizeHostname(raw: string): string | null {
  const entity = raw.endsWith('.*');
  const base = entity ? raw.slice(0, -2) : raw;
  if (base.length === 0) return null;
  const ascii = domainToASCII(base);
  if (ascii === '') return null;
  return entity ? `${ascii}.*` : ascii;
}

/**
 * Every scriptlet rule in one list's text, in line order. `trusted` marks the
 * lists allowed to invoke trust-requiring scriptlets (desktop:
 * TRUSTED_SCRIPTLET_CATEGORIES = ublock). Rejected rules are tallied in
 * `dropped`.
 */
export function extractScriptletRules(
  listId: string,
  text: string,
  index: ResourceIndex,
  opts: { trusted: boolean },
  dropped: DropCounts,
): ScriptletRule[] {
  const rules: ScriptletRule[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('!') || line.startsWith('[')) continue;
    const m = SCRIPTLET_LINE_RE.exec(line);
    if (!m) continue;
    const [, hostsPart, marker] = m;
    const exception = marker === '@';

    // Desktop strips these from untrusted lists before the engine sees them,
    // keyed on the raw name token (exceptions are left alone).
    if (!exception && !opts.trusted) {
      const rawName = RAW_NAME_RE.exec(line)?.[1] ?? '';
      if (rawName.startsWith('trusted-') || index.requiresTrust(rawName)) {
        dropped.trusted_outside_ublock++;
        continue;
      }
    }

    const entries = hostsPart!.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
    if (entries.some((e) => e.replace(/^~/, '').startsWith('/'))) {
      dropped.regex_hostname++;
      continue;
    }

    const filter = CosmeticFilter.parse(line, true);
    if (filter === null || !filter.isScriptInject()) {
      const positive = entries.some((e) => !e.startsWith('~'));
      if (!exception && !positive) dropped.generic_injection++;
      else dropped.unparseable++;
      continue;
    }

    let kind: ScriptletRule['kind'] = 'scriptlet';
    let scriptlet = '';
    let args: string[] = [];
    const parsed = filter.parseScript(); // undefined for the empty `+js()`
    if (parsed !== undefined) {
      const canonical = index.scriptlet(parsed.name);
      const surrogate = canonical === undefined ? index.surrogate(parsed.name) : undefined;
      if (canonical !== undefined) {
        scriptlet = canonical.replace(/\.js$/, '');
        args = parsed.args;
      } else if (surrogate !== undefined) {
        kind = 'surrogate';
        scriptlet = surrogate;
      } else {
        dropped.unknown_scriptlet++;
        continue;
      }
    }

    const domains: string[] = [];
    const excludeDomains: string[] = [];
    const parentDomains: string[] = [];
    let valid = true;
    for (let entry of entries) {
      const parent = entry.endsWith('>>');
      if (parent) entry = entry.slice(0, -2);
      const negated = entry.startsWith('~');
      if (negated) entry = entry.slice(1);
      const host = normalizeHostname(entry);
      if (host === null || (parent && negated)) {
        valid = false;
        break;
      }
      (parent ? parentDomains : negated ? excludeDomains : domains).push(host);
    }
    if (!valid) {
      dropped.invalid_hostname++;
      continue;
    }

    const rule: ScriptletRule = {
      list_id: listId,
      kind,
      scriptlet,
      args,
      domains,
      exclude_domains: excludeDomains,
      ...(parentDomains.length > 0 ? { parent_domains: parentDomains } : {}),
      exception,
    };
    const id = JSON.stringify(rule);
    if (seen.has(id)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(id);
    rules.push(rule);
  }
  return rules;
}

/**
 * The scriptlets.json bytes: compact JSON with one rule per line (readable
 * diffs, still a single JSON document), newline-terminated.
 */
export function serializeScriptletsDoc(doc: ScriptletsDoc): string {
  const { rules, ...head } = doc;
  const headJson = JSON.stringify(head);
  const body = rules.map((r) => JSON.stringify(r)).join(',\n');
  return `${headJson.slice(0, -1)},"rules":[\n${body}\n]}\n`;
}
