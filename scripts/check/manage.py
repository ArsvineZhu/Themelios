"""Check formatted source length without modifying the source files."""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TypedDict, cast

from metrics import python_code_lines, rust_code_lines

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "scripts/check/config/check.toml"
LANGUAGES = {
    ".py": "python",
    ".rs": "rust",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "typescript",
    ".jsx": "typescript",
    ".mjs": "typescript",
    ".cjs": "typescript",
}


class _ByteOffset(TypedDict):
    start: int
    end: int


class _LineCol(TypedDict):
    line: int


class _AstRange(TypedDict):
    start: _LineCol
    byteOffset: _ByteOffset


class _AstMatch(TypedDict):
    range: _AstRange


def command(argv: list[str], source: bytes, *, no_match_ok: bool = False) -> bytes:
    result = subprocess.run(
        argv, input=source, capture_output=True, cwd=ROOT, check=False
    )
    if result.returncode and not (
        no_match_ok and result.returncode == 1 and result.stdout.strip() == b"[]"
    ):
        detail = result.stderr.decode("utf-8", "replace").strip()
        detail = detail or result.stdout.decode("utf-8", "replace").strip()
        raise ValueError(detail or f"命令失败：{argv[0]} ({result.returncode})")
    return result.stdout


def bun_path() -> str:
    tool_dir = Path(
        os.environ.get(
            "THEMELIOS_BUN_DIR",
            ROOT / "temp/tools" / f"bun-{platform.system().lower()}",
        )
    )
    local = tool_dir / "node_modules/bun/bin/bun.exe"
    if local.is_file():
        return str(local)
    installed = shutil.which("bun")
    if installed:
        return installed
    raise ValueError("找不到 Bun，请先初始化开发环境。")


def typescript_lines(source: bytes, path: Path, bun: str) -> int:
    formatted = command([bun, "fmt", "--stdin-filepath", str(path)], source)
    lang = "tsx" if path.suffix in {".tsx", ".jsx"} else "typescript"
    query = [bun, "run", "ast-grep", "run", "--stdin", "--lang", lang]
    errors = cast(
        list[_AstMatch],
        json.loads(
            command(
                [*query, "--kind", "ERROR", "--json=compact"],
                formatted,
                no_match_ok=True,
            )
        ),
    )
    if errors:
        line = errors[0]["range"]["start"]["line"] + 1
        raise ValueError(f"无法解析第 {line} 行的语法")
    matches = command(
        [*query, "--kind", "comment", "--json=compact"],
        formatted,
        no_match_ok=True,
    )
    comments = cast(list[_AstMatch], json.loads(matches or b"[]"))
    code = bytearray(formatted)
    for match in comments:
        span = match["range"]["byteOffset"]
        for index in range(span["start"], span["end"]):
            if code[index] not in (10, 13):
                code[index] = 32
    return sum(bool(line.strip()) for line in code.splitlines())


def count(path: Path, language: str, config: Mapping[str, object]) -> int:
    source = path.read_bytes()
    _ = source.decode("utf-8")
    if language == "typescript":
        return typescript_lines(source, path, bun_path())
    if language == "python":
        ruff_version = config.get("ruff_version")
        if not isinstance(ruff_version, str):
            raise ValueError("配置文件缺少有效的 ruff_version。")
        formatted = command(
            [
                "uvx",
                "--from",
                f"ruff=={ruff_version}",
                "ruff",
                "format",
                "--stdin-filename",
                str(path),
                "-",
            ],
            source,
        )
        return python_code_lines(formatted.decode("utf-8"))
    formatted = command(
        [
            "rustfmt",
            "--edition",
            "2024",
            "--emit",
            "stdout",
            "--config",
            "skip_children=true",
        ],
        source,
    )
    return rust_code_lines(formatted.decode("utf-8"))


