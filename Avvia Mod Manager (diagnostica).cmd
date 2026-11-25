@echo off
title Valheim Mod Manager - diagnostica
cd /d "%~dp0"
echo Avvio del Valheim Mod Manager in modalita' diagnostica.
echo Usalo solo se "Avvia Mod Manager" non apre niente.
echo Lascia aperta questa finestra: se compare un errore, fai una foto e mandala a chi ti ha dato l'app.
echo.
if not exist "%~dp0node.exe" (
  echo node.exe non trovato: estrai prima tutta la cartella dallo zip.
) else (
  "%~dp0node.exe" server.js
)
echo.
pause
