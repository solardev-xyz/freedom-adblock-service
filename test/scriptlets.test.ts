import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyDropCounts,
  extractScriptletRules,
  indexResources,
  normalizeHostname,
  serializeScriptletsDoc,
  type ScriptletRule,
} from '../src/scriptlets.ts';
import { resolveUblockText } from '../src/ublock.ts';

// A tiny resources.json in @ghostery's shape: one plain scriptlet with
// aliases, one trust-requiring one, a `.fn` dependency, and redirects (one JS
// surrogate, one non-JS resource).
const RESOURCES = JSON.stringify({
  scriptlets: [
    { name: 'set-constant.js', aliases: ['set.js', 'set'], body: 'function(){}', dependencies: [] },
    { name: 'trusted-set-constant.js', aliases: ['trusted-set.js'], body: 'function(){}', dependencies: [], requiresTrust: true },
    { name: 'safe-self.fn', aliases: [], body: 'function(){}', dependencies: [] },
  ],
  redirects: [
    { name: 'noeval.js', aliases: ['silent-noeval.js'], contentType: 'application/javascript', body: '(function(){})()' },
    { name: '1x1.gif', aliases: ['1x1-transparent.gif'], contentType: 'image/gif;base64', body: 'R0lGOD' },
  ],
});
const index = indexResources(RESOURCES);

function extract(text: string, opts: { trusted?: boolean; listId?: string } = {}) {
  const dropped = emptyDropCounts();
  const rules = extractScriptletRules(opts.listId ?? 'easylist', text, index, { trusted: opts.trusted ?? false }, dropped);
  return { rules, dropped };
}

const only = (text: string, opts = {}): ScriptletRule => {
  const { rules } = extract(text, opts);
  assert.equal(rules.length, 1, `expected one rule from ${text}`);
  return rules[0]!;
};

test('a hostname rule resolves aliases and strips .js', () => {
  assert.deepEqual(only('example.com,~sub.example.com##+js(set, foo.bar, true)'), {
    list_id: 'easylist',
    kind: 'scriptlet',
    scriptlet: 'set-constant',
    args: ['foo.bar', 'true'],
    domains: ['example.com'],
    exclude_domains: ['sub.example.com'],
    exception: false,
  });
});

test('args are unquoted and unescaped as @ghostery parses them, not URI-decoded', () => {
  const rule = only(String.raw`example.com##+js(set, 'a, b', "it\"s", x\,y, %20)`);
  assert.deepEqual(rule.args, ['a, b', 'it"s', 'x,y', '%20']);
});

test('entities stay as written; hostnames are lowercased and punycoded', () => {
  const rule = only('Google.*,BÜCHER.de##+js(set, a, b)');
  assert.deepEqual(rule.domains, ['google.*', 'xn--bcher-kva.de']);
  assert.equal(normalizeHostname('münchen.*'), 'xn--mnchen-3ya.*');
  assert.equal(normalizeHostname(''), null);
});

test('exceptions, including the empty "disable all" form, are kept', () => {
  const { rules } = extract('example.com#@#+js(set, a, b)\nexample.com#@#+js()\n#@#+js(set, x)');
  assert.deepEqual(
    rules.map((r) => [r.scriptlet, r.args, r.domains, r.exception]),
    [
      ['set-constant', ['a', 'b'], ['example.com'], true],
      ['', [], ['example.com'], true],
      ['set-constant', ['x'], [], true], // a generic exception is valid
    ],
  );
});

test('generic injections are dropped, as @ghostery rejects them', () => {
  const { rules, dropped } = extract('##+js(set, a, b)\n~example.com##+js(set, a, b)');
  assert.equal(rules.length, 0);
  assert.equal(dropped.generic_injection, 2, 'negation-only counts as generic too');
});

test('subframe rules carry parent_domains; others never do', () => {
  const rule = only('yesmovies.*>>,~vvid30c.*##+js(set, a, b)');
  assert.deepEqual(rule.parent_domains, ['yesmovies.*']);
  assert.deepEqual(rule.domains, []);
  assert.deepEqual(rule.exclude_domains, ['vvid30c.*']);
  assert.equal('parent_domains' in only('example.com##+js(set, a, b)'), false);
});

