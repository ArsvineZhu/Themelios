#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$themeliosRoot = (& git rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or -not $themeliosRoot) { exit 0 }
$gitExecPath = (& git --exec-path)
if ($LASTEXITCODE -ne 0 -or -not $gitExecPath) { exit 2 }
$gitRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $gitExecPath))
$gitBash = Join-Path $gitRoot 'bin/bash.exe'
$cygpath = Join-Path $gitRoot 'usr/bin/cygpath.exe'
if (-not (Test-Path -LiteralPath $gitBash -PathType Leaf) -or -not (Test-Path -LiteralPath $cygpath -PathType Leaf)) {
    Write-Error 'Fallow 门禁需要 Git Bash。'
    exit 2
}
$runtime = Join-Path $themeliosRoot 'temp/runtime'
$cache = Join-Path $themeliosRoot 'temp/cache/fallow'
$report = Join-Path $themeliosRoot 'temp/work/fallow-gate/report.json'
New-Item -ItemType Directory -Force -Path $runtime, $cache, (Split-Path -Parent $report) | Out-Null
$env:TEMP = $runtime
$env:TMP = $runtime
$env:TMPDIR = (& $cygpath -u $runtime)
$env:FALLOW_CACHE_DIR = $cache
$env:FALLOW_GATE_REPORT = (& $cygpath -u $report)
$env:PATH = (Join-Path $themeliosRoot 'node_modules/.bin') + [IO.Path]::PathSeparator + $env:PATH
$payload = [Console]::In.ReadToEnd()
$payload | & $gitBash (Join-Path $themeliosRoot '.codex/hooks/fallow-gate.sh')
exit $LASTEXITCODE
