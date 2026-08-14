Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js est requis.' }
if (-not (Test-Path node_modules)) { npm install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
Start-Process 'http://localhost:5173'
npm run dev
