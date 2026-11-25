'use strict';
// Aggiornamenti dell'app: un solo file firmato (update.json), scaricato dall'ultima Release di GitHub.
// Senza una firma valida fatta con la chiave di chi pubblica non viene scritto nulla.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const APP = 'valheim-mod-manager', MAX = 4e6;
const OK = /^[A-Za-z0-9][A-Za-z0-9 _-]*\.(js|json|html|css|txt|vbs|pem)$/; // solo file nella cartella dell'app, mai sottocartelle
const FIXED = new Set(['start.js', 'update.js', 'chiave-pubblica.pem']);   // avvio, controllo e chiave cambiano solo con uno zip nuovo
const NEED = ['package.json', 'server.js', 'core.js', 'index.html'];
const bad = m => Object.assign(new Error(m), { user: true });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const ver = v => /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v) ? v.split('.').map(Number) : null;
function newer(a, b) { const x = ver(a), y = ver(b); if (!x || !y) return false; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const current = dir => (readJson(path.join(dir, 'package.json')) || {}).version || '0.0.0';

function sign(info, privateKey) {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ app: APP, ...info })));
  return JSON.stringify({ payload: payload.toString('base64'), sig: crypto.sign(null, payload, privateKey).toString('base64') });
}
function verify(text, publicKey) {
  if (text.length > MAX) throw bad('Aggiornamento troppo grande.');
  let o; try { o = JSON.parse(text); } catch { throw bad('Aggiornamento non valido.'); }
  if (!o || typeof o.payload !== 'string' || typeof o.sig !== 'string') throw bad('Aggiornamento non valido.');
  const p = Buffer.from(o.payload, 'base64');
  if (!crypto.verify(null, p, publicKey, Buffer.from(o.sig, 'base64'))) throw bad('Firma non valida: aggiornamento rifiutato.');
  let u; try { u = JSON.parse(zlib.gunzipSync(p, { maxOutputLength: MAX * 2 })); } catch { throw bad('Aggiornamento non valido.'); }
  if (u.app !== APP || !ver(u.version) || !u.files || typeof u.files !== 'object') throw bad('Aggiornamento non valido.');
  const files = {}, seen = new Set();
  for (const [n, c] of Object.entries(u.files)) {
    if (!OK.test(n) || FIXED.has(n.toLowerCase()) || seen.has(n.toLowerCase()) || typeof c !== 'string') throw bad('Aggiornamento non valido: file ' + n);
    seen.add(n.toLowerCase()); files[n] = Buffer.from(c, 'base64');
  }
  for (const n of NEED) if (!files[n]) throw bad('Aggiornamento incompleto: manca ' + n);
  let pk; try { pk = JSON.parse(files['package.json']); } catch { throw bad('Aggiornamento non valido.'); }
  if (pk.version !== u.version) throw bad('Aggiornamento non valido: versioni diverse.');
  return { version: u.version, notes: String(u.notes || '').slice(0, 2000), date: String(u.date || '').slice(0, 10), node: ver(u.node) ? u.node : '', files };
}

