'use strict';
// node strumenti/chiave.js — una volta sola: crea la chiave con cui si firmano gli aggiornamenti.
// La chiave privata resta fuori dal progetto e protetta da password; quella pubblica va nell'app.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { ask } = require('./chiedi');
const priv = path.join(os.homedir(), '.valheim-mod-manager', 'chiave-privata.pem'), pub = path.join(__dirname, '..', 'chiave-pubblica.pem');
(async () => {
  if (fs.existsSync(priv) || fs.existsSync(pub)) throw Error('Esiste già una chiave. Se la cambi, tutti dovranno riscaricare lo zip: non la sostituisco.');
  const a = await ask('Scegli una password per la chiave (almeno 10 caratteri): ');
  if (a.length < 10) throw Error('Password troppo corta.');
  if (await ask('Ripetila: ') !== a) throw Error('Le password non sono uguali.');
  const k = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: a } });
  fs.mkdirSync(path.dirname(priv), { recursive: true });
  fs.writeFileSync(priv, k.privateKey, { flag: 'wx', mode: 0o600 }); fs.writeFileSync(pub, k.publicKey, { flag: 'wx' });
  console.log('\nFatto.\nPrivata (non mandarla a nessuno, fanne una copia su una chiavetta):\n  ' + priv + '\nPubblica (va nel progetto):\n  ' + pub);
})().catch(e => { console.error(e.message); process.exit(1); });
