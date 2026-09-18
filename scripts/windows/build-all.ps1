<#
.SYNOPSIS
  Runs the whole chain from a fresh clone to a tested installer, in order.

.DESCRIPTION
  Every step in this script can be run by hand - see docs/BUILDING.md. The
  script exists because the first build of this project has never happened
  anywhere, so the failure modes are unknown, and hitting them one command at a
  time is slow. It stops at the first real failure and says what the failure
  means rather than leaving you with a stack trace.

  It is safe to re-run. Steps that are already done are detected and skipped
  unless you pass -Force.

  WHAT TO EXPECT ON THE FIRST RUN

  `npm run typecheck` has NEVER been executed on this codebase. The specs run
  the TypeScript through Node's type-stripping, which executes code but does
  not check types, and no spec imports a .tsx file at all - so the renderer has
  never been parsed by anything. Errors at that step are expected, are not a
  sign that something is broken, and are the single most valuable output of
  this script. Use -SkipTypecheck to get to a build while you work through
  them, but do not release without a clean typecheck.

.PARAMETER SkipTypecheck
  Continue past typecheck failures. Useful while working through the first run.

.PARAMETER SkipTests
  Skip the spec suite. Not recommended; it takes ten seconds.

.PARAMETER StopAfter
  Stop cleanly after a named step: install, typecheck, build, package, verify.

.PARAMETER Force
  Re-run steps that would otherwise be skipped as already done.

.EXAMPLE
  .\scripts\windows\build-all.ps1
  .\scripts\windows\build-all.ps1 -SkipTypecheck -StopAfter build
#>