class Updater {
  constructor({ dir, data, url, fetch: f }) {
    this.dir = dir; this.data = data; this.fetch = f || fetch; this.mark = path.join(data, 'aggiornamento.json');
    const repo = (readJson(path.join(dir, 'package.json')) || {}).repository || '';
    this.url = url || (/^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}/releases/latest/download/update.json` : '');
    try { this.key = crypto.createPublicKey(fs.readFileSync(path.join(dir, 'chiave-pubblica.pem'))); } catch { this.key = null; }
    this.ready = null;
  }
  get active() { return !!(this.url && this.key); }
  async check() {
    this.ready = null; const cur = current(this.dir);
    if (!this.active) return { active: false, current: cur };
    let r; try { r = await this.fetch(this.url, { signal: AbortSignal.timeout(15000) }); } catch { throw bad('GitHub non risponde: controlla la connessione.'); }
    if (r.status === 404) return { active: true, current: cur };
    if (!r.ok) throw bad('GitHub ha risposto con errore ' + r.status);
    if (+r.headers.get('content-length') > MAX) throw bad('Aggiornamento troppo grande.');
    const u = verify(await r.text(), this.key);
    if (!newer(u.version, cur)) return { active: true, current: cur };
    if (u.node && newer(u.node, process.versions.node)) return { active: true, current: cur, version: u.version, notes: u.notes, zip: true };
    const m = readJson(this.mark); // una versione che non è partita non viene riproposta
    if (m && m.failed === u.version) return { active: true, current: cur, failed: u.version };
    this.ready = u; return { active: true, current: cur, version: u.version, notes: u.notes, date: u.date };
  }
  // Copia di sicurezza, poi sostituzione. start.js torna indietro se la versione nuova non conferma l'avvio.
  apply(version) {
    const u = this.ready; if (!u || u.version !== version) throw bad('Controlla di nuovo gli aggiornamenti.');
    const from = current(this.dir), back = path.join(this.data, 'versione-precedente');
    const old = Object.keys(u.files).filter(n => fs.existsSync(path.join(this.dir, n))), added = Object.keys(u.files).filter(n => !old.includes(n));
    fs.rmSync(back, { recursive: true, force: true }); fs.mkdirSync(back, { recursive: true });
    for (const n of old) fs.copyFileSync(path.join(this.dir, n), path.join(back, n));
    try { for (const [n, b] of Object.entries(u.files)) { const t = path.join(this.dir, n + '.nuovo'); fs.writeFileSync(t, b); if (sha(fs.readFileSync(t)) !== sha(b)) throw bad('Scrittura non riuscita.'); } }
    catch (e) { for (const n of Object.keys(u.files)) fs.rmSync(path.join(this.dir, n + '.nuovo'), { force: true }); throw bad('Non riesco a scrivere nella cartella dell’app: ' + e.message); }
    fs.writeFileSync(this.mark, JSON.stringify({ from, to: u.version, old, added, tries: 0 }));
    try { for (const n of Object.keys(u.files)) fs.renameSync(path.join(this.dir, n + '.nuovo'), path.join(this.dir, n)); }
    catch (e) { rollback(this.dir, this.data); for (const n of Object.keys(u.files)) fs.rmSync(path.join(this.dir, n + '.nuovo'), { force: true }); throw bad('Aggiornamento annullato: ' + e.message); }
    this.ready = null; return { from, to: u.version };
  }
  confirm() { const m = readJson(this.mark); if (!m || m.to !== current(this.dir)) return false; fs.rmSync(this.mark, { force: true }); return true; } // la finestra si è aperta: va bene
}
function rollback(dir, data) {
  const mark = path.join(data, 'aggiornamento.json'), m = readJson(mark), back = path.join(data, 'versione-precedente');
  if (!m || !m.to || !Array.isArray(m.old) || !Array.isArray(m.added)) return false;
  if (!m.old.every(n => OK.test(n) && fs.existsSync(path.join(back, n)))) return false; // copia incompleta: meglio non toccare nulla
  for (const n of m.old) fs.copyFileSync(path.join(back, n), path.join(dir, n));
  for (const n of m.added) if (OK.test(n) && !FIXED.has(n)) fs.rmSync(path.join(dir, n), { force: true });
  fs.writeFileSync(mark, JSON.stringify({ failed: m.to })); return true;
}
// Chiamata da start.js a ogni avvio. Due avvii senza conferma dopo un aggiornamento: torna indietro.
function onStart(dir, data) {
  const mark = path.join(data, 'aggiornamento.json'), m = readJson(mark);
  if (!m || !m.to) return 'normale';
  if (m.tries >= 2) return rollback(dir, data) ? 'indietro' : 'normale';
  fs.writeFileSync(mark, JSON.stringify({ ...m, tries: (m.tries || 0) + 1 })); return 'prova';
}
module.exports = { APP, FIXED, OK, NEED, sign, verify, newer, current, Updater, rollback, onStart };
