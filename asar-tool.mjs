import fs from 'node:fs';
import path from 'node:path';

const asarPath = process.argv[2] || 'D:\\DeepSeek Harness\\resources\\app.asar';
const cmd = process.argv[3] || 'list';
const target = process.argv[4] || '';

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const pickleSize = head.readUInt32LE(4);
const headerBuf = Buffer.alloc(pickleSize);
fs.readSync(fd, headerBuf, 0, pickleSize, 8);
const jsonSize = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonSize));
const baseOffset = 8 + pickleSize;

function getNode(p) {
  const parts = p.split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}
function isFile(n) { return n && typeof n.size === 'number'; }
function walk(node, prefix, depth, out) {
  if (depth < 0) return;
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (child.files) { out.push(p + '/'); walk(child, p, depth - 1, out); }
    else out.push(p);
  }
}
function readFile(node, p) {
  if (node.unpacked) {
    const up = path.join(asarPath + '.unpacked', p);
    if (fs.existsSync(up)) return fs.readFileSync(up);
  }
  const off = baseOffset + parseInt(node.offset, 10);
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, off);
  return buf;
}

if (cmd === 'list') {
  const node = target ? getNode(target) : header;
  if (!node) { console.error('not found:', target); process.exit(1); }
  if (isFile(node)) { console.log(target, node.size); process.exit(0); }
  const out = [];
  walk(node, target, target ? 1 : 1, out);
  console.log(out.join('\n'));
} else if (cmd === 'find') {
  const re = new RegExp(target, 'i');
  const out = [];
  (function rec(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + name : name;
      if (child.files) rec(child, p);
      else if (re.test(p)) out.push(p + '\t' + child.size);
    }
  })(header, '');
  console.log(out.join('\n'));
} else if (cmd === 'read') {
  const node = getNode(target);
  if (!node || !isFile(node)) { console.error('file not found:', target); process.exit(1); }
  process.stdout.write(readFile(node, target));
} else if (cmd === 'extract') {
  const node = getNode(target);
  if (!node) { console.error('not found:', target); process.exit(1); }
  const outDir = process.argv[5] || '.dsh-probe/extract';
  let count = 0, bytes = 0;
  (function rec(n, prefix) {
    if (n.files) {
      for (const [name, child] of Object.entries(n.files)) rec(child, prefix ? prefix + '/' + name : name);
      return;
    }
    if (n.link || typeof n.size !== 'number') return;
    const rel = prefix || target;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let buf;
    try {
      buf = readFile(n, rel);
    } catch (e) {
      console.error('skip', rel, String(e));
      return;
    }
    fs.writeFileSync(dest, buf);
    count++; bytes += n.size;
  })(node, target);
  console.error(`extracted ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${outDir}`);
}
