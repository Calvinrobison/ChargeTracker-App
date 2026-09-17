<#
.SYNOPSIS
  Proves that upgrading from one installed version to another preserves history.

.DESCRIPTION
  Installs version A, opens its database (so a real history file exists),
  fingerprints that file, installs version B over it, and checks that:

    * B's install succeeded per-user with no elevation;
    * B opens the SAME database file rather than creating a new one — proven by
      the file's creation timestamp surviving the upgrade;
    * the schema is at or above A's, and every migration A applied is still
      recorded;
    * `PRAGMA integrity_check` returns ok and there are no foreign key
      violations after the upgrade;
    * nothing that existed before the upgrade was lost.

  WHAT THIS DOES NOT PROVE, and does not claim to:

    * That the in-app updater discovers and accepts a published release. That
      needs a real GitHub release and a client reaching it over the network;
      it cannot be simulated here without publishing something. The signature
      and claim checks that gate it are covered by the specs in
      tests/nodeps/release-manifest.test.ts, and end-to-end discovery is a
      manual step in docs/RELEASING.md.
    * That an upgrade preserves OBSERVATIONS specifically. This test seeds no
      synthetic observations, because a fabricated observation row is exactly
      what this project refuses to create — even in a sandbox, even for a test.
      Until a source is cleared for collection, the strongest honest claim is
      the one made above: the file is migrated in place, not replaced, and its
      contents survive. Re-run this test with a genuinely populated history
      file (-ExistingHistory) once collection is running to close that gap.

.PARAMETER OldInstaller
  The installer for version A. Defaults to the second-newest *Setup*.exe under
  .\release, which is only correct if you deliberately put one there.

.PARAMETER NewInstaller
  The installer for version B. Defaults to the newest *Setup*.exe under .\release.

.PARAMETER ExistingHistory
  Optional path to a real chargewatch.sqlite to upgrade instead of a fresh one.
  A COPY is used; the original is never touched.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\test-update.ps1 `
    -OldInstaller .\release\ChargeWatch-Setup-0.1.0.exe `
    -NewInstaller .\release\ChargeWatch-Setup-0.1.1.exe
#>

[CmdletBinding()]
param(
  [string] $OldInstaller,
  [string] $NewInstaller,
  [string] $ExistingHistory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$probe = Join-Path $PSScriptRoot 'db-probe.mjs'
$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [ValidateSet('PASS', 'FAIL', 'SKIP', 'INFO')] [string] $Status,
    [string] $Detail = ''
  )
  $results.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
  $colour = switch ($Status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } 'SKIP' { 'Yellow' } default { 'Gray' } }
  Write-Host ("{0,-5} {1}" -f $Status, $Name) -ForegroundColor $colour
  if ($Detail) { Write-Host ("      {0}" -f $Detail) -ForegroundColor DarkGray }
}

function Fail-Now {
  param([string] $Message)
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  exit 1
}

function Install-Silently {
  param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $Label)
  Write-Host ''
  Write-Host "Installing $Label…" -ForegroundColor Cyan
  $run = Start-Process -FilePath $Path -ArgumentList '/S' -PassThru -Wait
  if ($run.ExitCode -ne 0) {
    Add-Result "$Label installs" 'FAIL' "exit code $($run.ExitCode)"
    Fail-Now "The $Label installer failed."
  }
  Add-Result "$Label installs" 'PASS' 'exit code 0'
}

