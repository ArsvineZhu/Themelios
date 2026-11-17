#!/usr/bin/env bash
# 在工程终端 source；缓存与实例不进入源码目录。
THEMELIOS_REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
export THEMELIOS_REPO_ROOT
export UV_CACHE_DIR="$THEMELIOS_REPO_ROOT/temp/cache/uv"
export UV_PROJECT_ENVIRONMENT="$THEMELIOS_REPO_ROOT/temp/venvs/themelios"
export UV_NO_EDITABLE=1
if [ -n "${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}" ] && [ "${AGENT+x}" != x ]; then
    export AGENT=1
fi
export UV_PYTHON_INSTALL_DIR="$THEMELIOS_REPO_ROOT/temp/tools/python"
export CARGO_HOME="$THEMELIOS_REPO_ROOT/temp/tools/cargo-home"
export CARGO_TARGET_DIR="$THEMELIOS_REPO_ROOT/temp/build/native"
export BUN_INSTALL_CACHE_DIR="$THEMELIOS_REPO_ROOT/temp/cache/bun"
export FALLOW_CACHE_DIR="$THEMELIOS_REPO_ROOT/temp/cache/fallow"
export PIP_CACHE_DIR="$THEMELIOS_REPO_ROOT/temp/cache/pip"
export RUFF_CACHE_DIR="$THEMELIOS_REPO_ROOT/temp/cache/ruff"
export PYTHONPYCACHEPREFIX="$THEMELIOS_REPO_ROOT/temp/cache/python-bytecode"
export TEMP="$THEMELIOS_REPO_ROOT/temp/runtime"
export TMP="$TEMP"
export TMPDIR="$TEMP"
export npm_config_cache="$THEMELIOS_REPO_ROOT/temp/cache/npm"
export XDG_CACHE_HOME="$THEMELIOS_REPO_ROOT/temp/cache/xdg"
export ZVEC_GREP_HOME="$THEMELIOS_REPO_ROOT/temp/tools/zvec-grep/runtime"
export ZVEC_GREP_MODEL_CACHE="$THEMELIOS_REPO_ROOT/temp/tools/zvec-grep/models"
export THEMELIOS_BUN_DIR="$THEMELIOS_REPO_ROOT/temp/tools/bun-$(uname -s | tr '[:upper:]' '[:lower:]')"
mkdir -p "$UV_CACHE_DIR" "$PYTHONPYCACHEPREFIX" \
    "$UV_PYTHON_INSTALL_DIR" "$PIP_CACHE_DIR" "$RUFF_CACHE_DIR" "$CARGO_HOME" "$CARGO_TARGET_DIR" \
    "$BUN_INSTALL_CACHE_DIR" "$FALLOW_CACHE_DIR" "$TEMP" "$npm_config_cache" "$XDG_CACHE_HOME"

for themelios_bin in "$UV_PROJECT_ENVIRONMENT/bin" "$THEMELIOS_REPO_ROOT/temp/tools/zvec-grep/node_modules/@zvec/zvec-grep/bin" "$THEMELIOS_REPO_ROOT/temp/tools/codegraph/node_modules/.bin" "$THEMELIOS_BUN_DIR/node_modules/.bin" "$THEMELIOS_REPO_ROOT/node_modules/.bin"; do
    IFS=: read -r -a themelios_path_entries <<< "$PATH"
    themelios_new_path="$themelios_bin"
    for themelios_path_entry in "${themelios_path_entries[@]}"; do
        if [ "$themelios_path_entry" != "$themelios_bin" ]; then
            themelios_new_path="$themelios_new_path:$themelios_path_entry"
        fi
    done
    PATH="$themelios_new_path"
done
export PATH
if [ "${1:-env}" = "env" ]; then
    return 0 2>/dev/null || exit 0
fi
if (cd -- "$THEMELIOS_REPO_ROOT" && uv run --no-project --with tomlkit python -B "$THEMELIOS_REPO_ROOT/scripts/workspace.py" "${1:-env}"); then
    return 0 2>/dev/null || exit 0
else
    themelios_status=$?
    return "$themelios_status" 2>/dev/null || exit "$themelios_status"
fi
