<#
.SYNOPSIS
  Installs the packaged build, proves it actually works, and uninstalls it.

.DESCRIPTION
  This is the only test that can establish the things a pre-packaging check
  cannot: that the native SQLite module loads for the Electron ABI, that the
  bundled Chromium is where `process.resourcesPath` says it is, that the
  migrations were embedded, and that a per-user install needs no administrator
  rights.

  It runs the installer for real, then launches the installed executable with
  `--self-check`, which runs the genuine startup sequence (open and migrate the
  database, start the bundled browser, run the onboarding health checks) with
  no window, no tray and no collection, writes a JSON report, and exits with a
  nonzero code if the installation is broken.

  What this script does NOT prove, and does not claim to:
    * that the user interface renders correctly (see the Playwright UI tests);
    * that any charger data can be collected - no source is cleared for
      collection yet, so the report's readiness section is expected to be unmet;
    * that an update from a previous version installs (see test-update.ps1).

  The installed application's own history folder is NOT touched. The check
  runs against a throwaway data directory so a developer's real history is
  never migrated, written to, or deleted by a test.

.PARAMETER Installer
  Path to the NSIS installer. Defaults to the newest *Setup*.exe in .\release.

.PARAMETER KeepInstalled
  Skip the uninstall step, to leave the build in place for manual inspection.

.PARAMETER SkipUninstall
  Alias-style switch retained for clarity in CI logs; same effect as
  -KeepInstalled.

.PARAMETER AllowElevated
  Permit the run in an elevated shell. Required on hosted CI runners, whose
  default account is an administrator. It does not make the elevation check
  pass: the check is reported as not proven, because an install that succeeds
  with administrator rights says nothing about whether it would succeed
  without them. That claim then has to come from a run on a normal account.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\test-installed.ps1
#>

[CmdletBinding()]
param(
  [string] $Installer,
  [switch] $KeepInstalled,
  [switch] $SkipUninstall,
  [switch] $AllowElevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [ValidateSet('PASS', 'FAIL', 'SKIP', 'INFO')] [string] $Status,
    [string] $Detail = ''
  )
  $results.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
  $colour = switch ($Status) {
    'PASS' { 'Green' } 'FAIL' { 'Red' } 'SKIP' { 'Yellow' } default { 'Gray' }
  }
  Write-Host ("{0,-5} {1}" -f $Status, $Name) -ForegroundColor $colour
  if ($Detail) { Write-Host ("      {0}" -f $Detail) -ForegroundColor DarkGray }
}

function Fail-Now {
  param([string] $Message)
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host 'ChargeWatch - installed build test' -ForegroundColor Cyan
Write-Host '----------------------------------' -ForegroundColor Cyan
Write-Host ''

# --------------------------------------------------------------- preconditions

if ([Environment]::Is64BitOperatingSystem -ne $true) {
  Fail-Now 'This build targets Windows x64 only. Nothing was installed.'
}

if (-not $Installer) {
  $releaseDir = Join-Path $repoRoot 'release'
  if (-not (Test-Path $releaseDir)) {
    Fail-Now "No .\release directory. Run: npm run package:win"
  }
  $candidate = Get-ChildItem -Path $releaseDir -Filter '*Setup*.exe' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $candidate) {
    Fail-Now "No *Setup*.exe under $releaseDir. Run: npm run package:win"
  }
  $Installer = $candidate.FullName
}

if (-not (Test-Path $Installer)) { Fail-Now "$Installer does not exist." }

$installerInfo = Get-Item $Installer
Add-Result 'installer located' 'PASS' ("{0} ({1:N1} MB)" -f $installerInfo.Name, ($installerInfo.Length / 1MB))

