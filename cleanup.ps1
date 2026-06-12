# Finishes the folder merge. Run from this folder in PowerShell:   .\cleanup.ps1
# It only touches things that are duplicates or generated, and refuses to run unless the legacy archive is present.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "legacy\contracts\FarmLedgerInsurance.sol") -or -not (Test-Path "contracts\FarmLedger.sol")) {
  throw "Archive or merged project not found - nothing was deleted."
}

# 1. old files that were superseded (their copies are in legacy\ and docs\research\)
$stale = @("test\FarmLedgerInsurance.test.js", "scripts\interact.js", "FarmLedger-Insurance-Questionnaire.md", "farmledger.zip")
foreach ($f in $stale) { if (Test-Path $f) { Remove-Item $f -Force; Write-Host "removed $f" } }

# 2. the nested duplicate project and generated/old install folders
foreach ($d in @("farmledger", "artifacts", "cache", "node_modules", "web\node_modules", "web\.next")) {
  if (Test-Path $d) { Remove-Item $d -Recurse -Force; Write-Host "removed $d\" }
}

# 3. fresh install for the merged project
npm install
npm --prefix web install
Write-Host "`nDone. Next: npm test"
