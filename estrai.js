'use strict';
// Estrae un rar/7z controllando quanto scrive: oltre il limite si ferma (archivi "bomba").
// node estrai.js <limite in byte> <cartella> <programma> <argomenti...>   esce con 9 se il limite è superato
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const [max, dir, exe, ...args] = process.argv.slice(2), LIMIT = +max;
function size(d) { let n = 0, c = 0; const go = x => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { if (n > LIMIT || c > 20000) return; c++; const f = path.join(x, e.name); try { if (e.isDirectory()) go(f); else n += fs.lstatSync(f).size; } catch {} } }; try { go(d); } catch {} return c > 20000 ? Infinity : n; }
let over = false, late = false;
const p = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
const t = setInterval(() => { if (size(dir) > LIMIT) { over = true; p.kill(); } }, 60), stop = setTimeout(() => { late = true; p.kill(); }, 110000);
p.on('error', () => process.exit(1));
p.on('exit', code => { clearInterval(t); clearTimeout(stop); process.exit(over || size(dir) > LIMIT ? 9 : late ? 8 : code === 0 ? 0 : 1); });
