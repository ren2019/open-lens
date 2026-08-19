const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scoreCase, validateGroundTruth } = require('./eval-score.js');

let checks = 0;
function check(name, fn) {
  try { fn(); checks++; console.log(`PASS  #10: ${name}`); }
  catch (error) { console.error(`FAIL  #10: ${name}\n${error.stack}`); process.exitCode = 1; }
}

const quad = [[0, 0], [10, 0], [10, 10], [0, 10]];
check('expectFallback 检不出计满分并标记正确降级', () => {
  const result = scoreCase({ quad, expectFallback: true }, null, () => 0.2);
  assert.deepStrictEqual({ label: result.label, score: result.score, good: result.good }, { label: '✓降级', score: 1, good: true });
});
check('expectFallback 硬检出计零并进入误检', () => {
  const result = scoreCase({ quad, expectFallback: true }, quad, () => 1);
  assert.deepStrictEqual({ label: result.label, score: result.score, falsePositive: result.falsePositive }, { label: '误检', score: 0, falsePositive: true });
});
check('普通 quad 继续沿用 IoU 计分', () => {
  const result = scoreCase({ quad }, quad, () => 0.82);
  assert.strictEqual(result.score, 0.82); assert.strictEqual(result.good, true);
});
check('noTarget 与 expectFallback 被 schema 明确区分', () => {
  assert.throws(() => validateGroundTruth('bad.png', { noTarget: true, expectFallback: true }), /mutually exclusive/);
  assert.doesNotThrow(() => validateGroundTruth('fallback.png', { quad, expectFallback: true }));
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'open-lens-fallback-e2e-'));
try {
  const gtFile = path.join(scratch, 'ground-truth.json');
  fs.writeFileSync(gtFile, JSON.stringify({ 'A.png': { mode: 'screen', quad }, 'B.png': { mode: 'screen', noTarget: true } }, null, 2));
  const command = path.join(__dirname, 'mark-expect-fallback.js');
  const dryRun = spawnSync(process.execPath, [command, scratch, '--set', 'A'], { encoding: 'utf8' });
  check('批量指认默认 dry-run 不写 GT', () => {
    assert.strictEqual(dryRun.status, 0); assert.strictEqual(JSON.parse(fs.readFileSync(gtFile))['A.png'].expectFallback, undefined);
  });
  const applied = spawnSync(process.execPath, [command, scratch, '--set', 'A', '--apply'], { encoding: 'utf8' });
  check('显式 apply 写标记且自动保留快照', () => {
    assert.strictEqual(applied.status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(gtFile))['A.png'].expectFallback, true);
    assert.strictEqual(fs.readdirSync(path.join(scratch, '.gt-snapshots')).length, 1);
  });
  const invalid = spawnSync(process.execPath, [command, scratch, '--set', 'B', '--apply'], { encoding: 'utf8' });
  check('noTarget 不能被误标为 expectFallback', () => assert.notStrictEqual(invalid.status, 0));
  fs.copyFileSync(path.join(__dirname, 'photos/02-perspective-whiteboard.png'), path.join(scratch, 'A.png'));
  const evaluated = spawnSync(process.execPath, [path.join(__dirname, 'eval-run.js'), scratch], { encoding: 'utf8', timeout: 30000 });
  check('eval-run 汇总输出 expectFallback 成功率与误检列', () => {
    assert.strictEqual(evaluated.status, 0, evaluated.stderr);
    assert.match(evaluated.stdout, /expectFallback=\d\/1 误检=/);
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(process.exitCode ? `TEST DONE (FAILED/${checks + 1})` : `TEST DONE (${checks}/${checks} PASS)`);
