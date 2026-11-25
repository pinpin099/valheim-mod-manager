'use strict';
// Avvio: se un aggiornamento non parte, rimette la versione precedente e riprova una volta.
const path = require('path'), os = require('os'), fs = require('fs'), { spawn } = require('child_process');
const U = require('./update');
const DATA = process.env.VMM_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'ValheimModManager');
fs.mkdirSync(DATA, { recursive: true });
const RESTART = 75; // server.js esce con 75 quando ha appena applicato un aggiornamento
let state = U.onStart(__dirname, DATA);
function run() {
  const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, stdio: 'inherit', windowsHide: true });
  p.on('exit', code => {
    if (code === RESTART) { state = U.onStart(__dirname, DATA); return run(); }
    if (code && state === 'prova' && U.rollback(__dirname, DATA)) { state = 'indietro'; return run(); }
    process.exit(code || 0);
  });
}
run();
