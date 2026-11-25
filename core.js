'use strict';
// Motore: il disco è l'unica fonte di verità. Le mod spente e rimosse si spostano, non si cancellano.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), os = require('os');
const { execFileSync } = require('child_process');

const KINDS = ['plugins', 'patchers'];
const META = '.vmm.json';
const BEPINEX = 'denikson-BepInExPack_Valheim';
const GUID_TO_TS = { 'com.jotunn.jotunn': 'ValheimModding-Jotunn' };
const MAX_TOTAL = 2 * 1024 ** 3;
const err = m => Object.assign(new Error(m), { user: true });
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };

/* ---------- archivi ---------- */
function readZip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw err('Archivio zip non valido o incompleto.');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  if (n === 0xffff || p === 0xffffffff) throw err('Formato Zip64 non supportato.');
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw err('Archivio zip danneggiato.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16),
      csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28),
      xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl).replace(/\\/g, '/');
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw err('Archivio protetto da password.');
    out.push({ name, size, data() {
      const s = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(s, s + csize);
      let d;
      if (method === 0) d = raw;
      else if (method === 8) d = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      else throw err('Compressione zip non supportata.');
      if (d.length !== size || zlib.crc32(d) !== crc) throw err('File danneggiato nello zip: ' + name);
      return d;
    } });
  }
  return out;
}
function readArchive(buf, fileName) {
  let files;
  if (buf.length > 4 && buf.readUInt16LE(0) === 0x4b50) files = readZip(buf);
  else if (/\.(7z|rar)$/i.test(fileName)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmm-')); // tar di Windows (libarchive) legge rar e 7z
    try {
      const src = path.join(tmp, 'in.bin'), dir = path.join(tmp, 'x'); fs.writeFileSync(src, buf); fs.mkdirSync(dir);
      try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', src, '-C', dir], { windowsHide: true, timeout: 120000, stdio: 'pipe' }); }
      catch { throw err('Impossibile aprire questo rar/7z. Estrailo e ricomprimilo in zip.'); }
      files = [];
      (function walk(d, rel) { for (const x of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, x.name), r = rel ? rel + '/' + x.name : x.name;
        if (x.isDirectory()) walk(f, r); else if (x.isFile()) { const data = fs.readFileSync(f); files.push({ name: r, size: data.length, data: () => data }); }
      } })(dir, '');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } else throw err('Formato non riconosciuto: servono zip, rar, 7z o dll.');
  let total = 0;
  for (const f of files) {
    const seg = f.name.split('/');
    if (f.name.startsWith('/') || /[:\0<>"|?*]/.test(f.name) || seg.some(s => s === '..' || s === '.' || s === '' || /[. ]$/.test(s)))
      throw err('Archivio rifiutato: contiene un percorso non sicuro (' + f.name + ').');
    if ((total += f.size) > MAX_TOTAL) throw err('Archivio troppo grande.');
  }
  return files;
}

/* ---------- lettura degli attributi BepInEx dentro la dll ---------- */
function inspectDll(b) {
  const plugins = [], deps = new Set();
  const str = p => { // SerString: lunghezza compressa + utf8
    let n = b[p], h = 1;
    if (n === undefined || n === 0xff) return null;
    if (n & 0x80) { if ((n & 0xc0) !== 0x80) return null; n = ((n & 0x3f) << 8) | b[p + 1]; h = 2; }
    if (n < 1 || n > 300 || p + h + n > b.length) return null;
    const s = b.toString('utf8', p + h, p + h + n);
    return /[\x00-\x1f\ufffd]/.test(s) ? null : [s, p + h + n];
  };
  for (let i = b.indexOf('\x01\x00', 1, 'latin1'); i > 0; i = b.indexOf('\x01\x00', i + 1, 'latin1')) {
    const a = str(i + 2); if (!a) continue;
    const len = end => { const L = end - i; return L < 128 ? b[i - 1] === L : b[i - 2] === (0x80 | (L >> 8)) && b[i - 1] === (L & 255); };
    const e = a[1];
    if (e + 6 <= b.length && b.readUInt16LE(e + 4) === 0 && len(e + 6)) {
      const fl = b.readUInt32LE(e); if (fl === 1 && /^[\w.\- ]+$/.test(a[0])) deps.add(a[0]); // 1 = HardDependency
    }
    const n = str(e), v = n && str(n[1]);
    if (v && /^\d+(\.\d+){1,3}/.test(v[0]) && b.readUInt16LE(v[1]) === 0 && len(v[1] + 2)) plugins.push({ guid: a[0], name: n[0], version: v[0] });
  }
  return { plugins, deps: [...deps] };
}

/* ---------- nomi Nexus ---------- */
function parseName(file) {
  const base = path.basename(file).replace(/\.(zip|rar|7z|dll)$/i, '').replace(/ \(\d+\)$/, '');
  let m = base.match(/^(.+?)[ -](\d+)[ ](\S+) \d{4}-\d\d-\d\dT[\d-]+Z \w+$/);
  if (m) return { name: m[1].trim(), nexusId: +m[2], version: m[3] };
  m = base.match(/^(.+?)-(\d+)-([\w-]+)-\d{10}$/);
  if (m) return { name: m[1].replace(/ [\d.]+$/, '').trim(), nexusId: +m[2], version: m[3].replace(/-/g, '.') };
  return { name: base };
}
const isNexusName = f => !!parseName(f).nexusId;
const safeName = s => s.replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80) || 'Mod';
function cmpVer(a, b) {
  const x = String(a || 0).split(/[.-]/).map(n => parseInt(n) || 0), y = String(b || 0).split(/[.-]/).map(n => parseInt(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
const splitDep = d => { const m = d.match(/^(.+)-(\d+\.\d+\.\d+)$/); return m ? { full: m[1], version: m[2] } : { full: d, version: '0' }; };

/* ---------- dove va ogni file ---------- */
function layout(files) {
  const known = /^(bepinex|plugins|patchers|config|core|monomod)$/i;
  let list = files.map(f => ({ f, rel: f.name }));
  for (;;) { // toglie le cartelle-involucro
    const first = new Set(list.map(x => x.rel.includes('/') ? x.rel.split('/')[0] : null));
    const [w] = first; if (first.size !== 1 || !w || known.test(w)) break;
    list = list.map(x => ({ f: x.f, rel: x.rel.slice(w.length + 1) }));
  }
  const out = [], skipped = [];
  for (const x of list) {
    const rel = x.rel.replace(/^bepinex\//i, ''), [head, ...rest] = rel.split('/'), h = head.toLowerCase();
    if (rest.length && KINDS.includes(h)) out.push({ kind: h, rel: rest.join('/'), f: x.f });
    else if (rest.length && h === 'config') out.push({ kind: 'config', rel: rest.join('/'), f: x.f });
    else if (rest.length && (h === 'core' || h === 'monomod')) skipped.push(rel);
    else out.push({ kind: 'plugins', rel, f: x.f });
  }
  // plugins/Nome/... tutto dentro una sola cartella: la si toglie, la ricreiamo noi
  for (const k of KINDS) {
    const own = out.filter(o => o.kind === k), nested = own.filter(o => o.rel.includes('/')), tops = new Set(nested.map(o => o.rel.split('/')[0]));
    if (own.length && nested.length === own.length && tops.size === 1) { const n = [...tops][0].length + 1; own.forEach(o => { o.rel = o.rel.slice(n); }); }
  }
  return { out, skipped };
}

class Manager {
  constructor(game) {
    this.game = game; this.bep = path.join(game, 'BepInEx'); this.vmm = path.join(this.bep, '_vmm'); this.cache = new Map();
    this.isRunning = () => { try { return /valheim\.exe/i.test(execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq valheim.exe', '/NH'], { windowsHide: true }).toString()); } catch { return false; } };
  }
  guard() { if (this.isRunning()) throw err('Valheim è aperto: chiudilo prima di modificare le mod.'); }
  dir(kind, enabled) { return enabled ? path.join(this.bep, kind) : path.join(this.vmm, 'disabled', kind); }
  bepinex() {
    if (!fs.existsSync(path.join(this.game, 'winhttp.dll')) || !fs.existsSync(path.join(this.bep, 'core', 'BepInEx.dll'))) return null;
    const own = readJson(path.join(this.vmm, 'bepinex.json')), m = readJson(path.join(this.game, 'manifest.json'));
    if (own) return own.version;
    return m && /BepInExPack/i.test(m.name || '') ? m.version_number : 'sconosciuta';
  }
  dllInfo(f) {
    const s = fs.statSync(f), k = f + s.mtimeMs + s.size;
    if (!this.cache.has(k)) this.cache.set(k, inspectDll(fs.readFileSync(f)));
    return this.cache.get(k);
  }
  walk(p) {
    const r = []; const go = d => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) go(f); else if (x.isFile()) r.push(f); } };
    if (fs.statSync(p).isDirectory()) go(p); else r.push(p); return r;
  }
  scan() {
    const map = new Map();
    for (const enabled of [true, false]) for (const kind of KINDS) {
      const d = this.dir(kind, enabled); if (!fs.existsSync(d)) continue;
      for (const x of fs.readdirSync(d, { withFileTypes: true })) {
        if (!x.isDirectory() && !/\.dll$/i.test(x.name)) continue;
        const key = (enabled ? '1' : '0') + x.name;
        let m = map.get(key); if (!m) map.set(key, m = { id: key, entry: x.name, enabled, places: [] });
        m.places.push({ kind, path: path.join(d, x.name) });
      }
    }
    const mods = [...map.values()];
    for (const m of mods) {
      const files = m.places.flatMap(p => { try { return this.walk(p.path); } catch { return []; } });
      const find = n => files.filter(f => path.basename(f).toLowerCase() === n).sort((a, b) => a.length - b.length)[0];
      const meta = readJson(find(META), {}) || {}, man = readJson(find('manifest.json'), {}) || {}, pn = parseName(m.entry);
      m.plugins = []; m.deps = []; m.size = 0;
      for (const f of files) { try { m.size += fs.statSync(f).size; if (/\.dll$/i.test(f)) { const i = this.dllInfo(f); m.plugins.push(...i.plugins); m.deps.push(...i.deps); } } catch {} }
      m.dlls = files.filter(f => /\.dll$/i.test(f)).length;
      const main = m.plugins[0];
      m.ts = meta.ts || m.plugins.map(p => GUID_TO_TS[p.guid]).find(Boolean) || null;
      m.nexusId = meta.nexusId || pn.nexusId || null;
      m.name = meta.name || (main && main.name) || man.name || pn.name;
      m.version = meta.version || (main && main.version) || man.version_number || pn.version || null;
      m.description = man.description || ''; m.icon = !!find('icon.png'); m.iconPath = find('icon.png');
      m.configs = m.plugins.map(p => p.guid + '.cfg').filter(f => fs.existsSync(path.join(this.bep, 'config', f)));
      m.issues = [];
    }
    const on = new Map();
    for (const m of mods) if (m.enabled) for (const p of m.plugins) on.set(p.guid, [...(on.get(p.guid) || []), m]);
    for (const m of mods) if (m.enabled) {
      const own = new Set(m.plugins.map(p => p.guid));
      for (const d of new Set(m.deps)) if (!own.has(d) && !on.has(d)) {
        const off = mods.find(x => !x.enabled && x.plugins.some(p => p.guid === d));
        m.issues.push({ type: 'missing', guid: d, ts: GUID_TO_TS[d] || null, disabledId: off ? off.id : null, text: off ? `Richiede ${off.name}, che è spenta` : `Manca una mod richiesta: ${d}` });
      }
      for (const p of m.plugins) { const o = on.get(p.guid).filter(x => x !== m); if (o.length) m.issues.push({ type: 'dup', text: `Doppione di ${o[0].name} (${o[0].entry})` }); }
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
  }
  get(id) { const m = this.scan().find(x => x.id === id); if (!m) throw err('Mod non trovata: aggiorna la lista.'); return m; }
  move(list) { // tutto o niente
    for (const [, to] of list) if (fs.existsSync(to)) throw err('Esiste già: ' + path.basename(to));
    const done = [];
    try { for (const [a, b] of list) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); done.push([a, b]); } }
    catch (e) { for (const [a, b] of done.reverse()) try { fs.renameSync(b, a); } catch {} throw err('Spostamento non riuscito, nulla è cambiato (' + (e.code || e.message) + ').'); }
  }
  setEnabled(id, on) { this.guard(); const m = this.get(id); if (m.enabled !== on) this.move(m.places.map(p => [p.path, path.join(this.dir(p.kind, on), m.entry)])); }
  trash(m, why) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6), base = path.join(this.vmm, 'trash', id);
    this.move(m.places.map(p => [p.path, path.join(base, p.kind, m.entry)]));
    fs.writeFileSync(path.join(base, 'info.json'), JSON.stringify({ id, name: m.name, version: m.version, entry: m.entry, enabled: m.enabled, kinds: m.places.map(p => p.kind), why, date: new Date().toISOString() }));
    return id;
  }
  remove(id) { this.guard(); return this.trash(this.get(id), 'rimossa'); }
  listTrash() {
    const d = path.join(this.vmm, 'trash'); if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).map(x => readJson(path.join(d, x, 'info.json'))).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date));
  }
  restore(id) {
    this.guard(); const t = this.listTrash().find(x => x.id === id); if (!t) throw err('Non è più nel cestino.');
    const base = path.join(this.vmm, 'trash', t.id), prev = this.bySame(t.entry);
    if (prev) throw err(`C'è già una mod nella cartella "${t.entry}": rimuovila prima.`);
    this.move(t.kinds.map(k => [path.join(base, k, t.entry), path.join(this.dir(k, t.enabled), t.entry)]));
    fs.rmSync(base, { recursive: true, force: true });
  }
  bySame(entry) { return this.scan().find(m => m.entry.toLowerCase() === entry.toLowerCase()); }
  emptyTrash() { fs.rmSync(path.join(this.vmm, 'trash'), { recursive: true, force: true }); }

  install(buf, fileName, extra = {}) {
    this.guard();
    if (!fs.existsSync(path.join(this.bep, 'core'))) throw err('Prima installa BepInEx.');
    const isDll = /\.dll$/i.test(fileName);
    const files = isDll ? [{ name: path.basename(fileName), size: buf.length, data: () => buf }] : readArchive(buf, fileName);
    if (files.some(f => /(^|\/)winhttp\.dll$/i.test(f.name)) && files.some(f => /BepInEx\/core\/BepInEx\.dll$/i.test(f.name))) throw err('Questo è BepInEx, non una mod: usa il pulsante BepInEx in alto.');
    if (!files.some(f => /\.dll$/i.test(f.name)) && files.some(f => /\.(fwl|db)$/i.test(f.name))) throw err('Questo è un mondo salvato, non una mod: non lo installo.');
    const { out, skipped } = layout(files), pn = parseName(fileName), plugins = [], warnings = [];
    if (!out.length) throw err('Non ho trovato nulla da installare in questo archivio.');
    if (skipped.length) warnings.push(`${skipped.length} file per il cuore di BepInEx ignorati`);
    const data = out.map(o => ({ ...o, data: o.f.data() }));
    let man = {};
    for (const o of data) {
      if (/\.dll$/i.test(o.rel)) plugins.push(...inspectDll(o.data).plugins);
      if (/^manifest\.json$/i.test(o.rel)) try { man = JSON.parse(o.data.toString('utf8').replace(/^\uFEFF/, '')); } catch {}
    }
    if (!plugins.length && !extra.ts && !data.some(o => o.kind === 'patchers')) warnings.push('Nessun plugin BepInEx trovato dentro: controlla le istruzioni della mod');
    const guids = new Set(plugins.map(p => p.guid)), nexusId = extra.nexusId || pn.nexusId;
    const entry = safeName(extra.ts || (pn.nexusId || isDll ? pn.name : man.name || pn.name));
    const old = this.scan().filter(m => (extra.ts && m.ts === extra.ts) || m.plugins.some(p => guids.has(p.guid)) || m.entry.toLowerCase() === entry.toLowerCase());
    for (const m of old) {
      const extraG = m.plugins.filter(p => !guids.has(p.guid));
      const same = (extra.ts && m.ts === extra.ts) || (nexusId && m.nexusId === nexusId);
      if (extraG.length && !same) throw err(`Conflitto: "${m.entry}" contiene anche ${extraG[0].name}. Rimuovila a mano prima.`);
    }
    const enabled = old.length ? old.some(m => m.enabled) : true;
    const stage = path.join(this.vmm, 'staging', Date.now().toString(36)), kinds = new Set(), cfgs = [];
    try {
      for (const o of data) {
        if (o.kind === 'config') { cfgs.push(o); continue; }
        kinds.add(o.kind);
        const f = path.join(stage, o.kind, entry, o.rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, o.data);
      }
      if (!kinds.size) { kinds.add('plugins'); fs.mkdirSync(path.join(stage, 'plugins', entry), { recursive: true }); }
      const meta = { name: extra.name || (pn.nexusId && plugins[0] ? plugins[0].name : undefined), version: extra.version || (plugins[0] && plugins[0].version) || man.version_number || pn.version, ts: extra.ts, nexusId, installed: new Date().toISOString() };
      fs.writeFileSync(path.join(stage, [...kinds][0], entry, META), JSON.stringify(meta, null, 1));
      const trashed = [];
      try {
        for (const m of old) trashed.push(this.trash(m, 'aggiornata'));
        this.move([...kinds].map(k => [path.join(stage, k, entry), path.join(this.dir(k, enabled), entry)]));
      } catch (e) { for (const t of trashed.reverse()) try { this.restore(t); } catch {} throw e; }
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    const gone = new Set(old.map(m => m.entry).filter(e => e !== entry)), prof = this.profiles();
    if (gone.size && Object.keys(prof).length) { // i profili seguono il nuovo nome di cartella
      for (const n of Object.keys(prof)) prof[n] = [...new Set(prof[n].map(e => gone.has(e) ? entry : e))];
      fs.writeFileSync(this.profFile(), JSON.stringify(prof, null, 1));
    }
    for (const o of cfgs) { const f = path.join(this.bep, 'config', o.rel); if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, o.data); } }
    return { name: extra.name || (plugins[0] && plugins[0].name) || entry, entry, replaced: old.map(m => m.name), warnings };
  }
  installBepInEx(buf, version) {
    this.guard();
    const files = readArchive(buf, 'x.zip'), pre = 'BepInExPack_Valheim/', list = files.filter(f => f.name.startsWith(pre)).map(f => ({ rel: f.name.slice(pre.length), d: f.data() }));
    if (!list.some(x => x.rel === 'winhttp.dll')) throw err('Pacchetto BepInEx inatteso.');
    const bak = path.join(this.vmm, 'bepinex-backup', Date.now().toString(36));
    for (const x of list) {
      const to = path.join(this.game, x.rel);
      if (fs.existsSync(to)) {
        if (/^BepInEx\/config\//i.test(x.rel)) continue;
        const b = path.join(bak, x.rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(to, b);
      }
      fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, x.d);
    }
    for (const k of KINDS) fs.mkdirSync(path.join(this.bep, k), { recursive: true });
    fs.mkdirSync(this.vmm, { recursive: true }); fs.writeFileSync(path.join(this.vmm, 'bepinex.json'), JSON.stringify({ version }));
  }

  /* ---------- profili ---------- */
  profFile() { return path.join(this.vmm, 'profiles.json'); }
  profiles() { return readJson(this.profFile(), {}) || {}; }
  saveProfile(name) { const p = Object.assign(Object.create(null), this.profiles()); p[String(name).slice(0, 40)] = this.scan().filter(m => m.enabled).map(m => m.entry); fs.mkdirSync(this.vmm, { recursive: true }); fs.writeFileSync(this.profFile(), JSON.stringify(p, null, 1)); }
  deleteProfile(name) { const p = this.profiles(); delete p[name]; fs.writeFileSync(this.profFile(), JSON.stringify(p, null, 1)); }
  applyProfile(name) {
    this.guard(); const p = this.profiles(); if (!Object.hasOwn(p, name)) throw err('Profilo non trovato.');
    const want = new Set(p[name]), mods = this.scan(), moves = [];
    for (const m of mods) if (m.enabled !== want.has(m.entry)) for (const x of m.places) moves.push([x.path, path.join(this.dir(x.kind, !m.enabled), m.entry)]);
    this.move(moves);
    return { missing: p[name].filter(e => !mods.some(m => m.entry === e)) };
  }

  /* ---------- config ---------- */
  cfgPath(f) { const d = path.join(this.bep, 'config'), p = path.resolve(d, f); if (!p.startsWith(d + path.sep) || !/\.cfg$/i.test(p)) throw err('File non valido.'); return p; }
  listConfigs() { const d = path.join(this.bep, 'config'); return fs.existsSync(d) ? this.walk(d).filter(f => /\.cfg$/i.test(f)).map(f => path.relative(d, f)) : []; }
  readConfig(f) {
    const out = []; let sec = '', desc = [], o = {};
    for (const l of fs.readFileSync(this.cfgPath(f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      let m;
      if ((m = l.match(/^\[(.+)\]\s*$/))) { sec = m[1]; desc = []; o = {}; }
      else if (l.startsWith('##')) desc.push(l.slice(2).trim());
      else if ((m = l.match(/^# Setting type: (.+)/))) o.type = m[1].trim();
      else if ((m = l.match(/^# Default value: ?(.*)/))) o.def = m[1];
      else if ((m = l.match(/^# Acceptable values: (.+)/))) o.values = m[1].split(',').map(s => s.trim());
      else if ((m = l.match(/^# Acceptable value range: (.+)/))) o.range = m[1];
      else if (l.startsWith('# Multiple values')) o.multi = true;
      else if (!l.startsWith('#') && (m = l.match(/^([^=]+?)\s*=\s?(.*)$/))) { out.push({ section: sec, key: m[1], value: m[2], desc: desc.join(' '), ...o }); desc = []; o = {}; }
    }
    return out;
  }
  writeConfig(f, changes) {
    this.guard(); const p = this.cfgPath(f), raw = fs.readFileSync(p, 'utf8'); let sec = '';
    const bad = changes.find(c => /[\r\n]/.test(String(c.value))); if (bad) throw err('Valore non valido.');
    const text = raw.split(/(\r?\n)/).map(l => {
      let m;
      if ((m = l.match(/^\uFEFF?\[(.+)\]\s*$/))) sec = m[1];
      else if (!l.startsWith('#') && (m = l.match(/^([^=]+?)\s*=\s?(.*)$/))) { const c = changes.find(c => c.section === sec && c.key === m[1]); if (c) return `${m[1]} = ${c.value}`; }
      return l;
    }).join('');
    fs.copyFileSync(p, p + '.bak'); fs.writeFileSync(p, text);
  }
  log() {
    const f = path.join(this.bep, 'LogOutput.log'); if (!fs.existsSync(f)) return null;
    const t = fs.readFileSync(f, 'utf8'), L = t.split(/\r?\n/);
    const bad = L.filter(l => /^\[(Error|Fatal|Warning)\s*:/.test(l));
    return { date: fs.statSync(f).mtime, summary: (t.match(/Chainloader startup complete.*/) || [''])[0].replace('Chainloader startup complete ', ''), valheim: (t.match(/Valheim Version: (\S+)/) || [])[1],
      errors: bad.filter(l => !l.startsWith('[Warning')).length, warnings: bad.filter(l => l.startsWith('[Warning')).length, lines: bad.slice(-200), tail: L.slice(-400).join('\n') };
  }
}
/* ---------- condivisione ---------- */
// Il codice contiene solo nomi e versioni: mai file, percorsi o impostazioni.
const PRE = 'VALHEIM-MOD:';
function encodePack(p) { return PRE + zlib.deflateRawSync(Buffer.from(JSON.stringify(p))).toString('base64url'); }
function decodePack(code) { // arriva da altri: si controlla tutto
  const m = String(code).slice(0, 100000).match(/VALHEIM-MOD:([\w-]+)/); let p;
  try { p = JSON.parse(zlib.inflateRawSync(Buffer.from(m[1], 'base64url'), { maxOutputLength: 300000 }).toString('utf8')); } catch { throw err('Codice non valido: copialo di nuovo per intero.'); }
  const str = (v, n) => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, '').slice(0, n) : '';
  if (!p || p.v !== 1 || !Array.isArray(p.m) || !p.m.length || p.m.length > 300) throw err('Codice non valido: copialo di nuovo per intero.');
  return { v: 1, n: str(p.n, 40) || 'Amici', g: str(p.g, 20), m: p.m.map(x => ({ n: str(x && x.n, 80) || 'Mod', v: /^\d+(\.\d+){0,3}$/.test(x && x.v) ? x.v : '', t: /^[\w.]+-\w+$/.test(x && x.t) ? x.t : '', x: x && Number.isInteger(x.x) && x.x > 0 ? x.x : 0, g: Array.isArray(x && x.g) ? x.g.slice(0, 20).map(y => str(y, 120)).filter(Boolean) : [] })) };
}
function makePack(mods, name, valheim) {
  return { v: 1, n: name, g: valheim || '', m: mods.filter(m => m.enabled).map(m => ({ n: m.name, v: m.version || '', t: m.ts || '', x: m.nexusId || 0, g: m.plugins.map(p => p.guid) })) };
}
function comparePack(pack, mods) {
  const used = new Set();
  const items = pack.m.map(x => {
    const same = mods.filter(m => (x.t && m.ts === x.t) || (x.g.length && m.plugins.some(p => x.g.includes(p.guid))) || (!x.g.length && x.x && m.nexusId === x.x)), have = same.find(m => m.enabled) || same[0];
    same.forEach(m => used.add(m.id));
    return { ...x, id: have && have.id, have: have && have.version, state: !have ? 'missing' : x.v && cmpVer(x.v, have.version) !== 0 ? 'version' : !have.enabled ? 'off' : 'ok' };
  });
  return { items, extra: mods.filter(m => m.enabled && !used.has(m.id)).map(m => ({ id: m.id, name: m.name })) };
}
module.exports = { encodePack, decodePack, makePack, comparePack, Manager, readArchive, inspectDll, parseName, isNexusName, cmpVer, splitDep, layout, err, readJson, BEPINEX };
