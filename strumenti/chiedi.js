'use strict';
// Legge una password dal terminale mostrando solo asterischi.
exports.ask = text => new Promise((ok, no) => {
  const i = process.stdin; if (!i.isTTY) return no(Error('Aprilo da un terminale: serve scrivere la password.'));
  process.stdout.write(text); i.setRawMode(true); i.resume(); i.setEncoding('utf8'); let s = '';
  const end = () => { i.setRawMode(false); i.pause(); i.removeListener('data', on); process.stdout.write('\n'); };
  const on = d => { for (const c of d) { if (c === '\r' || c === '\n') { end(); return ok(s); } if (c === '\u0003') { end(); return no(Error('Annullato.')); } if (c === '\b' || c === '\u007f') { if (s) { s = s.slice(0, -1); process.stdout.write('\b \b'); } } else if (c >= ' ') { s += c; process.stdout.write('*'); } } };
  i.on('data', on);
});
