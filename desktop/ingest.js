#!/usr/bin/env node
// Desktop batch ingest: copy HEIC/JPEG/PNG inputs, normalize HEIC, build label PNGs and manifest.
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { orientedDimensions, readExifOrientation } = require('./image-orientation');

const ROOT = __dirname;
const IMAGE_RE = /\.(heic|jpe?g|png)$/i;

function fail(message) {
  console.error(`[desktop:ingest] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const inputs = [];
  let data = process.env.OPEN_LENS_DESKTOP_DATA || path.join(ROOT, 'data');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node desktop/ingest.js [--data <directory>] [file-or-directory ...]');
      process.exit(0);
    }
    if (arg === '--data') {
      if (!argv[i + 1]) fail('--data requires a directory');
      data = argv[++i];
      continue;
    }
    if (arg.startsWith('--')) fail(`unknown option: ${arg}`);
    inputs.push(arg);
  }
  return { data: path.resolve(data), inputs: inputs.map(input => path.resolve(input)) };
}

function sh(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

function dimensions(file) {
  const output = sh('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const width = /pixelWidth: (\d+)/.exec(output);
  const height = /pixelHeight: (\d+)/.exec(output);
  if (!width || !height) throw new Error(`cannot read image dimensions: ${file}`);
  return { w: Number(width[1]), h: Number(height[1]) };
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function collectInputs(target, files) {
  if (!fs.existsSync(target)) fail(`input does not exist: ${target}`);
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) collectInputs(path.join(target, name), files);
  } else if (stat.isFile() && IMAGE_RE.test(target)) {
    files.push(target);
  }
}

const options = parseArgs(process.argv.slice(2));
const BATCH = options.data;
const RAW = path.join(BATCH, 'raw');
const LABEL = path.join(BATCH, 'label');
const OUTPUTS = path.join(BATCH, 'outputs');
const MANIFEST = path.join(BATCH, 'manifest.json');

for (const directory of [RAW, LABEL, OUTPUTS]) fs.mkdirSync(directory, { recursive: true });

let copied = 0;
const incoming = [];
for (const input of options.inputs) collectInputs(input, incoming);
for (const source of incoming) {
  const destination = path.join(RAW, path.basename(source));
  if (path.resolve(source) === destination) continue;
  if (fs.existsSync(destination)) {
    if (digest(source) !== digest(destination)) fail(`name collision with different content: ${path.basename(source)}`);
    continue;
  }
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  copied++;
  console.log('[copy]', source, '→', destination);
}

let heicConverted = 0;
for (const name of fs.readdirSync(RAW).filter(file => /\.heic$/i.test(file)).sort()) {
  const jpg = path.join(RAW, name.replace(/\.[^.]+$/, '.jpg'));
  if (fs.existsSync(jpg)) continue;
  sh('sips', ['-s', 'format', 'jpeg', path.join(RAW, name), '--out', jpg]);
  heicConverted++;
  console.log('[heic→jpg]', name, '→', path.basename(jpg));
}

let pngMade = 0;
const manifest = {};
const normalized = fs.readdirSync(RAW).filter(file => /\.(jpe?g|png)$/i.test(file)).sort();
for (const name of normalized) {
  const source = path.join(RAW, name);
  const label = path.join(LABEL, name.replace(/\.[^.]+$/, '.png'));
  if (!fs.existsSync(label)) {
    sh('sips', ['-Z', '1000', '-s', 'format', 'png', source, '--out', label]);
    pngMade++;
  }
  const { w, h } = dimensions(source);
  const orientation = readExifOrientation(source);
  const oriented = orientedDimensions(w, h, orientation);
  manifest[name] = {
    w, h, orientation,
    orientedW: oriented.width, orientedH: oriented.height,
    bytes: fs.statSync(source).size,
  };
}
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nraw: ${normalized.length} 张；复制 ${copied}；HEIC 转 JPEG ${heicConverted}；新建 label PNG ${pngMade}`);
console.log(`data: ${BATCH}`);
console.log(`下一步: node desktop/server.js --data ${JSON.stringify(BATCH)} → http://127.0.0.1:8791`);
