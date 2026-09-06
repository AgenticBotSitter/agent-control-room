// Source comparison against the exact, already-downloaded MIT candidate. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeIndustryTitle, describeIndustryEvent, industryEventsConflict } from '../../src/vendor/control-center/industry-events.ts';
import { canonicalizeAbsNewsDiscoveredUrlV1 } from '../../src/project-adapters/abs-news/v1/collection.ts';

const root = process.env.CR_REUSE_ABS_ROOT;
assert.ok(root && isAbsolute(root));
const source = join(root, 'industry-curation.ts');
assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), 'ad668fe4bf08e7b48913b43ef7edb05edbe4d874db1a16c451ff006e0b70d962');
const upstream = await import(pathToFileURL(source).href);

test('adopted title normalization matches pinned upstream across Unicode, markup and source suffixes', () => {
  for (const [title, sourceLabel] of [
    ['Breaking: Orion launches agent runtime - Tech News', 'Tech News'],
    ['Updated: ＡＩ &amp; Robotics | Trusted News', 'Trusted News'],
    ['<b>研究 AI</b> — Global Research', 'Global Research'],
    ['Exclusive: Model release: another title', 'Unrelated Publisher'],
    ['A normal headline', ''],
  ]) assert.equal(normalizeIndustryTitle(title, sourceLabel), upstream.normalizeIndustryTitle(title, sourceLabel));
});

test('shared event tokens defer the same long headline pair as upstream curation', () => {
  const first = { title: 'Orion launches open source agent runtime', source: 'Tech News', url: 'https://one.example.com/news' };
  const second = { title: 'Open source agent runtime launches from Orion', source: 'Other News', url: 'https://two.example.com/news' };
  assert.equal(upstream.curateIndustryDiscoveries([first, second], { now: 0, minimumScore: 0 }).selected.length, 1);
  assert.equal(industryEventsConflict(describeIndustryEvent(first.title, first.source, first.url), describeIndustryEvent(second.title, second.source, second.url)), true);
});

test('upstream soft cap fills spare slots: not adopted for our hard-cap contract', () => {
  const items = [
    { title: 'Robotics lab launches navigation platform', source: 'Same Source', url: 'https://one.example.com/robotics' },
    { title: 'Privacy legislation changes medical research', source: 'Same Source', url: 'https://one.example.com/medical-laws' },
  ];
  assert.equal(upstream.curateIndustryDiscoveries(items, { now: 0, minimumScore: 0, limit: 5, maxPerSource: 1 }).selected.length, 2);
});

test('upstream URL normalization is not our public-HTTPS destination validator', () => {
  const input = 'http://localhost/story?meaningful=value';
  assert.equal(upstream.canonicalizeIndustryUrl(input), input);
  assert.throws(() => canonicalizeAbsNewsDiscoveredUrlV1(input));
});
