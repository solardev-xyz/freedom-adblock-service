import { test } from 'node:test';
import assert from 'node:assert/strict';

import { convert } from '../src/convert.ts';

// End-to-end through adblock-rs: list text in, WebKit rules out.
const hides = (text: string) =>
  convert(text).mainRules
    .filter((r) => r.action.type === 'css-display-none')
    .map((r) => ({ selector: r.action.selector, ...r.trigger }));

test('an exception with no hide of its own becomes nothing — not a global hide', () => {
  // The YouTube regression: uAssets' `pudelek.pl#@#style + div[class]`.
  assert.deepEqual(hides('pudelek.pl#@#style + div[class]'), []);
  const { exceptionStats } = convert('pudelek.pl#@#style + div[class]');
  assert.equal(exceptionStats.unmatched, 1);
});

test('an exception excepts the generic hide it targets, subdomains included', () => {
  assert.deepEqual(hides('##.ad\nweb.de,bild.de#@#.ad'), [
    { selector: '.ad', 'url-filter': '.*', 'unless-domain': ['*bild.de', '*web.de'] },
  ]);
});

test('a genuine ~host##selector rule is untouched, and exceptions add to it', () => {
  assert.deepEqual(hides('~example.com##.ad'), [
    { selector: '.ad', 'url-filter': '.*', 'unless-domain': ['*example.com'] },
  ]);
  assert.deepEqual(hides('~example.com##.ad\nother.org#@#.ad'), [
    { selector: '.ad', 'url-filter': '.*', 'unless-domain': ['*example.com', '*other.org'] },
  ]);
});

test('a generic #@#selector drops every hide of that selector', () => {
  assert.deepEqual(hides('##.ad\nsite.com##.ad\n##.keep\n#@#.ad'), [
    { selector: '.keep', 'url-filter': '.*' },
  ]);
});

test('an exception removes its host from a domain hide, dropping it when none remain', () => {
  assert.deepEqual(hides('a.com,b.com##.ad\nc.com##.ad\na.com,c.com#@#.ad'), [
    { selector: '.ad', 'url-filter': '.*', 'if-domain': ['*b.com'] },
  ]);
  const { exceptionStats } = convert('a.com,b.com##.ad\nc.com##.ad\na.com,c.com#@#.ad');
  assert.equal(exceptionStats.domain_rules_narrowed, 1);
  assert.equal(exceptionStats.rules_dropped, 1);
});

test('an exception WebKit cannot express drops the generic hide (safe direction)', () => {
  assert.deepEqual(hides('##.ad\n##.keep\ngoogle.*#@#.ad'), [{ selector: '.keep', 'url-filter': '.*' }]);
  const { exceptionStats } = convert('##.ad\ngoogle.*#@#.ad');
  assert.equal(exceptionStats.unexpressible, 1);
});

test('scriptlet exceptions, comments and network rules are left alone', () => {
  const { mainRules, exceptionStats } = convert(
    ['! a.com#@#.ad', 'a.com#@#+js(set-constant, x, y)', '||ads.example^', '##.ad'].join('\n'),
  );
  assert.equal(exceptionStats.exceptions, 0);
  assert.deepEqual(mainRules.map((r) => r.action.type).sort(), ['block', 'css-display-none']);
});

test('a hide with only entity positives plus a negation is dropped, not made global', () => {
  // adblock-rs alone: "hide every .info link on every site but oxy.edu".
  assert.deepEqual(hides('oxy.*,~oxy.edu##[href*=".info"]\n##.keep'), [{ selector: '.keep', 'url-filter': '.*' }]);
  assert.equal(convert('oxy.*,~oxy.edu##[href*=".info"]').exceptionStats.entity_hides_dropped, 1);
  // Entities next to a plain positive host keep the plain host (as before).
  assert.deepEqual(hides('foo.*,bar.com##.x'), [{ selector: '.x', 'url-filter': '.*', 'if-domain': ['*bar.com'] }]);
});

test('cosmetic hostnames cover subdomains, as in uBlock — except under a subdomain exception', () => {
  assert.deepEqual(hides('bild.de,web.de##.ad'), [
    { selector: '.ad', 'url-filter': '.*', 'if-domain': ['*bild.de', '*web.de'] },
  ]);
  // Entries adblock-rs already starred (uBlock's rare `*.host` form) pass through.
  assert.deepEqual(hides('*.already.org##.ad')[0]!['if-domain'], ['*.already.org']);
  // `sub.a.com#@#.ad` can't be carved out of "*a.com": keep a.com exact.
  assert.deepEqual(hides('a.com,b.com##.ad\nsub.a.com#@#.ad'), [
    { selector: '.ad', 'url-filter': '.*', 'if-domain': ['*b.com', 'a.com'] },
  ]);
  const { exceptionStats } = convert('a.com,b.com##.ad\nsub.a.com#@#.ad');
  assert.equal(exceptionStats.domains_kept_exact, 1);
  assert.equal(exceptionStats.domains_prefixed, 1);
  // Network rules are adblock-rs's own and already carry `*`.
  const net = convert('||ads.example^$domain=a.com').mainRules[0]!;
  assert.deepEqual(net.trigger['if-domain'], ['*a.com']);
});

test('identical input converts to identical bytes (trigger arrays sorted)', () => {
  const text = '||ads.example^$image,script,font,media\n||x.example^$domain=c.com|a.com|b.com\nc.com,a.com,b.com##.ad';
  const runs = Array.from({ length: 5 }, () => JSON.stringify(convert(text).mainRules));
  assert.equal(new Set(runs).size, 1);
  const rules = convert(text).mainRules;
  assert.deepEqual(rules[0]!.trigger['resource-type'], [...rules[0]!.trigger['resource-type']!].sort());
});
