'use strict';
// node test.js  — lavora solo su una copia finta del gioco nella cartella temporanea
const test = require('node:test'), A = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const C = require('./core');
const ser = s => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]);
const blob = b => Buffer.concat([Buffer.from(b.length < 128 ? [b.length] : [0x80 | b.length >> 8, b.length & 255]), b]);
const dll = (guid, ver, deps = []) => Buffer.concat([Buffer.from('MZ....'), blob(Buffer.concat([Buffer.from([1, 0]), ser(guid), ser('N ' + guid), ser(ver), Buffer.from([0, 0])])), ...deps.map(d => blob(Buffer.concat([Buffer.from([1, 0]), ser(d), Buffer.from([1, 0, 0, 0, 0, 0])])))]);
function zip(files) {
  const L = [], D = []; let off = 0, n = 0;
  for (const [name, c] of Object.entries(files)) {
    const raw = Buffer.from(c), z = zlib.deflateRawSync(raw), nm = Buffer.from(name), h = Buffer.alloc(30), d = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(8, 8); h.writeUInt32LE(zlib.crc32(raw), 14); h.writeUInt32LE(z.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nm.length, 26);
    d.writeUInt32LE(0x02014b50); d.writeUInt16LE(8, 10); d.writeUInt32LE(zlib.crc32(raw), 16); d.writeUInt32LE(z.length, 20); d.writeUInt32LE(raw.length, 24); d.writeUInt16LE(nm.length, 28); d.writeUInt32LE(off, 42);
    L.push(h, nm, z); D.push(d, nm); off += 30 + nm.length + z.length; n++;
  }
  const cd = Buffer.concat(D), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50); e.writeUInt16LE(n, 8); e.writeUInt16LE(n, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...L, cd, e]);
}
function mk() {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'vmmtest-')); for (const d of ['core', 'plugins', 'config']) fs.mkdirSync(path.join(g, 'BepInEx', d), { recursive: true });
  const m = new C.Manager(g); m.isRunning = () => false; return m;
}
const has = (m, p) => fs.existsSync(path.join(m.game, 'BepInEx', p));

