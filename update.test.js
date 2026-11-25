'use strict';
const test = require('node:test'), A = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), { spawnSync } = require('child_process');
const U = require('./update'), P = require('./strumenti/pubblica');
const K = crypto.generateKeyPairSync('ed25519'), K2 = crypto.generateKeyPairSync('ed25519');
const b = s => Buffer.from(s).toString('base64'), pk = v => JSON.stringify({ version: v, repository: 'tizio/app' });
const files = (v, server = 'nuovo') => ({ 'package.json': b(pk(v)), 'server.js': b(server), 'core.js': b('c'), 'index.html': b('h') });
const up = (v, o = {}, key = K.privateKey) => U.sign({ version: v, files: files(v), ...o }, key);
function mk(v = '1.0.0', server = 'vecchio') {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'vmmup-')), dir = path.join(r, 'app'), data = path.join(r, 'data'); fs.mkdirSync(dir); fs.mkdirSync(data);
  fs.writeFileSync(path.join(dir, 'package.json'), pk(v)); fs.writeFileSync(path.join(dir, 'server.js'), server); fs.writeFileSync(path.join(dir, 'core.js'), 'vc'); fs.writeFileSync(path.join(dir, 'index.html'), 'vh');
  fs.writeFileSync(path.join(dir, 'chiave-pubblica.pem'), K.publicKey.export({ type: 'spki', format: 'pem' }));
  return { dir, data, read: n => fs.readFileSync(path.join(dir, n), 'utf8'), upd: (text, status = 200) => new U.Updater({ dir, data, fetch: async () => new Response(text, { status }) }) };
}
test('versioni', () => { A.ok(U.newer('1.10.0', '1.9.9')); for (const [x, y] of [['1.0.0', '1.0.0'], ['1.0.0', '1.0.1'], ['x', '1.0.0'], ['1.0.0-b', '0.1.0']]) A.ok(!U.newer(x, y)); });
test('aggiorna, conferma, non ripropone', async () => {
  const m = mk(), u = m.upd(up('1.1.0', { notes: 'ciao' })), c = await u.check(); A.equal(c.version, '1.1.0'); A.equal(c.notes, 'ciao');
  A.throws(() => u.apply('9.9.9')); u.apply('1.1.0'); A.equal(m.read('server.js'), 'nuovo'); A.equal(U.current(m.dir), '1.1.0');
  A.equal(U.onStart(m.dir, m.data), 'prova'); A.ok(u.confirm()); A.equal(U.onStart(m.dir, m.data), 'normale'); A.equal((await u.check()).version, undefined);
  A.ok(!fs.readdirSync(m.dir).some(n => n.endsWith('.nuovo')));
});
test('rifiuta firma, chiave, contenuto o nome sbagliati senza scrivere', async () => {
  const m = mk(), tam = JSON.parse(up('1.1.0')), p = Buffer.from(tam.payload, 'base64'); p[20] ^= 1; tam.payload = p.toString('base64');
  const f = n => ({ files: { ...files('1.1.0'), [n]: b('x') } });
  const cases = [JSON.stringify(tam), up('1.1.0', {}, K2.privateKey), '{}', 'null', 'boh', 'x'.repeat(5e6), up('1.1.0', { app: 'altra' }), up('1.1.0', { files: files('1.2.0') }), up('1.1.0', { files: { 'package.json': b(pk('1.1.0')) } }),
    ...['../x.js', 'a/b.js', 'C:\\x.js', 'node.exe', 'x.dll', 'start.js', 'UPDATE.js', 'Chiave-pubblica.pem', 'SERVER.JS', '.git.js'].map(n => up('1.1.0', f(n)))];
  for (const t of cases) await A.rejects(m.upd(t).check(), e => e.user, t.slice(0, 60));
  A.equal(m.read('server.js'), 'vecchio'); A.ok(!fs.existsSync(path.join(m.dir, '..', 'x.js')));
});
test('niente versioni vecchie, Release assente, Node troppo nuovo, senza chiave', async () => {
  const m = mk('2.0.0'); A.equal((await m.upd(up('1.9.0')).check()).version, undefined); A.equal((await m.upd(up('2.0.0')).check()).version, undefined);
  A.equal((await m.upd('', 404).check()).active, true); await A.rejects(m.upd('', 500).check(), /500/);
  const u = m.upd(up('2.1.0', { node: '99.0.0' })); A.ok((await u.check()).zip); A.throws(() => u.apply('2.1.0'));
  fs.rmSync(path.join(m.dir, 'chiave-pubblica.pem')); A.equal((await m.upd(up('2.1.0')).check()).active, false);
});
test('torna indietro e non ripropone la versione rotta', async () => {
  const m = mk(), t = U.sign({ version: '1.1.0', files: { ...files('1.1.0'), 'extra.js': b('e') } }, K.privateKey), u = m.upd(t); await u.check(); u.apply('1.1.0');
  A.deepEqual([1, 2, 3].map(() => U.onStart(m.dir, m.data)), ['prova', 'prova', 'indietro']); A.equal(m.read('server.js'), 'vecchio'); A.equal(U.current(m.dir), '1.0.0'); A.ok(!fs.existsSync(path.join(m.dir, 'extra.js')));
  A.equal((await u.check()).failed, '1.1.0'); A.equal((await m.upd(up('1.1.1')).check()).version, '1.1.1');
});
test('start.js: versione che si rompe subito torna alla precedente', async () => {
  const log = n => `require('fs').appendFileSync(process.env.VMM_DATA+'/log','${n} ');`, m = mk('1.0.0', log('vecchia')), u = m.upd(U.sign({ version: '1.1.0', files: files('1.1.0', log('rotta') + 'process.exit(1)') }, K.privateKey));
  for (const n of ['start.js', 'update.js']) fs.copyFileSync(path.join(__dirname, n), path.join(m.dir, n));
  await u.check(); u.apply('1.1.0'); const r = spawnSync(process.execPath, [path.join(m.dir, 'start.js')], { env: { ...process.env, VMM_DATA: m.data }, timeout: 20000 });
  A.equal(r.status, 0); A.equal(fs.readFileSync(path.join(m.data, 'log'), 'utf8'), 'rotta vecchia '); A.equal(U.current(m.dir), '1.0.0');
});
test('start.js: dopo un aggiornamento (uscita 75) riparte con la versione nuova', async () => {
  const m = mk('1.0.0', "require('fs').appendFileSync(process.env.VMM_DATA+'/log','vecchia ');const U=require('./update');const k=require('fs').readFileSync(process.env.VMM_DATA+'/up','utf8');const u=new U.Updater({dir:__dirname,data:process.env.VMM_DATA,fetch:async()=>new Response(k)});u.check().then(c=>{u.apply(c.version);process.exit(75)})");
  fs.writeFileSync(path.join(m.data, 'up'), up('1.1.0', { files: files('1.1.0', "require('fs').appendFileSync(process.env.VMM_DATA+'/log','nuova');") }));
  for (const n of ['start.js', 'update.js']) fs.copyFileSync(path.join(__dirname, n), path.join(m.dir, n));
  const r = spawnSync(process.execPath, [path.join(m.dir, 'start.js')], { env: { ...process.env, VMM_DATA: m.data }, timeout: 20000 });
  A.equal(r.status, 0); A.equal(fs.readFileSync(path.join(m.data, 'log'), 'utf8'), 'vecchia nuova'); A.equal(U.current(m.dir), '1.1.0');
});
test('pubblicazione: il pacchetto vero si verifica e non manca nessun file', () => {
  A.deepEqual(P.missing(__dirname), []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmmpub-')); for (const n of P.APP_FILES) if (fs.existsSync(path.join(__dirname, n))) fs.copyFileSync(path.join(__dirname, n), path.join(root, n));
  const r = P.build({ root, notes: 'n', key: K.privateKey, date: '2026-11-25', node: '22.0.0' }), v = U.verify(r.text, K.publicKey);
  A.equal(v.version, r.version); A.equal(Buffer.compare(v.files['server.js'], fs.readFileSync(path.join(__dirname, 'server.js'))), 0); A.ok(r.text.length < 1e6);
});
