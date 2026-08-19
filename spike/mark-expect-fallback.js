#!/usr/bin/env node
// Explicitly mark a user-selected GT subset. Dry-run by default; --apply snapshots before writing.
const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[expectFallback] ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node spike/mark-expect-fallback.js <dataset-dir> (--set <id,id...> | --clear <id,id...>) [--apply]');
  process.exit(0);
}
const datasetArg = args.find(arg => !arg.startsWith('--') && !((args[args.indexOf(arg) - 1] || '').startsWith('--')));
if (!datasetArg) fail('dataset directory is required');
const action = args.includes('--set') ? 'set' : args.includes('--clear') ? 'clear' : null;
if (!action || (args.includes('--set') && args.includes('--clear'))) fail('choose exactly one of --set or --clear');
const optionIndex = args.indexOf(`--${action}`);
const idText = args[optionIndex + 1];
if (!idText || idText.startsWith('--')) fail(`--${action} requires a comma-separated id list`);
const requested = idText.split(',').map(id => id.trim()).filter(Boolean);
if (!requested.length) fail('id list is empty');

const dataset = path.resolve(__dirname, datasetArg);
const gtFile = path.join(dataset, 'ground-truth.json');
const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
const keys = Object.keys(gt);
const resolved = requested.map(request => {
  if (gt[request]) return request;
  const base = request.replace(/\.(png|jpe?g)$/i, '');
  const matches = keys.filter(key => key.replace(/\.(png|jpe?g)$/i, '') === base);
  if (matches.length !== 1) fail(`${request}: expected exactly one matching GT key, found ${matches.length}`);
  return matches[0];
});

for (const id of resolved) {
  const record = gt[id];
  if (action === 'set' && (record.noTarget || !Array.isArray(record.quad) || record.quad.length !== 4)) {
    fail(`${id}: expectFallback requires an existing target quad and cannot be noTarget`);
  }
}
console.log(JSON.stringify({ dryRun: !args.includes('--apply'), action, dataset, ids: resolved }, null, 2));
if (!args.includes('--apply')) {
  console.log('[expectFallback] dry run only; pass --apply after the user confirms this exact subset');
  process.exit(0);
}

const snapshotDir = path.join(dataset, '.gt-snapshots');
fs.mkdirSync(snapshotDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshot = path.join(snapshotDir, `ground-truth.pre-${action}-${stamp}.json`);
fs.copyFileSync(gtFile, snapshot, fs.constants.COPYFILE_EXCL);
for (const id of resolved) {
  if (action === 'set') gt[id].expectFallback = true;
  else delete gt[id].expectFallback;
}
fs.writeFileSync(gtFile, `${JSON.stringify(gt, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, action, changed: resolved.length, snapshot }, null, 2));