test('nomi Nexus', () => {
  A.deepEqual(C.parseName('HotAirBalloons 4169 1.5.0 2026-10-22T20-23Z qdWkj7Sej.zip'), { name: 'HotAirBalloons', nexusId: 4169, version: '1.5.0' });
  A.equal(C.parseName('Bigger Minimap Discovery Radius 4.11.1.0-210-4-11-1-0-1730469651.zip').nexusId, 210);
  A.ok(C.cmpVer('1.10.0', '1.9.9') > 0);
});
test('installa, spegne, accende, rimuove, ripristina', () => {
  const m = mk(); m.install(zip({ 'Foo/plugins/Foo.dll': dll('a.foo', '1.0.0'), 'Foo/config/a.foo.cfg': 'x', 'Foo/patchers/P.dll': 'p' }), 'Foo-12-1-0-1730469651.zip');
  A.ok(has(m, 'plugins/Foo/Foo.dll') && has(m, 'patchers/Foo/P.dll') && has(m, 'config/a.foo.cfg'));
  let [x] = m.scan(); A.equal(x.version, '1.0.0'); A.equal(x.nexusId, 12);
  m.setEnabled(x.id, false); A.ok(!has(m, 'plugins/Foo') && !has(m, 'patchers/Foo'));
  [x] = m.scan(); A.equal(x.enabled, false); m.setEnabled(x.id, true);
  const t = m.remove(m.scan()[0].id); A.equal(m.scan().length, 0); m.restore(t); A.ok(has(m, 'plugins/Foo/Foo.dll')); A.equal(m.listTrash().length, 0);
});
test('aggiornamento sostituisce per GUID, conserva config e stato spento', () => {
  const m = mk(); fs.writeFileSync(path.join(m.bep, 'plugins', 'Old.dll'), dll('a.foo', '1.0.0')); fs.writeFileSync(path.join(m.bep, 'config', 'a.foo.cfg'), 'mio');
  m.setEnabled(m.scan()[0].id, false);
  m.install(zip({ 'BepInEx/plugins/Foo/Foo.dll': dll('a.foo', '2.0.0'), 'BepInEx/config/a.foo.cfg': 'nuovo' }), 'x.zip', { ts: 'O-Foo', version: '2.0.0' });
  const s = m.scan(); A.equal(s.length, 1); A.equal(s[0].version, '2.0.0'); A.equal(s[0].enabled, false); A.equal(m.listTrash().length, 1);
  A.equal(fs.readFileSync(path.join(m.bep, 'config', 'a.foo.cfg'), 'utf8'), 'mio');
});
test('archivi pericolosi o sbagliati rifiutati senza lasciare tracce', () => {
  const m = mk();
  for (const n of ['../x.dll', 'a/../../x.dll', '/x.dll', 'C:/x.dll', '..\\..\\x.dll']) A.throws(() => m.install(zip({ [n]: 'x' }), 'a.zip'), /non sicuro/);
  A.throws(() => m.install(zip({ 'w.fwl': 'x', 'w.db': 'y' }), 'a.zip'), /mondo/); A.throws(() => m.install(Buffer.from('PKboh'), 'a.zip'));
  const bad = zip({ 'a.dll': Buffer.from('ciao') }); bad.writeUInt32LE(1, bad.indexOf('PK\x01\x02', 0, 'latin1') + 16); A.throws(() => m.install(bad, 'a.zip'), /danneggiato/);
  A.equal(m.scan().length, 0); A.ok(!fs.existsSync(path.join(m.game, 'x.dll')));
});
test('conflitto con pacchetto multi-plugin', () => {
  const m = mk(); fs.mkdirSync(path.join(m.bep, 'plugins', 'Pack')); fs.writeFileSync(path.join(m.bep, 'plugins', 'Pack', 'a.dll'), dll('a', '1.0')); fs.writeFileSync(path.join(m.bep, 'plugins', 'Pack', 'b.dll'), dll('b', '1.0'));
  A.throws(() => m.install(zip({ 'a.dll': dll('a', '2.0') }), 'a.zip'), /Conflitto/); A.equal(m.scan()[0].plugins.length, 2);
});
test('dipendenze mancanti, spente e doppioni', () => {
  const m = mk(); m.install(zip({ 'a.dll': dll('a.a', '1.0', ['com.jotunn.jotunn']) }), 'a.zip');
  A.equal(m.scan()[0].issues[0].ts, 'ValheimModding-Jotunn');
  m.install(zip({ 'j.dll': dll('com.jotunn.jotunn', '2.0') }), 'j.zip'); A.equal(m.scan().flatMap(x => x.issues).length, 0);
  m.setEnabled(m.scan().find(x => x.entry === 'j').id, false); A.ok(m.scan().find(x => x.entry === 'a').issues[0].disabledId);
  fs.writeFileSync(path.join(m.bep, 'plugins', 'copy.dll'), dll('a.a', '1.0')); A.ok(m.scan().some(x => x.issues.some(i => i.type === 'dup')));
});
test('profili', () => {
  const m = mk(); m.install(zip({ 'a.dll': dll('a', '1.0') }), 'a.zip'); m.saveProfile('p'); m.install(zip({ 'b.dll': dll('b', '1.0') }), 'b.zip');
  m.applyProfile('p'); A.deepEqual(m.scan().filter(x => x.enabled).map(x => x.entry), ['a']);
  m.install(zip({ 'a.dll': dll('a', '2.0') }), 'x.zip', { ts: 'O-A', version: '2.0.0' }); A.deepEqual(m.applyProfile('p').missing, []); A.equal(m.scan().find(x => x.entry === 'O-A').enabled, true);
});
test('config: cambia solo la riga giusta', () => {
  const m = mk(), f = path.join(m.bep, 'config', 'c.cfg'); fs.writeFileSync(f, '[A]\r\n\r\n## Descr\r\n# Setting type: Boolean\r\n# Default value: true\r\nOn = true\r\n[B]\r\nOn = true\r\n');
  A.equal(m.readConfig('c.cfg')[0].type, 'Boolean'); m.writeConfig('c.cfg', [{ section: 'B', key: 'On', value: 'false' }]);
  A.equal(fs.readFileSync(f, 'utf8'), '[A]\r\n\r\n## Descr\r\n# Setting type: Boolean\r\n# Default value: true\r\nOn = true\r\n[B]\r\nOn = false\r\n');
  A.throws(() => m.readConfig('../../x.cfg'));
});
test('gioco aperto blocca le modifiche', () => { const m = mk(); m.isRunning = () => true; A.throws(() => m.install(zip({ 'a.dll': 'x' }), 'a.zip'), /aperto/); });
test('codice per gli amici', () => {
  const a = mk(), b = mk();
  a.install(zip({ 'a.dll': dll('a', '1.2.0') }), 'a.zip', { ts: 'Own-A', version: '1.2.0' }); a.install(zip({ 'b.dll': dll('b', '1.0') }), 'B-77-1-0-1730469651.zip');
  a.install(zip({ 'c.dll': dll('c', '1.0') }), 'c.zip'); a.setEnabled(a.scan().find(m => m.entry === 'c').id, false);
  const code = C.encodePack(C.makePack(a.scan(), 'Server', '1.0')), p = C.decodePack('ciao ecco: ' + code + '\n');
  A.deepEqual(p.m.map(x => x.t || x.x), ['Own-A', 77]); A.ok(!code.includes(a.game));
  A.deepEqual(C.comparePack(p, b.scan()).items.map(i => i.state), ['missing', 'missing']);
  b.install(zip({ 'a.dll': dll('a', '1.0.0') }), 'a.zip'); b.install(zip({ 'b.dll': dll('b', '1.0') }), 'b.zip'); b.install(zip({ 'z.dll': dll('z', '1.0') }), 'z.zip'); b.setEnabled(b.scan().find(m => m.entry === 'b').id, false);
  const c = C.comparePack(p, b.scan()); A.deepEqual(c.items.map(i => i.state), ['version', 'off']); A.deepEqual(c.extra.map(e => e.name), ['N z']);
});
test('codici malevoli', () => {
  for (const x of ['', 'boh', 'VALHEIM-MOD:AAAA', C.encodePack({ v: 1, m: [] }), C.encodePack({ v: 1, m: Array(400).fill({}) })]) A.throws(() => C.decodePack(x), /non valido/);
  const p = C.decodePack(C.encodePack({ v: 1, n: 5, m: [{ n: 'x', v: '../1', t: '../../evil', x: 'javascript:1', g: 'no' }, null] }));
  A.deepEqual(p.m[0], { n: 'x', v: '', t: '', x: 0, g: [] }); A.equal(p.m[1].n, 'Mod');
});
const { execFileSync } = require('child_process');
const TAR = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');
test('un file di altra origine non sostituisce una mod nota senza conferma', () => {
  const m = mk(), j = dll('com.jotunn.jotunn', '2.0.0'), bad = zip({ 'Innocua.dll': dll('com.jotunn.jotunn', '9.0.0') });
  m.install(zip({ 'plugins/Jotunn.dll': j }), 'j.zip', { ts: 'ValheimModding-Jotunn', version: '2.0.0' });
  for (const [b, n] of [[bad, 'Innocua.zip'], [dll('com.jotunn.jotunn', '9.0.0'), 'Jotunn.dll']]) A.throws(() => m.install(b, n), e => e.confirm && /Thunderstore/.test(e.message));
  A.equal(m.scan()[0].version, '2.0.0'); A.equal(m.listTrash().length, 0);
  m.install(zip({ 'plugins/Jotunn.dll': dll('com.jotunn.jotunn', '2.1.0') }), 'j.zip', { ts: 'ValheimModding-Jotunn', version: '2.1.0' }); // stessa origine: nessuna domanda
  m.install(bad, 'Innocua.zip', { confirm: true }); const [x] = m.scan(); A.equal(x.version, '9.0.0'); A.equal(x.ts, null); A.equal(m.listTrash().length, 2);
});
test('stessa mod Nexus si aggiorna senza domande', () => {
  const m = mk(); m.install(zip({ 'b.dll': dll('b', '1.0') }), 'B-77-1-0-1730469651.zip'); m.install(zip({ 'b.dll': dll('b', '1.1') }), 'B-77-1-1-1730469999.zip'); A.equal(m.scan()[0].version, '1.1');
  A.throws(() => m.install(zip({ 'b.dll': dll('b', '1.2') }), 'x.zip'), e => e.confirm);
});
test('archivi bomba fermati', { skip: !fs.existsSync(TAR) }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vmmtest-')); fs.writeFileSync(path.join(d, 'z.dll'), Buffer.alloc(300e6));
  execFileSync(TAR, ['--format', '7zip', '-cf', path.join(d, 'b.7z'), '-C', d, 'z.dll']);
  A.throws(() => C.readArchive(fs.readFileSync(path.join(d, 'b.7z')), 'b.7z'), /si espande troppo/);
  const z = zip({ 'a.dll': Buffer.alloc(150e6) }); A.throws(() => C.readArchive(z, 'a.zip'), /si espande troppo/);
  fs.writeFileSync(path.join(d, 'ok.dll'), dll('ok', '1.0')); execFileSync(TAR, ['--format', '7zip', '-cf', path.join(d, 'ok.7z'), '-C', d, 'ok.dll']);
  const m = mk(); m.install(fs.readFileSync(path.join(d, 'ok.7z')), 'ok.7z'); A.equal(m.scan()[0].name, 'N ok'); fs.rmSync(d, { recursive: true });
});
test('zip dentro lo zip, BepInEx in profondità, cfg sciolto, BepInEx nel pacchetto', () => {
  const m = mk(); m.install(zip({ 'leggimi.txt': 'x', 'Mod.zip': zip({ 'Cartella/BepInEx/plugins/Foo/Foo.dll': dll('f', '1.0'), 'f.cfg': 'a=1', 'winhttp.dll': 'x', 'BepInEx/core/BepInEx.dll': 'x' }) }), 'x.zip');
  A.ok(has(m, 'config/f.cfg')); A.equal(m.scan().length, 1); A.ok(!fs.existsSync(path.join(m.game, 'winhttp.dll'))); A.ok(!has(m, 'core/BepInEx.dll'));
  A.throws(() => m.install(zip({ 'winhttp.dll': 'x', 'BepInEx/core/BepInEx.dll': 'x' }), 'b.zip'), /Questo è BepInEx/);
  for (const n of ['a/BepInEx/../../x.dll', 'BepInEx/config/../../x.cfg']) A.throws(() => m.install(zip({ [n]: 'x' }), 'a.zip'), /non sicuro/);
});
test('registro: versione di Valheim e dati personali nascosti', () => {
  const m = mk(); fs.writeFileSync(path.join(m.bep, 'LogOutput.log'), '[Message:   BepInEx] User is running BepInExPack Valheim version 5.4.2360\n[Info   :   BepInEx] Loading [A 1.0]\n[Message:   BepInEx] Valheim Version: 1.0.21\n[Error  : X] C:\\Users\\Mario Rossi\\a 76561198000000000 10.1.2.3:2456 C:/Users/Mario/b\n');
  const l = m.log(); A.equal(l.valheim, '1.0.21'); A.equal(l.loaded, 1); A.ok(!/Mario|7656|10\.1/.test(l.tail + l.lines)); A.ok(l.lines[0].includes('[SteamID]'));
});