# A full installer, not a web installer. A 5 MB "installer" would be a stub
# that downloads at first run, which is exactly what this product promises not
# to do.
if ($installerInfo.Length -lt 80MB) {
  Add-Result 'installer is a full offline package' 'FAIL' `
    ("only {0:N1} MB. The bundled browser alone is far larger than this, so the payload is missing. Run: npm run setup:browser, then repackage." -f ($installerInfo.Length / 1MB))
  Fail-Now 'A web installer must not be released: the bundled browser has to be present offline.'
}
Add-Result 'installer is a full offline package' 'PASS' 'size is consistent with a bundled browser payload'

# Refuse to run as administrator. The whole point of the per-user install is
# that it needs no elevation; testing it elevated would not prove that.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if (-not $AllowElevated) {
    Add-Result 'install needs no administrator rights' 'FAIL' `
      'this shell is elevated, so a successful install here would not prove a normal user can install ChargeWatch'
    Fail-Now 'Re-run in a normal, non-elevated PowerShell window, or pass -AllowElevated to test everything else.'
  }
  # Reported as not proven rather than passed. A hosted runner's default
  # account is an administrator, so this particular claim cannot be
  # established there and must not be implied.
  Add-Result 'install needs no administrator rights' 'SKIP' `
    "running elevated as $($identity.Name); whether a normal account can install is NOT established by this run"
} else {
  Add-Result 'install needs no administrator rights' 'PASS' $identity.Name
}

# ------------------------------------------------------------------- install

$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\chargewatch'
$exePath = Join-Path $installRoot 'ChargeWatch.exe'

if (Test-Path $exePath) {
  Add-Result 'no earlier install in the way' 'INFO' `
    "an existing install was found at $installRoot and will be replaced by this one"
}

Write-Host ''
Write-Host 'Installing (per-user, silent)...' -ForegroundColor Cyan
$installStart = Get-Date
$install = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
$installSeconds = ((Get-Date) - $installStart).TotalSeconds

if ($install.ExitCode -ne 0) {
  Add-Result 'installer exits cleanly' 'FAIL' "exit code $($install.ExitCode)"

  # `/S` suppresses the installer's window, and with it any error it would have
  # shown. A nonzero exit on its own is a dead end, so gather the diagnosis
  # here rather than leaving someone to hunt for it.
  Write-Host ''
  Write-Host 'Diagnosis' -ForegroundColor Yellow

  $code = $install.ExitCode
  $known = @{
    -1073740940 = 'STATUS_HEAP_CORRUPTION - the installer process crashed rather than reporting an error. Nothing was installed.'
    -1073741819 = 'STATUS_ACCESS_VIOLATION - the installer process crashed. Nothing was installed.'
    -1073741510 = 'STATUS_CONTROL_C_EXIT - the installer was interrupted.'
             2  = 'The installer was cancelled or could not elevate.'
  }
  if ($known.ContainsKey($code)) {
    Write-Host ("  {0} (0x{1:X8})" -f $known[$code], [uint32]($code -band 0xFFFFFFFF)) -ForegroundColor Yellow
  } else {
    Write-Host ("  Exit code {0} (0x{1:X8})" -f $code, [uint32]($code -band 0xFFFFFFFF)) -ForegroundColor Yellow
  }

  # A crash leaves an Application Error record naming the faulting module,
  # which is the single most useful fact about this failure.
  try {
    $since = $installStart.AddMinutes(-1)
    $faults = @(Get-WinEvent -FilterHashtable @{
      LogName = 'Application'; ProviderName = 'Application Error'; StartTime = $since
    } -MaxEvents 5 -ErrorAction SilentlyContinue)
    if ($faults.Count -gt 0) {
      Write-Host ''
      Write-Host '  Windows recorded a crash:' -ForegroundColor Yellow
      foreach ($fault in $faults) {
        foreach ($line in ($fault.Message -split "`n" | Select-Object -First 4)) {
          if ($line.Trim()) { Write-Host ("    {0}" -f $line.Trim()) -ForegroundColor DarkGray }
        }
        Write-Host ''
      }
      Write-Host '  A third-party DLL named above - a security product in particular -' -ForegroundColor Yellow
      Write-Host '  points away from ChargeWatch and towards something on this machine.' -ForegroundColor Yellow
    } else {
      Write-Host '  No Application Error record was found, so the process did not crash;' -ForegroundColor Yellow
      Write-Host '  the installer exited with this code deliberately.' -ForegroundColor Yellow
    }
  } catch {
    Write-Host '  The Application event log could not be read for crash details.' -ForegroundColor DarkGray
  }

  Write-Host ''
  Write-Host '  Next, in order:' -ForegroundColor Yellow
  Write-Host ("    1. Run it interactively, which shows errors /S hides:") -ForegroundColor Yellow
  Write-Host ("         {0}" -f $Installer) -ForegroundColor Gray
  Write-Host '    2. Rebuild from clean: Remove-Item -Recurse -Force .\release; npm run package:win' -ForegroundColor Yellow
  Write-Host '    3. Exclude the release folder from real-time scanning and retry.' -ForegroundColor Yellow
  Write-Host '    4. docs/TROUBLESHOOTING.md has the rest.' -ForegroundColor Yellow

  Fail-Now 'The installer failed. Nothing further can be tested.'
}
Add-Result 'installer exits cleanly' 'PASS' ("{0:N0}s, exit code 0" -f $installSeconds)

