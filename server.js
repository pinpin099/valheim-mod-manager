'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const C = require('./core'); const { err } = C;

const DATA = process.env.VMM_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'ValheimModManager');
const PORT = +process.env.VMM_PORT || 47815, HEADLESS = !!process.env.VMM_HEADLESS;
// L'app parte senza finestra: se si ferma per un errore lo si scrive su file e lo si mostra, invece di sparire in silenzio
const errFile = () => path.join(fs.existsSync(DATA) ? DATA : os.tmpdir(), 'errore.txt');
function logErr(e) { try { fs.appendFileSync(errFile(), new Date().toISOString() + ' ' + ((e && e.stack) || e) + '\n'); } catch {} }
function fatal(e) {
  logErr(e); console.error(e);
  if (!HEADLESS) try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:VMM_MSG, "Valheim Mod Manager")'],
      { env: { ...process.env, VMM_MSG: 'Il mod manager si è fermato per un errore:\n\n' + ((e && e.message) || e) + '\n\nDettagli nel file:\n' + errFile() }, windowsHide: true, stdio: 'ignore', timeout: 600000 });
  } catch {}
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', logErr);
fs.mkdirSync(DATA, { recursive: true });

function steamPath() {
  try { return execFileSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, stdio: 'pipe' }).toString().match(/REG_SZ\s+(.+)/)[1].trim(); } catch { return null; }
}
function findGame() {
  if (process.env.VMM_GAME) return process.env.VMM_GAME;
  const s = steamPath(), libs = [s];
  try { for (const m of fs.readFileSync(path.join(s, 'steamapps', 'libraryfolders.vdf'), 'utf8').matchAll(/"path"\s+"(.+?)"/g)) libs.push(m[1].replace(/\\\\/g, '\\')); } catch {}
  return libs.filter(Boolean).map(l => path.resolve(l, 'steamapps', 'common', 'Valheim')).find(d => fs.existsSync(path.join(d, 'valheim.exe')));
}
function openWindow(url) {
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map(p => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(fs.existsSync);
  if (edge) spawn(edge, ['--app=' + url, '--window-size=1240,860'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
}
const game = findGame(), mgr = game && new C.Manager(game), token = crypto.randomBytes(24).toString('hex');
const stateFile = path.join(DATA, 'instance.json'), page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* ---------- Thunderstore ---------- */
let idx = null, idxAt = 0, idxBusy = null;
const idxFile = path.join(DATA, 'thunderstore.json');
async function fetchOk(u) { let r; try { r = await fetch(u, { signal: AbortSignal.timeout(180000) }); } catch { throw err('Thunderstore non risponde: controlla la connessione.'); } if (!r.ok) throw err('Thunderstore ha risposto con errore ' + r.status); return r; }
async function index(force) {
  if (!idx) { const c = C.readJson(idxFile); if (c && Array.isArray(c.list) && c.list[0] && c.list[0].cr) { idx = new Map(c.list.map(p => [p.f, p])); idxAt = c.at; } }
  if (idx && !force && Date.now() - idxAt < 3600e3) return idx;
  idxBusy ||= (async () => {
    const all = await (await fetchOk('https://thunderstore.io/c/valheim/api/v1/package/')).json();
    const list = all.filter(p => p.versions.length).map(p => { const v = p.versions[0]; return { f: p.full_name, n: p.name, o: p.owner, d: v.description, v: v.version_number, i: v.icon, dep: v.dependencies, s: v.file_size, u: p.date_updated, cr: p.date_created, r: p.rating_score, dl: p.versions.reduce((a, x) => a + x.downloads, 0), c: p.categories, x: p.is_deprecated, w: p.has_nsfw_content, url: p.package_url }; });
    idx = new Map(list.map(p => [p.f, p])); idxAt = Date.now(); fs.writeFileSync(idxFile, JSON.stringify({ at: idxAt, list }));
    return idx;
  })().finally(() => { idxBusy = null; });
  try { return await idxBusy; } catch (e) { if (idx) return idx; throw e; }
}
async function download(p) {
  if (p.s > 1024 ** 3) throw err('Pacchetto troppo grande.');
  return Buffer.from(await (await fetchOk(`https://thunderstore.io/package/download/${encodeURIComponent(p.o)}/${encodeURIComponent(p.n)}/${encodeURIComponent(p.v)}/`)).arrayBuffer());
}
async function plan(full) { // la mod più ciò che le serve, dipendenze per prime
  const ix = await index(), mods = mgr.scan(), seen = new Set(), todo = [], enable = [], missing = [];
  const visit = (f, min, root) => {
    if (seen.has(f) || f === C.BEPINEX) return; seen.add(f);
    const p = ix.get(f), have = mods.find(m => m.ts === f);
    if (!root && have && !have.enabled) enable.push(have.id);
    if (!p) { if (!have) missing.push(f); return; }
    for (const d of p.dep) { const x = C.splitDep(d); visit(x.full, x.version, false); }
    if (root || !have || C.cmpVer(have.version, min) < 0) todo.push(p);
  };
  visit(full, '0', true);
  return { todo, enable, missing };
}
async function installTs(full) {
  mgr.guard();
  const { todo, enable, missing } = await plan(full);
  if (!todo.length) throw err('Mod non trovata su Thunderstore.');
  if (missing.length) throw err('Dipendenze non disponibili: ' + missing.join(', '));
  const bufs = []; for (const p of todo) bufs.push(await download(p));
  for (const id of enable) mgr.setEnabled(id, true);
  const res = []; todo.forEach((p, i) => res.push(mgr.install(bufs[i], p.f + '.zip', { ts: p.f, version: p.v, name: p.n.replace(/_/g, ' ') })));
  return res;
}

/* ---------- Download ---------- */
const DL = process.env.VMM_DOWNLOADS || path.join(os.homedir(), 'Downloads'), dlFile = path.join(DATA, 'downloads.json'), dlCache = new Map(C.readJson(dlFile, []));
function downloads() {
  let names = []; try { names = fs.readdirSync(DL); } catch {}
  const out = [], mods = mgr.scan(), before = dlCache.size;
  for (const f of names) {
    if (!/\.(zip|rar|7z)$/i.test(f)) continue;
    try {
      const full = path.join(DL, f), s = fs.statSync(full), k = f + s.mtimeMs + s.size;
      if (s.size > (C.isNexusName(f) ? 300e6 : 60e6)) continue;
      if (!dlCache.has(k)) {
        let info = null; dlCache.set(k, null); // se è illeggibile non si riprova
        if (/\.zip$/i.test(f)) {
          const files = C.readArchive(fs.readFileSync(full), f);
          if (!files.some(x => /winhttp\.dll$/i.test(x.name))) { const pl = files.filter(x => /\.dll$/i.test(x.name) && x.size < 30e6).flatMap(x => C.inspectDll(x.data()).plugins); if (pl.length) info = { name: pl[0].name, version: pl[0].version, guids: pl.map(p => p.guid) }; }
        } else if (C.isNexusName(f)) info = { ...C.parseName(f), guids: [] };
        dlCache.set(k, info);
      }
      const i = dlCache.get(k); if (!i) continue;
      const have = mods.find(m => m.plugins.some(p => i.guids.includes(p.guid)));
      const rel = have ? C.cmpVer(i.version, have.version) : 1;
      out.push({ file: f, name: i.name, version: i.version, date: s.mtimeMs, size: s.size, state: !have ? 'new' : rel > 0 ? 'update' : 'installed', have: have && have.version });
    } catch {}
  }
  if (dlCache.size !== before) try { fs.writeFileSync(dlFile, JSON.stringify([...dlCache])); } catch {}
  return out.sort((a, b) => b.date - a.date);
}

/* ---------- API ---------- */
const api = {
  async state() {
    const mods = mgr.scan(), ix = idx;
    for (const m of mods) { const p = m.ts && ix && ix.get(m.ts); if (p) { m.url = p.url; m.img = p.i; if (C.cmpVer(p.v, m.version) > 0) m.update = p.v; } else if (m.nexusId) m.url = 'https://www.nexusmods.com/valheim/mods/' + m.nexusId; delete m.iconPath; m.places = undefined; }
    const b = ix && ix.get(C.BEPINEX), bv = mgr.bepinex(), l = mgr.log();
    return { game, running: mgr.isRunning(), bepinex: bv, bepinexUpdate: b && (!bv || bv === 'sconosciuta' || C.cmpVer(b.v, bv) > 0) ? b.v : null, valheim: l && l.valheim, mods, downloads: downloads(), profiles: mgr.profiles(), trash: mgr.listTrash() };
  },
  async refresh() { await index(true); return {}; },
  async browse({ q = '', sort = 'dl', cat = '', page: pg = 0, adult }) {
    const ix = await index(), have = new Map(mgr.scan().filter(m => m.ts).map(m => [m.ts, m.version])), w = q.toLowerCase().split(/\s+/).filter(Boolean);
    let l = [...ix.values()].filter(p => !p.x && (adult || !p.w) && p.f !== C.BEPINEX && !/r2modman|GaleModManager/i.test(p.n) && (!cat || p.c.includes(cat)) && w.every(t => (p.f + ' ' + p.d).toLowerCase().includes(t)));
    const exact = p => w.length && p.n.toLowerCase().replace(/_/g, ' ').startsWith(q.toLowerCase().trim()) ? 1 : 0;
    l.sort((a, b) => exact(b) - exact(a) || (sort === 'u' ? b.u.localeCompare(a.u) : b[sort === 'r' ? 'r' : 'dl'] - a[sort === 'r' ? 'r' : 'dl']));
    const cats = {}; for (const p of ix.values()) if (!p.x) for (const c of p.c) cats[c] = (cats[c] || 0) + 1;
    return { total: l.length, cats: Object.keys(cats).sort(), items: l.slice(pg * 30, pg * 30 + 30).map(p => ({ ...p, have: have.get(p.f) })) };
  },
  async home() {
    const ix = await index(), have = new Map(mgr.scan().filter(m => m.ts).map(m => [m.ts, m.version])), day = 864e5, now = Date.now();
    const ok = [...ix.values()].filter(p => !p.x && !p.w && p.f !== C.BEPINEX && !/r2modman|GaleModManager/i.test(p.n) && !p.c.includes('Libraries') && !p.c.includes('Modpacks'));
    const add = p => ({ ...p, have: have.get(p.f) });
    const hot = ok.filter(p => now - new Date(p.u) < 30 * day).sort((a, b) => b.r - a.r), feat = hot.filter(p => !have.has(p.f)).slice(0, 14);
    const featured = feat[Math.floor(now / day) % (feat.length || 1)]; // cambia ogni giorno
    return { featured: featured && add(featured), trending: hot.filter(p => p !== featured).slice(0, 8).map(add), fresh: ok.filter(p => now - new Date(p.cr) < 21 * day).sort((a, b) => b.cr.localeCompare(a.cr)).slice(0, 8).map(add) };
  },
  async pkg({ full }) { return (await index()).get(full) || {}; },
  async readme({ full, id }) {
    if (id) { const m = mgr.get(id), f = m.places.flatMap(p => mgr.walk(p.path)).find(x => /^readme(\.md|\.txt)?$/i.test(path.basename(x))); return { text: f ? fs.readFileSync(f, 'utf8') : '' }; }
    const p = (await index()).get(full); if (!p) return { text: '' };
    const r = await fetchOk(`https://thunderstore.io/api/experimental/package/${encodeURIComponent(p.o)}/${encodeURIComponent(p.n)}/${encodeURIComponent(p.v)}/readme/`);
    return { text: (await r.json()).markdown || '' };
  },
  async plan({ full }) { const p = await plan(full); return { todo: p.todo.map(x => ({ f: x.f, n: x.n, v: x.v, s: x.s })), missing: p.missing }; },
  async installTs({ full }) { return installTs(full); },
  async updateAll() { await index(); const r = []; for (const m of mgr.scan()) { const p = m.ts && idx.get(m.ts); if (p && C.cmpVer(p.v, m.version) > 0) r.push(...await installTs(m.ts)); } return r; },
  async installDownload({ file }) { if (path.basename(file) !== file) throw err('File non valido.'); return [mgr.install(fs.readFileSync(path.join(DL, file)), file)]; },
  async bepinex() { const p = (await index()).get(C.BEPINEX); if (!p) throw err('BepInEx non trovato.'); mgr.guard(); mgr.installBepInEx(await download(p), p.v); return {}; },
  async toggle({ id, on }) { mgr.setEnabled(id, !!on); return {}; },
  async remove({ id }) { return { trash: mgr.remove(id) }; },
  async restore({ id }) { mgr.restore(id); return {}; },
  async emptyTrash() { mgr.emptyTrash(); return {}; },
  async profSave({ name }) { if (!name || !name.trim() || name.trim() === '__proto__') throw err('Dai un nome al profilo.'); mgr.saveProfile(name.trim()); return {}; },
  async profApply({ name }) { return mgr.applyProfile(name); },
  async profDelete({ name }) { mgr.deleteProfile(name); return {}; },
  async configs() { return mgr.listConfigs(); },
  async config({ file }) { return mgr.readConfig(file); },
  async configSave({ file, changes }) { mgr.writeConfig(file, changes); return {}; },
  async log() { return mgr.log(); },
  async share({ name }) {
    const l = mgr.log(), mods = mgr.scan(), pack = C.makePack(mods, String(name || 'Le mie mod').slice(0, 40), l && l.valheim);
    if (!pack.m.length) throw err('Non hai mod attive da condividere.');
    const link = x => x.t && idx && idx.get(x.t) ? idx.get(x.t).url : x.x ? 'https://www.nexusmods.com/valheim/mods/' + x.x : '';
    return { code: C.encodePack(pack), items: pack.m.map(x => ({ ...x, url: link(x) })), text: pack.m.map(x => `- ${x.n} ${x.v} ${link(x)}`.trim()).join('\n') };
  },
  async packLook({ code }) {
    const pack = C.decodePack(code), ix = await index(), c = C.comparePack(pack, mgr.scan()), l = mgr.log();
    for (const i of c.items) { const p = i.t && ix.get(i.t); i.auto = !!p; i.url = p ? p.url : i.x ? 'https://www.nexusmods.com/valheim/mods/' + i.x : ''; i.img = p ? p.i : ''; }
    return { name: pack.n, valheim: pack.g, mine: l && l.valheim, ...c };
  },
  async packApply({ code, only }) { // Thunderstore da solo, alla versione della lista; Nexus resta a mano
    mgr.guard(); const pack = C.decodePack(code), ix = await index(), warnings = [], out = [];
    if (!mgr.bepinex()) await api.bepinex();
    const todo = C.comparePack(pack, mgr.scan()).items.filter(i => (i.state === 'missing' || i.state === 'version') && ix.get(i.t)), got = [];
    for (const i of todo) {
      let p = ix.get(i.t), b;
      if (/^\d+\.\d+\.\d+$/.test(i.v) && i.v !== p.v) { p = { ...p, v: i.v }; try { b = await download(p); } catch { p = ix.get(i.t); warnings.push(`${i.n}: versione ${i.v} non disponibile, presa la ${p.v}`); } }
      got.push([p, b || await download(p)]);
    }
    for (const [p, b] of got) { const r = mgr.install(b, p.f + '.zip', { ts: p.f, version: p.v, name: p.n.replace(/_/g, ' ') }); out.push(r.name); warnings.push(...r.warnings); }
    for (const i of C.comparePack(pack, mgr.scan()).items) if (i.id) { const m = mgr.get(i.id); if (!m.enabled) mgr.setEnabled(m.id, true); }
    if (only) for (const e of C.comparePack(pack, mgr.scan()).extra) mgr.setEnabled(e.id, false);
    return { installed: out, warnings, left: C.comparePack(pack, mgr.scan()).items.filter(i => i.state !== 'ok').map(i => i.n) };
  },
  async play({ vanilla }) {
    if (mgr.isRunning()) throw err('Valheim è già aperto.');
    const s = steamPath(), exe = s && path.join(s, 'steam.exe'); if (!exe || !fs.existsSync(exe)) throw err('Steam non trovato.');
    spawn(exe, ['-applaunch', '892970', ...(vanilla ? ['--doorstop-enabled', 'false'] : [])], { detached: true, stdio: 'ignore' }).unref(); return {};
  },
  async openFolder() { spawn('explorer.exe', [path.join(mgr.bep, 'plugins')], { detached: true, stdio: 'ignore' }).unref(); return {}; },
};
const READ = new Set(['state', 'refresh', 'browse', 'home', 'pkg', 'readme', 'plan', 'configs', 'config', 'log', 'share', 'packLook']);
let queue = Promise.resolve(), clients = 0, bye = null;
const serial = fn => { const r = queue.then(fn); queue = r.catch(() => {}); return r; };
function body(req, max) { return new Promise((ok, no) => { const c = []; let n = 0; req.on('data', d => { if ((n += d.length) > max) { no(err('File troppo grande.')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); }); }

const srv = http.createServer(async (req, res) => {
  const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  try {
    if (req.headers.host !== '127.0.0.1:' + PORT) return send(403, { error: 'no' });
    const u = new URL(req.url, 'http://127.0.0.1');
    if ((req.headers['x-token'] || u.searchParams.get('t')) !== token) return send(403, { error: 'Finestra scaduta: riapri il mod manager.' });
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https://*.thunderstore.io; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      return res.end(page);
    }
    if (u.pathname === '/live') { clearTimeout(bye); clients++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':ok\n\n'); req.on('close', () => { if (--clients === 0 && !HEADLESS) bye = setTimeout(() => serial(() => process.exit(0)), 12000); }); return; }
    if (!mgr) return send(200, { error: 'Non trovo Valheim nelle librerie di Steam.' });
    if (u.pathname === '/icon') { const m = mgr.get(u.searchParams.get('id')); if (!m.iconPath) return send(404, {}); res.writeHead(200, { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' }); return res.end(fs.readFileSync(m.iconPath)); }
    if (req.method !== 'POST') return send(405, {});
    if (u.pathname === '/upload') { const b = await body(req, 600e6), n = path.basename(u.searchParams.get('name') || 'mod.zip'); return send(200, await serial(() => [mgr.install(b, n)])); }
    const name = u.pathname.slice(5), fn = u.pathname.startsWith('/api/') && Object.hasOwn(api, name) && api[name];
    if (!fn) return send(404, { error: 'no' });
    const arg = JSON.parse((await body(req, 1e6)).toString() || '{}');
    send(200, await (READ.has(name) ? fn(arg) : serial(() => fn(arg))));
  } catch (e) { if (!e.user) console.error(e); if (!res.headersSent) send(400, { error: e.user ? e.message : 'Errore: ' + (e.code || e.message) }); }
});
srv.on('error', e => { if (e.code === 'EADDRINUSE') { const s = C.readJson(stateFile); if (s) openWindow(s.url); process.exit(0); } throw e; });
srv.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?t=${token}`; fs.writeFileSync(stateFile, JSON.stringify({ url }));
  if (!HEADLESS) { openWindow(url); bye = setTimeout(() => process.exit(0), 120000); } // al primo avvio Edge può essere lento
  console.log('Pronto');
});
