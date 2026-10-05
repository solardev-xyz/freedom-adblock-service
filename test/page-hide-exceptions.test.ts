import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectPageHideExceptions,
  genericHideIgnoreRules,
  isGenericHide,
  mergePageHideExceptions,
} from '../src/page-hide-exceptions.ts';
import { convert } from '../src/convert.ts';

test('collects $generichide / $elemhide / $specifichide / $document sites by kind', () => {
  const { exceptions, stats } = collectPageHideExceptions(
    [
      '@@||tvtoday.de^$ghide',
      '@@||jetzt.de^$generichide',
      '@@||Example.ORG$ehide', // no ^, mixed case
      '@@||only-specific.com^$shide',
      '@@||whitelisted.net^$document',
      '@@*$ghide,domain=web.de|t-online.de',
      '@@$generichide,domain=a.com|b.com',
      '||ads.example^$generichide', // not an exception
      '@@||ads.example^', // no page-level option
    ].join('\n'),
  );
  assert.deepEqual(exceptions.generic, [
    'a.com', 'b.com', 'example.org', 'jetzt.de', 't-online.de', 'tvtoday.de', 'web.de', 'whitelisted.net',
  ]);
  assert.deepEqual(exceptions.specific, ['example.org', 'only-specific.com', 'whitelisted.net']);
  assert.equal(stats.unsupported, 0);
});

test('badfilter cancels its twin; unsupported forms are skipped and counted', () => {
  const { exceptions, stats } = collectPageHideExceptions(
    [
      '@@||seznamzpravy.cz^$ghide',
      '@@||seznamzpravy.cz^$ghide,badfilter',
      '@@||googleapiscdn.com/player/*x.$ghide', // path
      '@@://10.0.0.$generichide', // IP prefix
      '@@||im9.eu^$image,ghide,1p', // type/party options
      '@@*$ghide,domain=web.de|gmx.*', // entity
      '@@||asd.$generichide,to=asd.homes', // partial host + to=
    ].join('\n'),
  );
  assert.deepEqual(exceptions.generic, []);
  assert.equal(stats.badfiltered, 1);
  assert.equal(stats.unsupported, 5);
});

test('the union across lists is sorted and deduplicated', () => {
  assert.deepEqual(
    mergePageHideExceptions([
      { generic: ['b.com', 'a.com'], specific: [] },
      { generic: ['a.com', 'c.com'], specific: ['x.com'] },
    ]),
    { generic: ['a.com', 'b.com', 'c.com'], specific: ['x.com'] },
  );
});

test('ignore rules cover every site with *, in triggers of at most 200 sites', () => {
  const sites = Array.from({ length: 450 }, (_, i) => `site${String(i).padStart(3, '0')}.com`);
  const rules = genericHideIgnoreRules(sites);
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map((r) => r.trigger['if-domain']!.length), [200, 200, 50]);
  assert.ok(rules.every((r) => r.action.type === 'ignore-previous-rules' && r.trigger['url-filter'] === '.*'));
  assert.equal(rules[0]!.trigger['if-domain']![0], '*site000.com');
  assert.deepEqual(genericHideIgnoreRules([]), []);
});

test('generic hides are css-display-none without if-domain (unless-domain allowed)', () => {
  const [generic, negated, domain] = convert('##.a\n~x.com##.b\ny.com##.c').mainRules;
  assert.deepEqual([generic, negated, domain].map((r) => isGenericHide(r!)), [true, true, false]);
});

test('$specifichide sites leave domain hides at build time; a site under *host keeps it exact', () => {
  const hides = (text: string, sites: string[]) =>
    convert(text, { specificHideSites: sites }).mainRules
      .filter((r) => r.action.type === 'css-display-none')
      .map((r) => ({ selector: r.action.selector, ...r.trigger }));
  assert.deepEqual(hides('a.com,b.com##.ad\nsub.c.com##.x\n##.generic', ['b.com', 'c.com']), [
    { selector: '.ad', 'url-filter': '.*', 'if-domain': ['*a.com'] },
    { selector: '.generic', 'url-filter': '.*' }, // generic hides are the ignore rules' job
  ]);
  assert.deepEqual(hides('a.com##.ad', ['sub.a.com']), [
    { selector: '.ad', 'url-filter': '.*', 'if-domain': ['a.com'] },
  ]);
  const { exceptionStats } = convert('a.com,b.com##.ad\nsub.c.com##.x', { specificHideSites: ['b.com', 'c.com'] });
  assert.equal(exceptionStats.page_specific_narrowed, 1);
  assert.equal(exceptionStats.page_specific_dropped, 1);
});