if (-not (Test-Path $exePath)) {
  Add-Result 'installed to the per-user location' 'FAIL' "expected $exePath"
  Fail-Now 'The install did not land where a per-user NSIS install should.'
}
Add-Result 'installed to the per-user location' 'PASS' $exePath

# Nothing may land in Program Files: that would mean the install silently
# elevated, or that perMachine was set.
foreach ($machineDir in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
  if ($machineDir -and (Test-Path (Join-Path $machineDir 'ChargeWatch'))) {
    Add-Result 'nothing installed machine-wide' 'FAIL' (Join-Path $machineDir 'ChargeWatch')
  }
}
if (-not ($results | Where-Object { $_.Name -eq 'nothing installed machine-wide' })) {
  Add-Result 'nothing installed machine-wide' 'PASS' 'no ChargeWatch directory under Program Files'
}

# The payload that a build can silently omit.
$browserExe = Get-ChildItem -Path (Join-Path $installRoot 'resources\browser') -Filter 'chrome.exe' `
  -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ($browserExe) {
  $browserBytes = (Get-ChildItem -Path (Join-Path $installRoot 'resources\browser') -Recurse -File |
    Measure-Object -Property Length -Sum).Sum
  Add-Result 'bundled browser present after install' 'PASS' `
    ("{0} ({1:N0} MB)" -f $browserExe.FullName, ($browserBytes / 1MB))
} else {
  Add-Result 'bundled browser present after install' 'FAIL' `
    "no chrome.exe under $installRoot\resources\browser"
}

$nativeSqlite = Get-ChildItem -Path (Join-Path $installRoot 'resources\app.asar.unpacked') `
  -Filter '*.node' -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'better[_-]?sqlite3' } | Select-Object -First 1
