"""Unified CLI for Agent Harness command gates, MCP sync, and status."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from adapters import (
    GATE_ADAPTERS,
    HARNESS_ADAPTERS,
    GateDecision,
    GateRequest,
    HarnessAdapter,
    McpServer,
)

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "scripts/harness/config/harness.toml"
GATE_SCRIPT = ROOT / "scripts/harness/fallow-gate.sh"
USER_MCP_NAMES = ("codegraph", "zvec-grep")
WORKSPACE_MCP_NAMES = ("fallow", "ast-grep")


class _GateSetupError(RuntimeError):
    """Raised when the host shell environment cannot launch fallow-gate.sh."""


@dataclass(frozen=True)
class CliArgs:
    """Parsed CLI arguments for the harness tool."""

    command: Literal["gate", "mcp", "status"]
    harness: str
    force: bool = False


def load_config() -> dict[str, object]:
    """Load harness configuration from scripts/harness/config/harness.toml."""
    return tomllib.loads(CONFIG.read_text(encoding="utf-8"))


def _section(config: Mapping[str, object], key: str) -> Mapping[str, object]:
    value = config.get(key)
    if not isinstance(value, Mapping):
        raise TypeError(f"配置段 {key} 必须是对象。")
    return cast(Mapping[str, object], value)


def _req_str(section: Mapping[str, object], key: str) -> str:
    value = section.get(key)
    if not isinstance(value, str):
        raise TypeError(f"配置项 {key} 必须是字符串。")
    return value


def _req_int(section: Mapping[str, object], key: str) -> int:
    value = section.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"配置项 {key} 必须是整数。")
    return value


def _configured_harnesses(config: Mapping[str, object]) -> list[str]:
    raw = config.get("harnesses", ())
    if not isinstance(raw, list | tuple):
        raise TypeError("配置项 harnesses 必须是列表。")
    items = cast(Sequence[object], raw)
    return [str(item) for item in items]


def might_be_git_write(request: GateRequest) -> bool:
    """Return True when the command might execute git commit or git push."""
    if not request.command.strip():
        return False
    if request.has_unicode_escape:
        return True
    stripped = request.command.translate(str.maketrans("", "", "'\"\\`"))
    return (
        re.search(r"git[\s\S]*(?:commit|push|\$)", stripped, re.IGNORECASE) is not None
    )


def _bun_bin_dir() -> Path | None:
    bun_tools = Path(
        os.environ.get("THEMELIOS_BUN_DIR")
        or (ROOT / "temp" / "tools" / f"bun-{platform.system().lower()}")
    )
    bin_dir = bun_tools / "node_modules" / "bun" / "bin"
    return bin_dir if bin_dir.is_dir() else None


def _resolve_bun() -> str:
    bun_name = "bun.exe" if os.name == "nt" else "bun"
    bin_dir = _bun_bin_dir()
    if bin_dir is not None and (bin_dir / bun_name).is_file():
        return str(bin_dir / bun_name)
    installed = shutil.which("bun")
    if installed:
        return installed
    raise RuntimeError("找不到 Bun，请先初始化工作区。")


def _resolve_codegraph() -> tuple[str, list[str]]:
    tools = ROOT / "temp" / "tools"
    local_bin = tools / "codegraph" / "node_modules" / ".bin"
    local_graph = local_bin / ("codegraph.cmd" if os.name == "nt" else "codegraph")
    graph = shutil.which("codegraph") or (
        str(local_graph) if local_graph.exists() else None
    )
    if not graph:
        raise RuntimeError("找不到 codegraph，请先初始化工作区。")
    if Path(graph) == local_graph:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("找不到 node，请先安装并加入 PATH。")
        shim = (
            tools
            / "codegraph"
            / "node_modules"
            / "@colbymchenry"
            / "codegraph"
            / "npm-shim.js"
        )
        return node, [str(shim), "serve", "--mcp"]
    return graph, ["serve", "--mcp"]


def _resolve_zvec() -> str:
    zg_name = "zg.exe" if os.name == "nt" else "zg"
    local_zg = (
        ROOT
        / "temp"
        / "tools"
        / "zvec-grep"
        / "node_modules"
        / "@zvec"
        / "zvec-grep"
        / "bin"
        / zg_name
    )
    if local_zg.is_file():
        return str(local_zg)
    installed = shutil.which("zg")
    if installed:
        candidate = (
            Path(installed).parent
            / "node_modules"
            / "@zvec"
            / "zvec-grep"
            / "bin"
            / zg_name
        )
        return str(candidate) if candidate.is_file() else installed
    raise RuntimeError("找不到 zg，请先初始化工作区。")


def _resolve_ast_grep_server() -> str:
    uv_bin = ROOT / "temp" / "tools" / f"uv-bin-{platform.system().lower()}"
    server_name = "ast-grep-server.exe" if os.name == "nt" else "ast-grep-server"
    local_server = uv_bin / server_name
    if local_server.is_file():
        return str(local_server)
    installed = shutil.which("ast-grep-server")
    if installed:
        return installed
    raise RuntimeError("找不到 ast-grep-server，请先初始化工作区。")


def _resolve_gate_runner(
    runtime: Path, report: Path, gate_script: Path
) -> tuple[str, str, str, str]:
    if os.name != "nt":
        bash = shutil.which("bash") or "/bin/bash"
        return bash, str(runtime), str(report), str(gate_script)
    git = shutil.which("git")
    if not git:
        raise _GateSetupError("Fallow 门禁需要 Git Bash。")
    exec_proc = subprocess.run(
        [git, "--exec-path"], capture_output=True, text=True, check=False
    )
    exec_path = exec_proc.stdout.strip()
    if exec_proc.returncode != 0 or not exec_path:
        raise _GateSetupError("无法定位 Git Bash。")
    git_root = Path(exec_path).parents[2]
    bash_exe = git_root / "bin/bash.exe"
    cygpath_exe = git_root / "usr/bin/cygpath.exe"
    if not bash_exe.is_file() or not cygpath_exe.is_file():
        raise _GateSetupError("Fallow 门禁需要 Git Bash。")
    converted = subprocess.run(
        [str(cygpath_exe), "-u", str(runtime), str(report), str(gate_script)],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = converted.stdout.splitlines()
    if len(lines) < 3:
        raise _GateSetupError("cygpath 路径转换失败。")
    return str(bash_exe), lines[0], lines[1], lines[2]


def run_gate(harness_name: str, config: dict[str, object] | None = None) -> int:
    """Run the PreToolUse Fallow gate for the specified harness adapter."""
    adapter = GATE_ADAPTERS[harness_name]
    raw = sys.stdin.read()
    if not raw.strip():
        return adapter.emit_gate_output(GateDecision(allow=True))
    try:
        request = adapter.parse_gate_input(raw)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        print(f"fallow-gate: invalid hook input ({exc}), skipping.", file=sys.stderr)
        return adapter.emit_gate_output(GateDecision(allow=True))
    if not might_be_git_write(request):
        return adapter.emit_gate_output(GateDecision(allow=True))

    cfg = config or load_config()
    paths = _section(cfg, "paths")
    runtime = ROOT / _req_str(paths, "runtime")
    fallow_cache = ROOT / _req_str(paths, "fallow_cache")
    gate_report = ROOT / _req_str(paths, "gate_report")
    runtime.mkdir(parents=True, exist_ok=True)
    fallow_cache.mkdir(parents=True, exist_ok=True)
    gate_report.parent.mkdir(parents=True, exist_ok=True)

    normalized_cmd = re.sub(
        r"\bgit\.exe\b", "git", request.command, flags=re.IGNORECASE
    )
    try:
        bash_cmd, posix_runtime, posix_report, posix_script = _resolve_gate_runner(
            runtime, gate_report, GATE_SCRIPT
        )
    except _GateSetupError as exc:
        return adapter.emit_gate_output(GateDecision(allow=False, reason=str(exc)))

    env = os.environ.copy()
    env["TEMP"] = str(runtime)
    env["TMP"] = str(runtime)
    env["TMPDIR"] = posix_runtime
    env["FALLOW_CACHE_DIR"] = str(fallow_cache)
    env["FALLOW_GATE_REPORT"] = posix_report
    extra_bins = [str(ROOT / "node_modules/.bin")]
    bun_dir = _bun_bin_dir()
    if bun_dir is not None:
        extra_bins.append(str(bun_dir))
    existing_path = env.get("PATH", "")
    env["PATH"] = (
        os.pathsep.join([*extra_bins, existing_path])
        if existing_path
        else os.pathsep.join(extra_bins)
    )

    payload = json.dumps(
        {
            "tool_name": "Bash",
            "tool_input": {"command": normalized_cmd},
            "cwd": request.cwd or str(ROOT),
        },
        ensure_ascii=False,
    )
    result = subprocess.run(
        [bash_cmd, posix_script],
        cwd=ROOT,
        input=payload,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if result.returncode == 2:
        reason = result.stderr.strip() or result.stdout.strip() or "Fallow 门禁未通过。"
        return adapter.emit_gate_output(GateDecision(allow=False, reason=reason))
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)
    return adapter.emit_gate_output(GateDecision(allow=True))


def build_mcp_servers(
    config: dict[str, object],
    *,
    graph_command: str | None = None,
    graph_args: list[str] | None = None,
    zg_path: str | None = None,
) -> list[McpServer]:
    """Build canonical user and workspace MCP server definitions."""
    paths = _section(config, "paths")
    mcp = _section(config, "mcp")

    bun = _resolve_bun()
    if graph_command is None:
        resolved_graph_cmd, resolved_graph_args = _resolve_codegraph()
    else:
        resolved_graph_cmd = graph_command
        resolved_graph_args = list(graph_args or ["serve", "--mcp"])
    resolved_zg = zg_path or _resolve_zvec()
    ast_grep_server = _resolve_ast_grep_server()

    fallow_cache = str(ROOT / _req_str(paths, "fallow_cache"))
    zvec_home = str(ROOT / _req_str(paths, "zvec_home"))
    zvec_models = str(ROOT / _req_str(paths, "zvec_models"))
    workspace_timeout = _req_int(mcp, "workspace_startup_timeout_sec")
    zvec_timeout = _req_int(mcp, "zvec_startup_timeout_sec")

    return [
        McpServer(
            name="codegraph",
            scope="user",
            command=resolved_graph_cmd,
            args=resolved_graph_args,
            cwd=None,
            env={"CODEGRAPH_MCP_TOOLS": _req_str(mcp, "codegraph_tools")},
        ),
        McpServer(
            name="zvec-grep",
            scope="user",
            command=resolved_zg,
            args=["--server", "--stdio"],
            cwd=None,
            env={
                "ZVEC_GREP_HOME": zvec_home,
                "ZVEC_GREP_MODEL_CACHE": zvec_models,
            },
            startup_timeout_sec=zvec_timeout,
        ),
        McpServer(
            name="fallow",
            scope="workspace",
            command=bun,
            args=["run", "--cwd", str(ROOT), "fallow-mcp"],
            cwd=str(ROOT),
            env={"FALLOW_CACHE_DIR": fallow_cache},
            startup_timeout_sec=workspace_timeout,
        ),
        McpServer(
            name="ast-grep",
            scope="workspace",
            command=ast_grep_server,
            args=[],
            cwd=str(ROOT),
            env={
                "AST_GREP_PATH": f'"{bun}" run --cwd "{ROOT}" ast-grep',
                "PYTHONHOME": "",
            },
            startup_timeout_sec=workspace_timeout,
        ),
    ]


def _select_adapters(target: str, config: dict[str, object]) -> list[HarnessAdapter]:
    if target != "all":
        return [HARNESS_ADAPTERS[target]]
    selected: list[HarnessAdapter] = []
    for name in _configured_harnesses(config):
        adapter = HARNESS_ADAPTERS.get(name)
        if adapter is not None and adapter.detect():
            selected.append(adapter)
    return selected


def _ensure_tomlkit_for_cli(adapters: Sequence[HarnessAdapter]) -> int | None:
    if not any(a.name == "codex" for a in adapters):
        return None
    if importlib.util.find_spec("tomlkit") is not None:
        return None
    uv = shutil.which("uv")
    if uv and os.environ.get("THEMELIOS_HARNESS_REEXEC") != "1":
        env = os.environ.copy()
        env.pop("PYTHONHOME", None)
        env["THEMELIOS_HARNESS_REEXEC"] = "1"
        result = subprocess.run(
            [
                uv,
                "run",
                "--no-project",
                "--with",
                "tomlkit",
                "python",
                "-B",
                str(Path(__file__).resolve()),
                *sys.argv[1:],
            ],
            cwd=ROOT,
            env=env,
            check=False,
        )
        return result.returncode
    raise RuntimeError("同步 Codex MCP 需要 tomlkit，请安装或通过 uv 运行。")


def sync_mcp(
    target: str = "all",
    *,
    force: bool = False,
    servers: Sequence[McpServer] | None = None,
) -> list[str]:
    """Synchronize canonical MCP definitions to detected or named harnesses."""
    config = load_config()
    adapters = _select_adapters(target, config)
    if not adapters:
        print("未检测到可配置的 Agent Harness。", flush=True)
        return []
    reexec_code = _ensure_tomlkit_for_cli(adapters)
    if reexec_code is not None:
        if reexec_code != 0:
            raise RuntimeError(f"使用 uv 同步 MCP 失败（退出码 {reexec_code}）。")
        return [a.name for a in adapters]

    resolved_servers = (
        list(servers) if servers is not None else build_mcp_servers(config)
    )
    for adapter in adapters:
        adapter.sync_mcp(ROOT, resolved_servers, force=force)
    names = [a.name for a in adapters]
    print(f"已同步 MCP 配置：{', '.join(names)}。", flush=True)
    return names


def print_status(target: str = "all") -> int:
    """Print detected presence, hook integration, and MCP server registration."""
    config = load_config()
    if target == "all":
        adapters = [
            HARNESS_ADAPTERS[name]
            for name in _configured_harnesses(config)
            if name in HARNESS_ADAPTERS
        ]
    else:
        adapters = [HARNESS_ADAPTERS[target]]
    for adapter in adapters:
        st = adapter.status(ROOT, USER_MCP_NAMES, WORKSPACE_MCP_NAMES)
        print(
            f"{st.name}: detected={'yes' if st.detected else 'no'}, "
            f"hook={'yes' if st.hook_configured else 'no'}, "
            f"user_mcp=[{', '.join(st.user_mcp)}], "
            f"workspace_mcp=[{', '.join(st.workspace_mcp)}]",
            flush=True,
        )
    return 0


def parse_args(argv: Sequence[str] | None = None) -> CliArgs:
    """Parse CLI arguments for gate, mcp, and status subcommands."""
    parser = argparse.ArgumentParser(
        prog="harness", description="统一 Agent Harness 门禁与 MCP 适配器"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    gate_cmd = sub.add_parser("gate", help="执行 PreToolUse Fallow 提交门禁")
    gate_cmd.add_argument(
        "-a",
        "--harness",
        choices=tuple(GATE_ADAPTERS.keys()),
        default="canonical",
        help="输入输出适配协议",
    )

    mcp_cmd = sub.add_parser("mcp", help="同步工作区与全局 MCP 配置")
    mcp_cmd.add_argument(
        "-a",
        "--harness",
        choices=("all", *HARNESS_ADAPTERS.keys()),
        default="all",
        help="目标 Harness",
    )
    mcp_cmd.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="覆盖已存在的全局用户级 MCP 条目",
    )

    status_cmd = sub.add_parser("status", help="查看各 Harness 的挂钩与 MCP 状态")
    status_cmd.add_argument(
        "-a",
        "--harness",
        choices=("all", *HARNESS_ADAPTERS.keys()),
        default="all",
        help="目标 Harness",
    )
    ns = parser.parse_args(argv)
    return CliArgs(
        command=cast(Literal["gate", "mcp", "status"], ns.command),
        harness=cast(str, ns.harness),
        force=bool(getattr(ns, "force", False)),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Entrypoint for scripts/harness CLI."""
    args = parse_args(argv)
    if args.command == "gate":
        return run_gate(args.harness)
    if args.command == "mcp":
        sync_mcp(args.harness, force=args.force)
        return 0
    return print_status(args.harness)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        OSError,
        RuntimeError,
        TypeError,
        ValueError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"Harness 工具失败：{error}", file=sys.stderr)
        sys.exit(1)
