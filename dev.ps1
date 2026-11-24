# Dot-source this file: . ./dev.ps1 env
param([ValidateSet('env', 'bootstrap', 'init', 'status')][string]$Action = 'env')
$themeliosRepoRoot = $PSScriptRoot
$themeliosTempRoot = Join-Path $themeliosRepoRoot 'temp'
$themeliosEnvPaths = @{
    TEMP = 'runtime'; TMP = 'runtime'; TMPDIR = 'runtime'
    UV_CACHE_DIR = 'cache/uv'; PIP_CACHE_DIR = 'cache/pip'
    UV_PROJECT_ENVIRONMENT = 'venvs/themelios'; UV_PYTHON_INSTALL_DIR = 'tools/python'
    BUN_INSTALL_CACHE_DIR = 'cache/bun'
    npm_config_cache = 'cache/npm'; XDG_CACHE_HOME = 'cache/xdg'
    RUFF_CACHE_DIR = 'cache/ruff'; PYTHONPYCACHEPREFIX = 'cache/python-bytecode'
}
foreach ($themeliosEntry in $themeliosEnvPaths.GetEnumerator()) {
    $themeliosPath = Join-Path $themeliosTempRoot $themeliosEntry.Value
    New-Item -ItemType Directory -Force -Path $themeliosPath | Out-Null
    [Environment]::SetEnvironmentVariable($themeliosEntry.Key, $themeliosPath, 'Process')
}
[Environment]::SetEnvironmentVariable('UV_NO_EDITABLE', '1', 'Process')
if (($env:CODEX_THREAD_ID -or $env:CODEX_SESSION_ID -or $env:ANTIGRAVITY_AGENT -or $env:CLAUDECODE) -and $null -eq [Environment]::GetEnvironmentVariable('AGENT', 'Process')) {
    $env:AGENT = '1'
}
$themeliosPythonScripts = Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts'
$env:THEMELIOS_BUN_DIR = Join-Path $themeliosTempRoot 'tools/bun-windows'
foreach ($themeliosBin in @($themeliosPythonScripts, (Join-Path $themeliosTempRoot 'tools/zvec-grep/node_modules/@zvec/zvec-grep/bin'), (Join-Path $themeliosTempRoot 'tools/codegraph/node_modules/.bin'), (Join-Path $env:THEMELIOS_BUN_DIR 'node_modules/.bin'), (Join-Path $themeliosRepoRoot 'node_modules/.bin'))) {
    $themeliosOtherPaths = @($env:PATH -split [IO.Path]::PathSeparator | Where-Object { $_ -and $_ -ne $themeliosBin })
    $env:PATH = (@($themeliosBin) + $themeliosOtherPaths) -join [IO.Path]::PathSeparator
}
$env:ZVEC_GREP_HOME = Join-Path $themeliosTempRoot 'tools/zvec-grep/runtime'
$env:ZVEC_GREP_MODEL_CACHE = Join-Path $themeliosTempRoot 'tools/zvec-grep/models'
if ($Action -eq 'env') { return }
Push-Location -LiteralPath $themeliosRepoRoot
try {
    $themeliosWorkspace = Join-Path $themeliosRepoRoot 'scripts/workspace.py'
    if ($Action -eq 'bootstrap') {
        python -B $themeliosWorkspace bootstrap
    } else {
        uv run --no-project --with tomlkit python -B $themeliosWorkspace $Action
    }
    if ($LASTEXITCODE -ne 0) { throw "Workspace cmd: $Action  failed。" }
} finally {
    Pop-Location
}