[CmdletBinding()]
param(
  [switch] $SkipTypecheck,
  [switch] $SkipTests,
  [ValidateSet('install', 'typecheck', 'build', 'package', 'verify')]
  [string] $StopAfter,
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$script:stepNumber = 0
$script:started = Get-Date

function Write-Step {
  param([string] $Name)
  $script:stepNumber += 1
  Write-Host ''
  Write-Host ("-- {0}. {1} " -f $script:stepNumber, $Name).PadRight(78, '-') -ForegroundColor Cyan
}

function Write-Note {
  param([string] $Text)
  Write-Host "   $Text" -ForegroundColor DarkGray
}

function Write-Good {
  param([string] $Text)
  Write-Host "   $Text" -ForegroundColor Green
}

function Stop-With {
  param([string] $Headline, [string[]] $Detail = @())
  Write-Host ''
  Write-Host $Headline -ForegroundColor Red
  foreach ($line in $Detail) { Write-Host "  $line" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

function Invoke-Step {
  param([string] $Command, [string] $FailureHeadline, [string[]] $FailureDetail = @())
  Write-Note "> $Command"
  & cmd /c "$Command 2>&1" | ForEach-Object { Write-Host "   $_" }
  if ($LASTEXITCODE -ne 0) { Stop-With $FailureHeadline $FailureDetail }
}

Write-Host ''
Write-Host 'ChargeWatch - full build' -ForegroundColor Cyan
Write-Host ('=' * 78) -ForegroundColor Cyan

# ---------------------------------------------------------------- 1. toolchain

Write-Step 'Toolchain'

try { $nodeVersion = (& node --version).TrimStart('v') } catch {
  Stop-With 'Node is not on PATH.' @(
    'Install it from https://nodejs.org (LTS), then open a NEW PowerShell window.',
    'An already-open shell keeps the PATH it started with.'
  )
}

$nodeMajor = [int]($nodeVersion.Split('.')[0])
$nodeMinor = [int]($nodeVersion.Split('.')[1])
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
  Stop-With "Node $nodeVersion is too old." @(
    'Node 22.12 or newer is required: the specs use --experimental-strip-types',
    'and node:sqlite, and the build is pinned to 22.12 in CI.'
  )
}
Write-Good "node $nodeVersion"

if ($nodeMajor -ge 25) {
  Write-Note "package.json declares >=22.12.0 <25. Node $nodeVersion is outside that range;"
  Write-Note 'npm may warn, and nothing has been tested on this major.'
}

try { Write-Good "npm $(& npm --version)" } catch { Stop-With 'npm is not on PATH.' }

if ([Environment]::Is64BitOperatingSystem -ne $true) {
  Stop-With 'This build targets Windows x64 only.'
}
Write-Good "$([Environment]::OSVersion.VersionString), x64"

# ----------------------------------------------------------- 2. specs, no deps

if (-not $SkipTests) {
  Write-Step 'Specs (nothing installed needed)'
  Invoke-Step 'npm run check:migrations' 'The embedded migrations module is out of date.' @(
    'Run: npm run generate:migrations, then commit the result.'
  )
  Invoke-Step 'npm run test:nodeps' 'The specs failed.' @(
    'Fix these before building. They run on Node alone, so a failure here is',
    'a real defect, not an environment problem.'
  )
  Write-Good 'Specs passed'
}

# ------------------------------------------------------------------ 3. icons

Write-Step 'Application icons'
if ($Force -or -not (Test-Path 'resources\icons\icon.ico')) {
  Invoke-Step 'npm run make:icons' 'Icon generation failed.'
} else {
  Write-Note 'icon.ico already present (use -Force to regenerate)'
}
Invoke-Step 'npm run check:icons' 'The icon set is missing or unreadable.' @(
  'Run: npm run make:icons'
)

# ------------------------------------------------ 4. native module policy

Write-Step 'Native modules'

# ChargeWatch uses node:sqlite, which ships inside Node and therefore inside
# Electron. Nothing needs compiling, so no Python and no C++ toolchain.
# See docs/adr/0003-node-sqlite-over-better-sqlite3.md.
#
# This step deliberately does NOT scan node_modules. An earlier version did,
# and reported electron-builder's own prebuilt extract-zip binaries as a
# problem -- they are devDependencies that never reach the package, so the
# warning was pure noise. A check that cries wolf gets ignored, including on
# the day it is right.
#
# The real question is whether a native module reaches the PACKAGE, and
# verify:package answers it by inspecting the packaged output, which is the
# only authoritative place to look. That runs at step 10.

Write-Good 'nothing to compile - SQLite comes from node:sqlite'
Write-Note 'whether any native binary reaches the package is checked by verify:package'

# ---------------------------------------------------------------- 5. install

Write-Step 'Dependencies'

$lockfileExisted = Test-Path 'package-lock.json'
if ($Force -or -not (Test-Path 'node_modules')) {
  if ($lockfileExisted) {
    Write-Note 'package-lock.json exists; installing exactly what it pins.'
    Invoke-Step 'npm ci' 'npm ci failed.' @(
      'If it complains the lockfile is out of sync with package.json, run',
      '"npm install" instead and commit the updated lockfile.'
    )
  } else {
    Write-Note 'No package-lock.json yet. This first install resolves and writes one.'
    Write-Note 'Downloads roughly 500 MB including Electron. This takes a while.'
    Write-Note '> npm install'
    & cmd /c 'npm install 2>&1' | ForEach-Object { Write-Host "   $_" }
    if ($LASTEXITCODE -ne 0) {
      $detail = @(
        'ChargeWatch has no native dependencies, so this should not be a compile',
        'failure. If the output mentions node-gyp or Python, something in the tree',
        'pulled a native module back in. Find it with:',
        '    npm ls --all | findstr /i gyp',
        'and deal with the cause -- do not install a compiler to work around it.',
        '',
        'If it failed on a NETWORK error, set ELECTRON_BUILDER_BINARIES_MIRROR if',
        'you are behind a proxy. Never disable TLS verification to get past it.'
      )
      Stop-With 'npm install failed.' $detail
    }
  }
} else {
  Write-Note 'node_modules already present (use -Force to reinstall)'
}

if (-not $lockfileExisted -and (Test-Path 'package-lock.json')) {
  Write-Host ''
  Write-Host '   package-lock.json was just created. Commit it on its own:' -ForegroundColor Yellow
  Write-Host '     git add package-lock.json' -ForegroundColor Yellow
  Write-Host '     git commit -m "chore: pin dependency versions"' -ForegroundColor Yellow
  Write-Host '   A release must be built from a locked tree.' -ForegroundColor Yellow
}

if ($StopAfter -eq 'install') { Write-Host ''; Write-Good 'Stopped after install, as requested.'; exit 0 }

# --------------------------------------------------------------- 5. typecheck

Write-Step 'Typecheck'
Write-Note 'This has never run on this codebase. Errors here are expected on a first run.'
& cmd /c 'npm run typecheck 2>&1' | ForEach-Object { Write-Host "   $_" }
if ($LASTEXITCODE -ne 0) {
  if ($SkipTypecheck) {
    Write-Host ''
    Write-Host '   Typecheck FAILED, continuing because -SkipTypecheck was passed.' -ForegroundColor Yellow
    Write-Host '   Do not release without a clean typecheck.' -ForegroundColor Yellow
  } else {
    Stop-With 'Typecheck failed.' @(
      'This is the expected outcome of the first run, not a broken setup.',
      'The renderer is the most exposed area: no spec imports a .tsx file, so',
      'those modules have never been parsed by anything.',
      '',
      'Work through the errors, then re-run. To get to a build meanwhile:',
      '  .\scripts\windows\build-all.ps1 -SkipTypecheck'
    )
  }
} else {
  Write-Good 'Typecheck clean'
}

if ($StopAfter -eq 'typecheck') { Write-Host ''; Write-Good 'Stopped after typecheck, as requested.'; exit 0 }

# ------------------------------------------------------------------ 6. browser

Write-Step 'Bundled browser'
if ($Force -or -not (Test-Path '.playwright-cache\chromium')) {
  Write-Note 'Downloading the Chromium payload, roughly 200 MB.'
  Invoke-Step 'npm run setup:browser' 'The browser payload could not be staged.' @(
    'It is fetched from the Playwright CDN. Behind a proxy set PLAYWRIGHT_DOWNLOAD_HOST.',
    'Do not point the app at a system Chrome instead: the bundled browser is what ships.'
  )
} else {
  Write-Note '.playwright-cache\chromium already present (use -Force to re-fetch)'
}
Invoke-Step 'npm run setup:browser:verify' 'The staged browser payload is incomplete.'

# -------------------------------------------------------------------- 7. build

Write-Step 'Build'
Invoke-Step 'npm run build' 'The build failed.' @(
  'If the renderer failed, the error names the file and line.',
  'If the worker bundles failed, see scripts/build-workers.mjs.'
)
foreach ($expected in @('out\main\index.js', 'out\preload\index.js', 'out\renderer\index.html',
                        'out\workers\database.js', 'out\workers\collector.js')) {
  if (-not (Test-Path $expected)) { Stop-With "The build did not produce $expected." }
}
Write-Good 'main, preload, renderer and both workers built'

if ($StopAfter -eq 'build') {
  Write-Host ''
  Write-Good 'Stopped after build, as requested.'
  Write-Note 'To see the interface without packaging: npm run dev'
  exit 0
}

# ------------------------------------------------------------------ 8. package

Write-Step 'Package'

# MEMORY, NOT ARCHITECTURE.
#
# electron-builder invokes 7-Zip with "-mx=9" and nothing else. At that level
# 7-Zip chooses a 64 MB LZMA2 dictionary AND compresses blocks in parallel on
# every logical processor, and each of those threads wants its own encoder
# state of roughly 10.5x the dictionary -- about 675 MB apiece. On a machine
# with a dozen or more cores that is well over 8 GB for a single archive
# operation, and 7-Zip gives up with:
#
#     ERROR: Can't allocate required memory!
#
# The bundled 7za.exe is 32-bit, which also caps it at 2 GB, so it was the
# first suspect. It was wrong: a 64-bit 7-Zip 26.03 fails in exactly the same
# place on the same payload. Architecture was never the binding constraint.
#
# -mx=5 uses a 16 MB dictionary -- about 170 MB per thread -- which fits. The
# installer comes out larger. The real fix is not compressing 814 MiB in the
# first place: 432 MB of that is a second Chromium shipped beside Electron's
# own. See docs/BUILDING.md.
$cpuInfo = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($cpuInfo -and $osInfo) {
  $totalGb = [math]::Round($cpuInfo.TotalPhysicalMemory / 1GB, 1)
  $freeGb = [math]::Round($osInfo.FreePhysicalMemory / 1MB, 1)
  $cores = $cpuInfo.NumberOfLogicalProcessors
  Write-Note "machine: $cores logical processors, $totalGb GB RAM, $freeGb GB free"
}

if (-not $env:ELECTRON_BUILDER_COMPRESSION_LEVEL) {
  $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '5'
  Write-Good 'compressing at level 5 (16 MB dictionary) so the archive fits in memory'
  Write-Note 'level 9 wants a 64 MB dictionary per thread and cannot allocate it'
}

# A 64-bit 7-Zip is still preferable at any level: the bundled one is 32-bit
# and shares a 2 GB address space across all its threads. USE_SYSTEM_7ZA was
# removed in electron-builder 26; the override is ELECTRON_BUILDER_7ZIP_PATH,
# an absolute path to an executable file.
if (-not $env:ELECTRON_BUILDER_7ZIP_PATH) {
  $systemSevenZip = @(
    (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
    (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\7-Zip\7z.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

  if ($systemSevenZip) {
    $env:ELECTRON_BUILDER_7ZIP_PATH = $systemSevenZip
    Write-Good "using 64-bit 7-Zip ($systemSevenZip)"
  }
}

Write-Note 'electron-builder, NSIS, per-user. Several minutes.'
Invoke-Step 'npm run package:win' 'Packaging failed.' @(
  'If afterPack reported a missing browser or native module, that hook did its',
  'job: the package would have been broken on a user machine.'
)

$installer = Get-ChildItem -Path 'release' -Filter '*Setup*.exe' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { Stop-With 'Packaging reported success but produced no installer.' }
Write-Good ("{0} ({1:N0} MB)" -f $installer.Name, ($installer.Length / 1MB))

if ($StopAfter -eq 'package') { Write-Host ''; Write-Good 'Stopped after package, as requested.'; exit 0 }

# ------------------------------------------------------------------- 9. verify

Write-Step 'Verify the package'
Invoke-Step 'npm run verify:package' 'The package has faults that would break it on a user machine.'

if ($StopAfter -eq 'verify') { Write-Host ''; Write-Good 'Stopped after verify, as requested.'; exit 0 }

# ------------------------------------------------------- 10. install and test

Write-Step 'Install and self-check'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($elevated) {
  Write-Note 'This shell is elevated, so the "needs no administrator rights" claim'
  Write-Note 'cannot be established here. Passing -AllowElevated; the script will'
  Write-Note 'report that one claim as NOT proven rather than passing it.'
  & "$PSScriptRoot\test-installed.ps1" -AllowElevated -KeepInstalled
} else {
  & "$PSScriptRoot\test-installed.ps1" -KeepInstalled
}
if ($LASTEXITCODE -ne 0) { Stop-With 'The installed build failed its self-check.' }

# ------------------------------------------------------------------- summary

$elapsed = (Get-Date) - $script:started
Write-Host ''
Write-Host ('=' * 78) -ForegroundColor Green
Write-Host ("Done in {0:mm}m {0:ss}s." -f $elapsed) -ForegroundColor Green
Write-Host ''
Write-Host 'ChargeWatch is installed and its startup checks pass.' -ForegroundColor Green
Write-Host '  Launch it from the Start menu, or:' -ForegroundColor Gray
Write-Host '    & "$env:LOCALAPPDATA\Programs\chargewatch\ChargeWatch.exe"' -ForegroundColor Gray
Write-Host ''
Write-Host 'What it will and will not do on first launch:' -ForegroundColor Yellow
Write-Host '  - It opens, migrates its database and starts its bundled browser.' -ForegroundColor Gray
Write-Host '  - It will NOT collect anything. No charger network has been cleared' -ForegroundColor Gray
Write-Host '    for automated collection, and no station catalog is bundled. The' -ForegroundColor Gray
Write-Host '    onboarding screen says so rather than showing an empty map and' -ForegroundColor Gray
Write-Host '    letting you conclude the chargers are all idle.' -ForegroundColor Gray
Write-Host '  - See docs/SOURCES.md and docs/SOURCE_VERIFICATION.md.' -ForegroundColor Gray
Write-Host ''
Write-Host 'To uninstall:' -ForegroundColor Gray
Write-Host '    & "$env:LOCALAPPDATA\Programs\chargewatch\Uninstall ChargeWatch.exe" /S' -ForegroundColor Gray
Write-Host ''
