<#
.SYNOPSIS
  Finds out why 7-Zip reports "Can't allocate required memory!" on this machine.

.DESCRIPTION
  Packaging has now failed three times at the same point, and three
  explanations have been offered and disproved: a 32-bit compressor (a 64-bit
  one failed identically), differential packaging (unrelated), and dictionary
  size at -mx=9 (-mx=5 failed too, with 5.9 GB free). Guessing a fourth time
  is not a plan.

  This script measures instead. It reports what the machine can actually
  commit, then compresses release\win-unpacked with 7-Zip directly, walking
  from the cheapest settings upward and stopping at the first success. The
  result says which knob matters - or that none of them do, which would mean
  the compressor is not the problem at all.

  It writes only to the temporary directory, deletes each archive as it goes,
  and changes nothing in the repository. Nothing here is a fix.

  Expect this to take a few minutes. Each level that succeeds is a full
  compression of about 814 MiB.

.PARAMETER SevenZip
  Path to 7z.exe. Defaults to the system install.

.PARAMETER Source
  Folder to compress. Defaults to release\win-unpacked.

.EXAMPLE
  .\scripts\windows\diagnose-7z.ps1
#>

[CmdletBinding()]
param(
  [string] $SevenZip,
  [string] $Source
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Write-Head {
  param([string] $Text)
  Write-Host ''
  Write-Host $Text -ForegroundColor Cyan
  Write-Host ('-' * 78) -ForegroundColor DarkGray
}

# --------------------------------------------------------------- what we have

Write-Host ''
Write-Host 'ChargeWatch - 7-Zip memory diagnosis' -ForegroundColor Cyan
Write-Host ('=' * 78) -ForegroundColor DarkGray

Write-Head '1. What this machine can commit'

$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem

# TotalVirtualMemorySize / FreeVirtualMemory are the COMMIT limit and what is
# left of it. Windows refuses an allocation when commit is exhausted even if
# physical memory looks free, so this is the number that actually decides
# whether 7-Zip can start.
$facts = [ordered] @{
  'Logical processors'   = $cs.NumberOfLogicalProcessors
  'Physical RAM (GB)'    = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
  'Physical free (GB)'   = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
  'Commit limit (GB)'    = [math]::Round($os.TotalVirtualMemorySize / 1MB, 2)
  'Commit free (GB)'     = [math]::Round($os.FreeVirtualMemory / 1MB, 2)
}
foreach ($key in $facts.Keys) {
  Write-Host ('   {0,-22} {1}' -f $key, $facts[$key])
}

$pageFiles = @(Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue)
if ($pageFiles.Count -eq 0) {
  Write-Host ''
  Write-Host '   NO PAGE FILE IS CONFIGURED.' -ForegroundColor Yellow
  Write-Host '   The commit limit is then roughly physical RAM, and a large' -ForegroundColor Yellow
  Write-Host '   reservation can be refused while memory still looks free.' -ForegroundColor Yellow
} else {
  foreach ($pf in $pageFiles) {
    Write-Host ('   page file             {0}  allocated {1} MB, in use {2} MB' -f `
      $pf.Name, $pf.AllocatedBaseSize, $pf.CurrentUsage)
  }
}

# ------------------------------------------------------------------- the tool

Write-Head '2. The compressor'

if (-not $SevenZip) {
  $SevenZip = @(
    (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
    (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\7-Zip\7z.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

if (-not $SevenZip -or -not (Test-Path $SevenZip)) {
  Write-Host '   No 7z.exe found. Install it or pass -SevenZip.' -ForegroundColor Red
  exit 1
}

Write-Host "   $SevenZip"
& $SevenZip | Select-Object -First 2 | ForEach-Object { Write-Host "   $_" }

# ----------------------------------------------------------------- the payload

Write-Head '3. The payload'

if (-not $Source) {
  $Source = Join-Path $repoRoot 'release\win-unpacked'
}

if (-not (Test-Path $Source)) {
  Write-Host "   $Source does not exist." -ForegroundColor Red
  Write-Host '   Run the build first: .\scripts\windows\build-all.ps1 -StopAfter build' -ForegroundColor Yellow
  Write-Host '   then npm run package:win once, to produce release\win-unpacked.' -ForegroundColor Yellow
  exit 1
}

$payload = Get-ChildItem -Recurse -File $Source | Measure-Object -Property Length -Sum
Write-Host ('   {0}' -f $Source)
Write-Host ('   {0} files, {1} MiB' -f $payload.Count, [math]::Round($payload.Sum / 1MB, 0))

# ------------------------------------------------------------------- the ladder

Write-Head '4. Compression attempts, cheapest first'

Write-Host '   Each attempt is a real compression of the whole payload. The first'
Write-Host '   success tells us which setting was the binding constraint.'
Write-Host ''

$attempts = @(
  @{ Label = 'mx=1  mmt=1  (one thread, 256 KB dictionary)'; Args = @('-mx=1', '-mmt=1') },
  @{ Label = 'mx=1  mmt=off (all threads, 256 KB dictionary)'; Args = @('-mx=1') },
  @{ Label = 'mx=5  mmt=1  (one thread, 16 MB dictionary)'; Args = @('-mx=5', '-mmt=1') },
  @{ Label = 'mx=5  mmt=4  (four threads, 16 MB dictionary)'; Args = @('-mx=5', '-mmt=4') },
  @{ Label = 'mx=5  mmt=off (all threads, 16 MB dictionary)'; Args = @('-mx=5') }
)

$results = @()
$firstSuccess = $null

foreach ($attempt in $attempts) {
  $archive = Join-Path $env:TEMP ('cw-7z-probe-{0}.7z' -f [guid]::NewGuid().ToString('N').Substring(0, 8))
  $argList = @('a', '-bd', '-bso0', '-bsp0') + $attempt.Args + @('-mtc=off', '-mtm=off', '-mta=off', $archive, '.')

  Write-Host ('   {0,-46} ' -f $attempt.Label) -NoNewline
  $started = Get-Date

  Push-Location $Source
  try {
    $output = & $SevenZip @argList 2>&1
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 0)

  if ($code -eq 0) {
    $size = [math]::Round((Get-Item $archive).Length / 1MB, 0)
    Write-Host ("OK   {0,4}s  {1} MB" -f $elapsed, $size) -ForegroundColor Green
    $results += [pscustomobject] @{ Setting = $attempt.Label; Result = 'ok'; Seconds = $elapsed; ArchiveMB = $size }
    if (-not $firstSuccess) { $firstSuccess = $attempt }
  } else {
    $reason = ($output | Where-Object { $_ -match 'ERROR' } | Select-Object -First 1)
    if (-not $reason) { $reason = "exit $code" }
    Write-Host ("FAIL {0,4}s  {1}" -f $elapsed, $reason.ToString().Trim()) -ForegroundColor Red
    $results += [pscustomobject] @{ Setting = $attempt.Label; Result = 'fail'; Seconds = $elapsed; ArchiveMB = $null }
  }

  Remove-Item $archive -Force -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------ conclusion

Write-Head '5. What this means'

$anyOk = $results | Where-Object { $_.Result -eq 'ok' }

if (-not $anyOk) {
  Write-Host '   7-Zip cannot compress this payload on this machine at ANY setting,' -ForegroundColor Yellow
  Write-Host '   including a single thread with a 256 KB dictionary. That is far too' -ForegroundColor Yellow
  Write-Host '   little memory to be a dictionary problem, so compression settings' -ForegroundColor Yellow
  Write-Host '   are not the cause and no amount of tuning will fix it.' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '   Look instead at: free space on the TEMP drive, a commit limit with' -ForegroundColor Yellow
  Write-Host '   no page file, or security software intercepting the writes.' -ForegroundColor Yellow
} elseif ($results[0].Result -eq 'ok' -and ($results | Where-Object { $_.Result -eq 'fail' })) {
  Write-Host '   Compression works at low settings and fails at higher ones, so this' -ForegroundColor Green
  Write-Host '   IS a memory ceiling. The highest row marked ok is what the build' -ForegroundColor Green
  Write-Host '   should use.' -ForegroundColor Green
} elseif (-not ($results | Where-Object { $_.Result -eq 'fail' })) {
  Write-Host '   Every setting worked when run directly, including the one the build' -ForegroundColor Yellow
  Write-Host '   failed on. The compressor is fine; something about how'  -ForegroundColor Yellow
  Write-Host '   electron-builder runs it is not. Likely candidates: memory already' -ForegroundColor Yellow
  Write-Host '   held by the node process driving the build, or the environment it' -ForegroundColor Yellow
  Write-Host '   passes down.' -ForegroundColor Yellow
}

Write-Host ''
$results | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Host $_ }

Write-Host '   Send this whole output back. It is the evidence, not a fix.'
Write-Host ''
