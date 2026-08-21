import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { availableSelectors, defaultSuites, resolveSuites } from './lib/suites.mjs';

const expectedDefaultSuiteIds = [
  'US-G3',
  'US-A2',
  'US-A3',
  'US-A4',
  'US-B1',
  'US-B5',
  'B1-B2-CV',
  'D9-DETECTOR-MODE',
  'US-C1',
  'US-D3',
  'US-D1',
  'US-D2',
  'US-E1',
  'E1-IMAGE-SHARE',
  'E1-REMOTE-IMAGE-SHARE',
  'E2-E3-OUTFITS',
  'US-F1',
  'US-F3',
  'US-D4',
  'US-D8',
];

const aliases = [
  ['US-B1-B2-CV', 'B1-B2-CV'],
  ['US-DETECTOR-MODE', 'D9-DETECTOR-MODE'],
  ['US-E2-E3', 'E2-E3-OUTFITS'],
];

function assertDefaultSuiteManifest(suites) {
  const ids = suites.map(({ id }) => id);
  const files = suites.map(({ file }) => file);
  assert.equal(new Set(ids).size, ids.length, 'default suite ids must be unique');
  assert.equal(new Set(files).size, files.length, 'default suite files must be unique');
  assert.deepEqual(
    [...ids].sort(),
    [...expectedDefaultSuiteIds].sort(),
    'default suite ids must match the expected manifest exactly',
  );
}

assertDefaultSuiteManifest(defaultSuites);

const duplicateSuite = [...defaultSuites.slice(0, -1), defaultSuites[0]];
assert.throws(
  () => assertDefaultSuiteManifest(duplicateSuite),
  /default suite ids must be unique/,
  'a duplicate suite must be rejected even when the total count stays unchanged',
);
assert.throws(
  () => assertDefaultSuiteManifest(defaultSuites.slice(1)),
  /default suite ids must match the expected manifest exactly/,
  'a missing suite must be rejected',
);

for (const [legacy, neutral] of aliases) {
  const legacyResult = resolveSuites([legacy]);
  const neutralResult = resolveSuites([neutral]);
  assert.deepEqual(legacyResult.unknown, [], `${legacy} must remain accepted`);
  assert.deepEqual(neutralResult.unknown, [], `${neutral} must remain accepted`);
  assert.deepEqual(legacyResult.selected, neutralResult.selected, `${legacy} and ${neutral} must resolve to the same suite`);
  assert.ok(availableSelectors.includes(legacy) && availableSelectors.includes(neutral));
}

const duplicate = resolveSuites(['US-B1-B2-CV', 'B1-B2-CV']);
assert.equal(duplicate.selected.length, 1, 'legacy and neutral aliases must not execute the suite twice');

const invalid = resolveSuites(['US-B1-B2-CV', 'NOT-A-SUITE']);
assert.deepEqual(invalid.unknown, ['NOT-A-SUITE']);
assert.equal(invalid.selected.length, 1, 'a valid selector remains resolved alongside an unknown selector');

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const unknownCli = spawnSync(process.execPath, [runner, 'NOT-A-SUITE'], { encoding: 'utf8' });
assert.equal(unknownCli.status, 2, 'the CLI must return code 2 for an unknown selector');
assert.match(unknownCli.stderr, /^Unknown suite\./, 'the CLI must report the unknown selector before starting services');

console.log('SELECTOR TEST DONE (manifest, uniqueness, negative cases, aliases, dedupe, unknown code 2 PASS)');