function Invoke-SelfCheck {
  param([Parameter(Mandatory)] [string] $Exe, [Parameter(Mandatory)] [string] $Sandbox, [Parameter(Mandatory)] [string] $Label)
  $reportPath = Join-Path $Sandbox "self-check-$Label.json"
  $previous = $env:LOCALAPPDATA
  try {
    $env:LOCALAPPDATA = $Sandbox
    $run = Start-Process -FilePath $Exe -ArgumentList @("--self-check=$reportPath") -PassThru `
      -RedirectStandardOutput (Join-Path $Sandbox "stdout-$Label.txt") `
      -RedirectStandardError (Join-Path $Sandbox "stderr-$Label.txt")
    if (-not $run.WaitForExit(180000)) {
      try { $run.Kill() } catch { }
      Add-Result "$Label starts up" 'FAIL' 'did not exit within 180s'
      Fail-Now "Version $Label hung during startup."
    }
  } finally {
    $env:LOCALAPPDATA = $previous
  }
  if (-not (Test-Path $reportPath)) {
    Add-Result "$Label starts up" 'FAIL' "no report at $reportPath"
    Fail-Now "Version $Label produced no report."
  }
  $report = Get-Content $reportPath -Raw | ConvertFrom-Json
  $broken = @($report.integrity | Where-Object { $_.status -ne 'pass' })
  if ($broken.Count -gt 0) {
    Add-Result "$Label starts up" 'FAIL' (($broken | ForEach-Object { "$($_.label): $($_.detail)" }) -join '; ')
  } else {
    Add-Result "$Label starts up" 'PASS' `
      ("version {0}, schema {1}, database {2}" -f $report.appVersion, $report.schemaVersion, $report.database.status)
  }
  return $report
}

function Get-Fingerprint {
  param([Parameter(Mandatory)] [string] $DatabaseFile)
  $json = & node $probe --file $DatabaseFile 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($json | ConvertFrom-Json)
}

Write-Host ''
Write-Host 'ChargeWatch — upgrade test (A to B)' -ForegroundColor Cyan
Write-Host '-----------------------------------' -ForegroundColor Cyan

# --------------------------------------------------------------- preconditions

try { $null = & node --version } catch { Fail-Now 'Node is required for the database probe.' }
if (-not (Test-Path $probe)) { Fail-Now "Missing $probe" }

$releaseDir = Join-Path $repoRoot 'release'
$installers = @()
if (Test-Path $releaseDir) {
  $installers = @(Get-ChildItem -Path $releaseDir -Filter '*Setup*.exe' -File | Sort-Object LastWriteTime -Descending)
}

if (-not $NewInstaller) {
  if ($installers.Count -lt 1) { Fail-Now "No *Setup*.exe under $releaseDir. Run: npm run package:win" }
  $NewInstaller = $installers[0].FullName
}
if (-not $OldInstaller) {
  if ($installers.Count -lt 2) {
    Fail-Now @"
Only one installer is available, so there is no upgrade to test.

An upgrade test needs TWO builds. Either:
  * pass them explicitly:
      -OldInstaller .\release\ChargeWatch-Setup-0.1.0.exe -NewInstaller .\release\ChargeWatch-Setup-0.1.1.exe
  * or download the previous release's installer into .\release and re-run.

This is reported as a missing test rather than skipped silently: an untested
upgrade path is how a release destroys someone's history.
"@
  }
  $OldInstaller = $installers[1].FullName
}

foreach ($path in @($OldInstaller, $NewInstaller)) {
  if (-not (Test-Path $path)) { Fail-Now "$path does not exist." }
}
if ((Resolve-Path $OldInstaller).Path -eq (Resolve-Path $NewInstaller).Path) {
  Fail-Now 'The two installers are the same file, so nothing would be upgraded.'
}

Add-Result 'two distinct installers' 'PASS' `
  ("A = {0}`n      B = {1}" -f (Split-Path -Leaf $OldInstaller), (Split-Path -Leaf $NewInstaller))

$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\chargewatch'
$exePath = Join-Path $installRoot 'ChargeWatch.exe'
$sandbox = Join-Path $env:TEMP ("chargewatch-upgrade-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null
Write-Host "  sandbox data directory: $sandbox" -ForegroundColor DarkGray

try {
  # ------------------------------------------------------------- version A

  Install-Silently -Path $OldInstaller -Label 'A'
  if (-not (Test-Path $exePath)) { Fail-Now "Version A did not install to $exePath." }

  if ($ExistingHistory) {
    if (-not (Test-Path $ExistingHistory)) { Fail-Now "$ExistingHistory does not exist." }
    # A copy. The real history file is never the subject of a test.
    $target = Join-Path $sandbox 'ChargeWatch\database'
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -Path $ExistingHistory -Destination (Join-Path $target 'chargewatch.sqlite') -Force
    Add-Result 'seeded from a real history file' 'PASS' "copied from $ExistingHistory"
  }

  $reportA = Invoke-SelfCheck -Exe $exePath -Sandbox $sandbox -Label 'A'

  $dbFile = Get-ChildItem -Path $sandbox -Filter 'chargewatch.sqlite' -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $dbFile) {
    Add-Result 'version A created a history file' 'FAIL' "no chargewatch.sqlite under $sandbox"
    Fail-Now 'Without a history file there is nothing for the upgrade to preserve.'
  }
  Add-Result 'version A created a history file' 'PASS' ("{0:N0} KB" -f ($dbFile.Length / 1KB))

  $before = Get-Fingerprint -DatabaseFile $dbFile.FullName
  if (-not $before) {
    Add-Result 'history file is readable before the upgrade' 'FAIL' 'the probe could not read it'
    Fail-Now 'The database could not be fingerprinted, so nothing could be compared afterwards.'
  }
  Add-Result 'history file is readable before the upgrade' 'PASS' `
    ("schema {0}, {1} tables, {2} settings, {3} observations" -f `
      $before.schemaVersion, $before.tableCount, $before.counts.settings, $before.counts.observations)

  $observationsBefore = if ($null -eq $before.counts.observations) { 0 } else { [int]$before.counts.observations }
  if ($observationsBefore -eq 0) {
    Add-Result 'observation preservation' 'SKIP' `
      'the history file has no observations, so their survival is NOT tested. Re-run with -ExistingHistory once collection is running.'
  }

  # ------------------------------------------------------------- version B

  Install-Silently -Path $NewInstaller -Label 'B'
  if (-not (Test-Path $exePath)) { Fail-Now "Version B did not install to $exePath." }

  $reportB = Invoke-SelfCheck -Exe $exePath -Sandbox $sandbox -Label 'B'

  if ($reportB.appVersion -eq $reportA.appVersion) {
    Add-Result 'the upgrade changed the version' 'FAIL' `
      "both report $($reportA.appVersion), so B did not replace A"
  } else {
    Add-Result 'the upgrade changed the version' 'PASS' "$($reportA.appVersion) → $($reportB.appVersion)"
  }

  $after = Get-Fingerprint -DatabaseFile $dbFile.FullName
  if (-not $after) {
    Add-Result 'history file is readable after the upgrade' 'FAIL' 'the probe could not read it'
    Fail-Now 'The upgrade left an unreadable history file.'
  }
  Add-Result 'history file is readable after the upgrade' 'PASS' `
    ("schema {0}, {1} tables, {2} settings, {3} observations" -f `
      $after.schemaVersion, $after.tableCount, $after.counts.settings, $after.counts.observations)

  # THE check this whole script exists for: migrated in place, not replaced.
  if ($after.createdAtIso -ne $before.createdAtIso) {
    Add-Result 'the same history file was upgraded, not replaced' 'FAIL' `
      ("creation time changed from {0} to {1}, so version B created a new database and the old history is gone" -f `
        $before.createdAtIso, $after.createdAtIso)
  } else {
    Add-Result 'the same history file was upgraded, not replaced' 'PASS' `
      "created $($before.createdAtIso), still the same file"
  }

  if ($after.schemaVersion -lt $before.schemaVersion) {
    Add-Result 'schema did not go backwards' 'FAIL' `
      "schema $($before.schemaVersion) → $($after.schemaVersion)"
  } else {
    Add-Result 'schema did not go backwards' 'PASS' `
      "schema $($before.schemaVersion) → $($after.schemaVersion)"
  }

  # Every migration A applied must still be recorded. A rewritten history of
  # migrations would mean the upgrade re-created the table.
  $missing = @()
  foreach ($applied in $before.appliedMigrations) {
    if (-not ($after.appliedMigrations | Where-Object { $_.version -eq $applied.version -and $_.name -eq $applied.name })) {
      $missing += "$($applied.version):$($applied.name)"
    }
  }
  if ($missing.Count -gt 0) {
    Add-Result 'migration history preserved' 'FAIL' ("missing: " + ($missing -join ', '))
  } else {
    Add-Result 'migration history preserved' 'PASS' `
      ("{0} migration(s) still recorded" -f $before.appliedMigrations.Count)
  }

  foreach ($key in @('settings', 'sites', 'sources', 'bindings', 'observations', 'portObservations', 'visitObservations')) {
    $wasCount = if ($null -eq $before.counts.$key) { 0 } else { [int]$before.counts.$key }
    $nowCount = if ($null -eq $after.counts.$key) { 0 } else { [int]$after.counts.$key }
    if ($nowCount -lt $wasCount) {
      Add-Result "no $key were lost" 'FAIL' "$wasCount → $nowCount"
    } elseif ($wasCount -gt 0) {
      Add-Result "no $key were lost" 'PASS' "$wasCount → $nowCount"
    }
  }

  if ($after.integrityCheck -ne 'ok') {
    Add-Result 'database integrity after the upgrade' 'FAIL' "integrity_check said $($after.integrityCheck)"
  } elseif ($after.foreignKeyViolations -ne 0) {
    Add-Result 'database integrity after the upgrade' 'FAIL' "$($after.foreignKeyViolations) foreign key violation(s)"
  } else {
    Add-Result 'database integrity after the upgrade' 'PASS' 'integrity_check ok, no foreign key violations'
  }

  # An upgrade should have left a pre-update backup behind.
  $backups = @(Get-ChildItem -Path $sandbox -Filter '*.zip' -Recurse -File -ErrorAction SilentlyContinue)
  if ($backups.Count -gt 0) {
    Add-Result 'a backup exists after the upgrade' 'PASS' (($backups | ForEach-Object { $_.Name }) -join ', ')
  } else {
    Add-Result 'a backup exists after the upgrade' 'SKIP' `
      'no backup archive was found. A pre-update backup is made by the in-app updater, which this installer-over-installer test does not exercise.'
  }

  Add-Result 'in-app update discovery' 'SKIP' `
    'not testable here: it needs a published GitHub release and a client reaching it. See docs/RELEASING.md for the manual step.'

} finally {
  $uninstaller = Get-ChildItem -Path $installRoot -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($uninstaller) {
    Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -ErrorAction SilentlyContinue | Out-Null
  }
  Remove-Item -Path $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

# --------------------------------------------------------------------- summary

Write-Host ''
Write-Host 'Summary' -ForegroundColor Cyan
$passed = ($results | Where-Object Status -eq 'PASS').Count
$failed = @($results | Where-Object Status -eq 'FAIL')
$skipped = @($results | Where-Object Status -eq 'SKIP')
Write-Host ("  {0} passed, {1} failed, {2} skipped" -f $passed, $failed.Count, $skipped.Count)

if ($skipped.Count -gt 0) {
  Write-Host ''
  Write-Host 'Skipped checks are NOT passes:' -ForegroundColor Yellow
  foreach ($skip in $skipped) { Write-Host ("  - {0}: {1}" -f $skip.Name, $skip.Detail) -ForegroundColor Yellow }
}

if ($failed.Count -gt 0) {
  Write-Host ''
  Write-Host 'Failures:' -ForegroundColor Red
  foreach ($failure in $failed) { Write-Host ("  - {0}: {1}" -f $failure.Name, $failure.Detail) -ForegroundColor Red }
  Write-Host ''
  Write-Host 'Do not publish this release: the upgrade path is not safe.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'The upgrade migrated the existing history file in place and preserved its contents.' -ForegroundColor Green
exit 0
