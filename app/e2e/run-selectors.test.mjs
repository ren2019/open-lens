import assert from 'node:assert/strict';
import { availableSelectors, defaultSuites, resolveSuites } from './lib/suites.mjs';

const aliases = [
  ['US-B1-B2-CV', 'B1-B2-CV'],
  ['US-DETECTOR-MODE', 'D9-DETECTOR-MODE'],
  ['US-E2-E3', 'E2-E3-OUTFITS'],
];

assert.equal(defaultSuites.length, 18, 'default run must execute each suite exactly once');

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

console.log('SELECTOR TEST DONE (legacy aliases, neutral selectors, dedupe, unknown PASS)');