if ($nativeSqlite) {
  Add-Result 'native SQLite module unpacked' 'PASS' $nativeSqlite.FullName
} else {
  Add-Result 'native SQLite module unpacked' 'FAIL' `
    'no better_sqlite3 .node under resources\app.asar.unpacked - it cannot be loaded from inside the archive'
}

# --------------------------------------------------------------- the self-check

# A throwaway data directory, so this test never touches real history.
$sandbox = Join-Path $env:TEMP ("chargewatch-selfcheck-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null
$reportPath = Join-Path $sandbox 'self-check.json'

Write-Host ''
Write-Host 'Running the installed build''s self-check...' -ForegroundColor Cyan
Write-Host "  sandbox data directory: $sandbox" -ForegroundColor DarkGray

$previousLocalAppData = $env:LOCALAPPDATA
try {
  # Electron derives userData from LOCALAPPDATA on Windows, so pointing it at
  # the sandbox keeps the real history file untouched.
  $env:LOCALAPPDATA = $sandbox

  $stdout = Join-Path $sandbox 'stdout.txt'
  $stderr = Join-Path $sandbox 'stderr.txt'
  $run = Start-Process -FilePath $exePath `
    -ArgumentList @("--self-check=$reportPath") `
    -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  # Generous: a first run migrates the database and starts Chromium.
  if (-not $run.WaitForExit(180000)) {
    try { $run.Kill() } catch { }
    Add-Result 'self-check completes' 'FAIL' 'the installed build did not exit within 180s'
    Fail-Now 'The installed build hung during startup.'
  }
  $selfCheckExit = $run.ExitCode
} finally {
  $env:LOCALAPPDATA = $previousLocalAppData
}

if (-not (Test-Path $reportPath)) {
  Add-Result 'self-check report written' 'FAIL' "expected $reportPath"
  if (Test-Path $stderr) {
    $errText = (Get-Content $stderr -Raw)
    if ($errText.Trim()) { Write-Host $errText -ForegroundColor DarkGray }
  }
  Fail-Now 'The installed build produced no report, so nothing about it can be claimed.'
}

$report = Get-Content $reportPath -Raw | ConvertFrom-Json
Add-Result 'self-check report written' 'PASS' `
  ("{0} - electron {1}, schema {2}, {3:N0}ms" -f $report.verdict, $report.electronVersion, $report.schemaVersion, $report.durationMs)

foreach ($check in $report.integrity) {
  $status = if ($check.status -eq 'pass') { 'PASS' } else { 'FAIL' }
  Add-Result ("integrity: " + $check.label) $status $check.detail
}

Write-Host ''
Write-Host 'Operational readiness (reported, not required to pass):' -ForegroundColor Cyan
foreach ($check in $report.readiness) {
  Add-Result ("readiness: " + $check.label) 'INFO' `
    ("{0} - {1}" -f $check.status, $check.detail)
}

if ($report.fatal -and $report.fatal.Count -gt 0) {
  foreach ($message in $report.fatal) { Add-Result 'startup fault' 'FAIL' $message }
}

if ($selfCheckExit -ne 0 -and $report.verdict -eq 'pass') {
  # Exit code and report disagree. Trust neither.
  Add-Result 'exit code agrees with the report' 'FAIL' `
    "exit code $selfCheckExit but the report says pass"
} else {
  Add-Result 'exit code agrees with the report' 'PASS' "exit code $selfCheckExit"
}

# The sandbox should now contain a real database, not an empty folder.
$dbFile = Get-ChildItem -Path $sandbox -Filter '*.sqlite' -Recurse -File -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($dbFile -and $dbFile.Length -gt 0) {
  Add-Result 'history database created and non-empty' 'PASS' `
    ("{0} ({1:N0} KB)" -f $dbFile.Name, ($dbFile.Length / 1KB))
} else {
  Add-Result 'history database created and non-empty' 'FAIL' "no non-empty .sqlite file under $sandbox"
}

# No leftover Chromium from the browser health check.
Start-Sleep -Seconds 2
$strays = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) }
if ($strays) {
  Add-Result 'no processes left running' 'FAIL' `
    (($strays | ForEach-Object { "$($_.ProcessName) ($($_.Id))" }) -join ', ')
} else {
  Add-Result 'no processes left running' 'PASS' 'the self-check shut down its own child processes'
}

# ------------------------------------------------------------------ uninstall

if ($KeepInstalled -or $SkipUninstall) {
  Add-Result 'uninstall' 'SKIP' "left installed at $installRoot by request"
} else {
  $uninstaller = Get-ChildItem -Path $installRoot -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $uninstaller) {
    Add-Result 'uninstaller present' 'FAIL' "no Uninstall*.exe in $installRoot"
  } else {
    Write-Host ''
    Write-Host 'Uninstalling...' -ForegroundColor Cyan
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait
    if ($uninstall.ExitCode -ne 0) {
      Add-Result 'uninstaller exits cleanly' 'FAIL' "exit code $($uninstall.ExitCode)"
    } else {
      Start-Sleep -Seconds 3
      if (Test-Path $exePath) {
        Add-Result 'uninstall removes the program' 'FAIL' "$exePath still exists"
      } else {
        Add-Result 'uninstall removes the program' 'PASS' 'the install directory is gone'
      }
    }
  }
}

Remove-Item -Path $sandbox -Recurse -Force -ErrorAction SilentlyContinue

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
  foreach ($failure in $failed) {
    Write-Host ("  - {0}: {1}" -f $failure.Name, $failure.Detail) -ForegroundColor Red
  }
  Write-Host ''
  Write-Host 'This build must not be released.' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'The installed build opens its database and starts its bundled browser.' -ForegroundColor Green
Write-Host 'It does not yet collect: no source has been cleared for collection and no' -ForegroundColor Yellow
Write-Host 'station catalog has been imported. See docs/SOURCE_VERIFICATION.md.' -ForegroundColor Yellow
Write-Host ''
exit 0