test('JS surrogates become kind:"surrogate" with the exact resource name and no args', () => {
  assert.deepEqual(
    [only('example.com##+js(noeval)'), only('example.com##+js(silent-noeval.js)')].map((r) => [r.kind, r.scriptlet, r.args]),
    [['surrogate', 'noeval.js', []], ['surrogate', 'noeval.js', []]],
  );
});

test('unknown names, .fn dependencies and non-JS resources are dropped as unknown', () => {
  const { rules, dropped } = extract(
    'example.com##+js(no-such-thing)\nexample.com##+js(safe-self.fn)\nexample.com##+js(1x1.gif)',
  );
  assert.equal(rules.length, 0);
  assert.equal(dropped.unknown_scriptlet, 3);
});

test('trusted scriptlets run only from trusted lists; their exceptions are kept everywhere', () => {
  const text = 'a.com##+js(trusted-set, x, y)\na.com##+js(trusted-anything-new, x)\na.com#@#+js(trusted-set, x, y)';
  const untrusted = extract(text);
  assert.equal(untrusted.dropped.trusted_outside_ublock, 2, 'by alias and by trusted-* prefix');
  assert.deepEqual(untrusted.rules.map((r) => r.exception), [true]);

  const trusted = extract(text, { trusted: true, listId: 'ublock' });
  assert.deepEqual(trusted.rules.map((r) => r.scriptlet), ['trusted-set-constant', 'trusted-set-constant']);
  assert.equal(trusted.dropped.unknown_scriptlet, 1, 'a trusted name resources.json lacks is still unknown');
});

test('regex hostnames, unparseable forms and comments are dropped or skipped', () => {
  const { rules, dropped } = extract(
    [
      '/^https?:\\/\\/x\\./##+js(set, a, b)',
      'example.com#$#+js(set, a, b)', // AdGuard-style — @ghostery rejects it
      'example.com##+js()', // empty injection without #@#
      '! example.com##+js(set, a, b)',
      'example.com##.ad', // not a scriptlet rule at all
    ].join('\n'),
  );
  assert.equal(rules.length, 0);
  assert.equal(dropped.regex_hostname, 1);
  assert.equal(dropped.unparseable, 2);
});

test('exact repeats within a list are dropped; output is deterministic', () => {
  const text = 'a.com##+js(set, x, 1)\nb.com##+js(set, y, 2)\na.com##+js(set, x, 1)';
  const first = extract(text);
  assert.equal(first.rules.length, 2);
  assert.equal(first.dropped.duplicate, 1);

  const doc = (rules: ScriptletRule[]) =>
    serializeScriptletsDoc({
      format: 1,
      resources: { tag: 't', sha256: 's' },
      sources: [{ list_id: 'easylist', rule_count: rules.length }],
      rule_count: rules.length,
      dropped: emptyDropCounts(),
      rules,
    });
  const bytes = doc(first.rules);
  assert.equal(bytes, doc(extract(text).rules), 'same input, same bytes');
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.rules.length, 2);
  assert.deepEqual(Object.keys(parsed), ['format', 'resources', 'sources', 'rule_count', 'dropped', 'rules']);
  assert.ok(bytes.endsWith(']}\n'));
  assert.deepEqual(JSON.parse(doc([])).rules, [], 'an empty rule list is still valid JSON');
});

test('uBlock preprocessing evaluates !#if against the env and splices same-dir includes', async () => {
  const env = new Map([['env_safari', true], ['env_mobile', true], ['ext_ublock', true]]);
  const files: Record<string, string> = {
    'https://x.test/filters/part.txt': 'part.com##+js(set, a, b)',
  };
  const text = [
    '! Title: uBlock filters',
    '!#if env_safari',
    'safari.com##+js(set, a, b)',
    '!#else',
    'other.com##+js(set, a, b)',
    '!#endif',
    '!#if env_chromium',
    'chromium.com##+js(set, a, b)',
    '!#endif',
    '!#if !cap_html_filtering',
    'nohtml.com##+js(set, a, b)',
    '!#endif',
    '!#include part.txt',
  ].join('\n');
  const out = await resolveUblockText(text, 'https://x.test/filters/filters.txt', env, async (u) => files[u]!);
  assert.deepEqual(
    extract(out, { trusted: true }).rules.flatMap((r) => r.domains),
    ['safari.com', 'nohtml.com', 'part.com'],
  );
  await assert.rejects(
    resolveUblockText('!#include ../evil.txt', 'https://x.test/filters/filters.txt', env, async () => ''),
    /out-of-tree/,
  );
});
