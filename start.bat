@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Afhankelijkheden installeren...
  call npm install
)
start "" http://localhost:4300
npm start