def _string_list(config: Mapping[str, object], key: str) -> list[str]:
    raw = config.get(key)
    if not isinstance(raw, list | tuple):
        raise TypeError(f"配置文件中的 {key} 必须是列表。")
    return [str(item) for item in cast(Sequence[object], raw)]


def discover(config: Mapping[str, object]) -> list[Path]:
    paths: list[Path] = []
    excluded = set(_string_list(config, "exclude_dirs"))
    for name in _string_list(config, "roots"):
        root = ROOT / name
        if not root.exists():
            continue
        for directory, dirs, files in os.walk(root):
            parent = Path(directory)
            dirs[:] = [
                name
                for name in dirs
                if name not in excluded and not (parent / name).is_symlink()
            ]
            paths.extend(
                parent / name
                for name in files
                if Path(name).suffix in LANGUAGES and not (parent / name).is_symlink()
            )
    return sorted(paths)


def main() -> int:
    parser = argparse.ArgumentParser(description="统计格式化后的有效代码行。")
    parser.add_argument("action", nargs="?", default="length", choices=["length"])
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--zero", action="store_true")
    ns = parser.parse_args()
    stdin = cast(bool, ns.stdin)
    zero = cast(bool, ns.zero)
    raw_paths = [str(item) for item in cast(Sequence[object], ns.paths)]
    if zero and not stdin:
        parser.error("--zero 需要和 --stdin 一起使用")
    if stdin and raw_paths:
        parser.error("--stdin 不能和文件参数一起使用")
    try:
        config: Mapping[str, object] = tomllib.loads(CONFIG.read_text(encoding="utf-8"))
        selected = stdin or bool(raw_paths)
        names: list[str] = raw_paths
        if stdin:
            separator = b"\0" if zero else b"\n"
            names = [
                item.decode("utf-8")
                for item in sys.stdin.buffer.read().split(separator)
                if item
            ]
        paths: list[Path] = []
        for name in names:
            path = (ROOT / name).resolve()
            if not path.is_relative_to(ROOT) or not path.is_file():
                raise ValueError(f"不是仓库内的文件：{name}")
            if path.suffix in LANGUAGES:
                paths.append(path)
        if not selected:
            paths = discover(config)

        def inspect(path: Path) -> tuple[Path, int | None, str]:
            try:
                return path, count(path, LANGUAGES[path.suffix], config), ""
            except (OSError, ValueError, SyntaxError, UnicodeError, KeyError) as error:
                return path, None, str(error)

        raw_limits = config.get("limits")
        if not isinstance(raw_limits, Mapping):
            raise TypeError("配置文件缺少 limits。")
        limits_map = cast(Mapping[str, object], raw_limits)

        failed = False
        warnings = 0
        with ThreadPoolExecutor(max_workers=min(4, max(1, len(paths)))) as pool:
            for path, lines, error in pool.map(inspect, sorted(set(paths))):
                label = path.relative_to(ROOT).as_posix()
                if lines is None:
                    failed = True
                    print(f"{label}  拒绝  {error}")
                    continue
                lang_limits_raw = limits_map[LANGUAGES[path.suffix]]
                if not isinstance(lang_limits_raw, Mapping):
                    raise TypeError(f"配置文件缺少 {LANGUAGES[path.suffix]} 限制。")
                lang_limits = cast(Mapping[str, object], lang_limits_raw)
                reject_limit = cast(int, lang_limits["reject"])
                warn_limit = cast(int, lang_limits["warn"])
                if lines > reject_limit:
                    failed = True
                    print(f"{label}  {lines}  拒绝  > {reject_limit}")
                elif lines > warn_limit:
                    warnings += 1
                    print(f"{label}  {lines}  警告  > {warn_limit}")
                elif selected:
                    print(f"{label}  {lines}  通过")
        print("长度检查失败" if failed else f"长度检查通过，警告 {warnings}")
        return 1 if failed else 0
    except (
        OSError,
        UnicodeError,
        TypeError,
        ValueError,
        KeyError,
        tomllib.TOMLDecodeError,
    ) as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
