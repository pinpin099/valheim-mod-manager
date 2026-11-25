# Come modificare il mod manager

Servono [Git](https://git-scm.com) e [Node.js 22](https://nodejs.org). Nessun'altra libreria.

## Proporre una modifica

1. `git clone` del progetto, poi un ramo tuo: `git switch -c nome-modifica`
2. Modifica i file e prova: `node --test`, poi `node start.js`
3. `git commit`, `git push -u origin nome-modifica` e apri una pull request.

Chi gestisce il progetto la legge e la unisce. Non si scrive direttamente su `main`.

## Cosa c'è dentro

| File | A cosa serve |
|---|---|
| `core.js` | Archivi, mod, profili, impostazioni, codice per gli amici |
| `server.js` | Server locale, Thunderstore, cartella Download, avvio del gioco |
| `index.html` | Tutta l'interfaccia |
| `update.js`, `start.js` | Aggiornamenti firmati e ritorno alla versione precedente |
| `test.js`, `update.test.js` | Test su una copia finta del gioco |
| `strumenti/` | Chiave e pubblicazione, solo per chi gestisce il progetto |

Per provare senza toccare il tuo Valheim usa le variabili `VMM_GAME`, `VMM_DATA`, `VMM_DOWNLOADS`, `VMM_PORT`.

## Pubblicare una versione (solo chi gestisce)

1. Una volta sola: `node strumenti/chiave.js`. Copia la chiave privata su una chiavetta: se la perdi, tutti dovranno riscaricare lo zip.
2. Alza `version` in `package.json` e fai il commit.
3. `node strumenti/pubblica.js "Cosa è cambiato"`
4. `git push origin main vX.Y.Z`
5. Su GitHub: **Releases > Draft a new release**, scegli il tag, trascina i due file di `dist`, **Publish**.

`update.js`, `start.js`, la chiave pubblica e `node.exe` non si aggiornano da soli: se cambiano serve uno zip nuovo.
