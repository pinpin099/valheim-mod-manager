'use strict';
// node strumenti/pubblica.js "Cosa è cambiato" — prepara dist/update.json (firmato) e dist/Valheim-Mod-Manager.zip.
// Non carica nulla: i due file si trascinano in una nuova Release su GitHub.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { execFileSync } = require('child_process');
const U = require('../update'), ROOT = path.join(__dirname, '..'), DIST = path.join(ROOT, 'dist');
const APP_FILES = ['package.json', 'start.js', 'update.js', 'chiave-pubblica.pem', 'server.js', 'core.js', 'estrai.js', 'index.html', 'LEGGIMI.txt', 'LICENZA-NODE.txt', 'Avvia Mod Manager.vbs', 'Avvia Mod Manager (diagnostica).cmd'];

// I file dell'app, com'è la cartella adesso. Se se ne aggiunge uno nuovo, va messo anche in APP_FILES.
function build({ root, notes, key, date, node }) {
  const pk = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))), files = {};
  for (const n of APP_FILES) if (!U.FIXED.has(n)) files[n] = fs.readFileSync(path.join(root, n)).toString('base64');
  return { version: pk.version, text: U.sign({ version: pk.version, notes, date, node, files }, key) };
}
// Ogni require('./x') dell'app deve essere tra i file pubblicati, altrimenti agli amici non parte.
function missing(root) {
  return APP_FILES.filter(n => n.endsWith('.js')).flatMap(n => [...fs.readFileSync(path.join(root, n), 'utf8').matchAll(/require\(['"]\.\/([\w-]+)(?:\.js)?['"]\)/g)].map(m => m[1] + '.js')).filter(n => !APP_FILES.includes(n));
}
module.exports = { build, missing, APP_FILES };

if (require.main === module) (async () => {
  const notes = process.argv[2], git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!notes) throw Error('Scrivi cosa è cambiato: node strumenti/pubblica.js "Aggiunta la pagina X"');
  const v = U.current(ROOT);
  if (git('status', '--porcelain')) throw Error('Ci sono modifiche non salvate in Git: fai prima il commit.');
  const tags = git('tag', '-l', 'v*').split('\n').filter(Boolean).map(t => t.slice(1));
  if (tags.some(t => t === v || U.newer(t, v))) throw Error(`La versione ${v} è già uscita o è vecchia: alza "version" in package.json.`);
  const m = missing(ROOT); if (m.length) throw Error('Mancano in APP_FILES: ' + m.join(', '));
  execFileSync(process.execPath, ['--test'], { cwd: ROOT, stdio: 'ignore' }); console.log('Test a posto.');
  const { ask } = require('./chiedi'), priv = path.join(os.homedir(), '.valheim-mod-manager', 'chiave-privata.pem');
  if (!fs.existsSync(priv)) throw Error('Manca la chiave: node strumenti/chiave.js');
  const pass = await ask('Password della chiave: ');
  let key; try { key = crypto.createPrivateKey({ key: fs.readFileSync(priv), passphrase: pass }); } catch { throw Error('Password sbagliata.'); }
  const r = build({ root: ROOT, notes, key, date: new Date().toISOString().slice(0, 10), node: '22.0.0' });
  U.verify(r.text, crypto.createPublicKey(fs.readFileSync(path.join(ROOT, 'chiave-pubblica.pem'))));
  fs.rmSync(DIST, { recursive: true, force: true }); const stage = path.join(DIST, 'tmp', 'Valheim Mod Manager'); fs.mkdirSync(stage, { recursive: true });
  for (const n of APP_FILES) fs.copyFileSync(path.join(ROOT, n), path.join(stage, n));
  fs.copyFileSync(process.execPath, path.join(stage, 'node.exe'));
  const zip = path.join(DIST, 'Valheim-Mod-Manager.zip');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', path.join(DIST, 'tmp'), 'Valheim Mod Manager']);
  fs.rmSync(path.join(DIST, 'tmp'), { recursive: true, force: true }); fs.writeFileSync(path.join(DIST, 'update.json'), r.text);
  git('tag', 'v' + v);
  console.log(`\nPronta la ${v} in dist:\n  update.json\n  Valheim-Mod-Manager.zip  SHA-256 ${crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')}\n\nOra: git push origin main v${v}\nPoi su GitHub: Releases > Draft a new release > v${v}, trascina i due file, Publish.`);
})().catch(e => { console.error(e.message); process.exit(1); });
