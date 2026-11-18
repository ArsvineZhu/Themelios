"""Prepare the workspace search tools and Agent Harness integrations."""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import cast

ROOT = Path(__file__).resolve().parents[1]
HARNESS_DIR = ROOT / "scripts" / "harness"
if str(HARNESS_DIR) not in sys.path:
    sys.path.insert(0, str(HARNESS_DIR))

from manage import (
    build_mcp_servers,
    sync_mcp,
)
from manage import (
    load_config as load_harness_config,
)
from manage import (
    print_status as print_harness_status,
)

TOOLS = ROOT / "temp" / "tools"
BUN_TOOLS = Path(
    os.environ.get("THEMELIOS_BUN_DIR", TOOLS / f"bun-{platform.system().lower()}")
)
BUN = (
    BUN_TOOLS
    / "node_modules"
    / "bun"
    / "bin"
    / ("bun.exe" if os.name == "nt" else "bun")
)
ZG_BIN = TOOLS / "zvec-grep" / "node_modules" / "@zvec" / "zvec-grep" / "bin"
ZG = ZG_BIN / ("zg.exe" if os.name == "nt" else "zg")
AST_GREP_MCP = (
    "git+https://github.com/ast-grep/ast-grep-mcp@"
    "51d5a23f025c73c02032a98748dc06942548c5e1"
)
AST_GREP_TOOL = TOOLS / f"uv-tools-{platform.system().lower()}"
AST_GREP_BIN_DIR = TOOLS / f"uv-bin-{platform.system().lower()}"
AST_GREP_SERVER = AST_GREP_BIN_DIR / (
    "ast-grep-server.exe" if os.name == "nt" else "ast-grep-server"
)


def executable(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(f"找不到 {name}，请先安装并加入 PATH。")
    return path


def zvec_executable() -> str | None:
    if ZG.is_file():
        return str(ZG)
    installed = shutil.which("zg")
    if not installed:
        return None
    # npm's Windows shim points to an executable next to the global packages.
    candidate = (
        Path(installed).parent
        / "node_modules"
        / "@zvec"
        / "zvec-grep"
        / "bin"
        / ZG.name
    )
    return str(candidate) if candidate.is_file() else installed


def run(*args: str, env: dict[str, str] | None = None) -> None:
    print("运行:", " ".join(args), flush=True)
    subprocess.run(args, cwd=ROOT, env=env, check=True)


def install(prefix: Path, package: str) -> None:
    env = os.environ.copy()
    env["ZG_INSTALL_ACCELERATOR"] = "cpu"
    env["ZG_INSTALL_SKIP_AGENT_UPGRADE"] = "1"
    run(
        executable("npm"),
        "install",
        "--prefix",
        str(prefix),
        "--no-audit",
        "--no-fund",
        package,
        env=env,
    )


def prepare_toolchain() -> None:
    raw_package = cast(
        object, json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    )
    if not isinstance(raw_package, Mapping):
        raise TypeError("package.json 格式无效。")
    package = cast(Mapping[str, object], raw_package)
    manager = package.get("packageManager")
    if not isinstance(manager, str) or not manager.startswith("bun@"):
        raise RuntimeError("package.json 必须指定 Bun 版本。")
    version = manager.removeprefix("bun@")
    installed = ""
    if BUN.is_file():
        try:
            result = subprocess.run(
                [str(BUN), "--version"], capture_output=True, text=True, check=False
            )
            if result.returncode == 0:
                installed = result.stdout.strip()
        except OSError:
            pass
    if installed != version:
        run(
            executable("npm"),
            "install",
            "--prefix",
            str(BUN_TOOLS),
            "--no-save",
            "--no-package-lock",
            "--no-audit",
            "--no-fund",
            manager,
        )
    run(str(BUN), "install", "--frozen-lockfile")


def prepare_git_hook() -> None:
    """Install Fallow's staged-change gate without replacing an existing hook."""
    result = subprocess.run(
        [str(BUN), "run", "fallow", "hooks", "status", "--format", "json", "--quiet"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    raw_status = cast(object, json.loads(result.stdout))
    if not isinstance(raw_status, Mapping):
        raise TypeError("无法解析 Git 钩子状态。")
    hooks = cast(Mapping[str, object], raw_status).get("hooks")
    if not isinstance(hooks, Mapping):
        raise TypeError("无法解析 Git 钩子状态。")
    hook = cast(Mapping[str, object], hooks).get("git")
    if not isinstance(hook, Mapping):
        raise TypeError("无法解析 Git 钩子状态。")
    git_hook = cast(Mapping[str, object], hook)
    if git_hook.get("installed"):
        if not git_hook.get("managed_block_present"):
            raise RuntimeError(
                "已有其他 Git pre-commit 钩子，请将 Fallow 门禁合并到现有钩子。"
            )
        return
    run(str(BUN), "run", "fallow", "hooks", "install", "--target", "git")


def sync_graph(graph: str) -> None:
    """Wait for an active index writer without removing its lock."""
    for attempt in range(4):
        result = subprocess.run(
            [graph, "sync"], cwd=ROOT, capture_output=True, text=True, check=False
        )
        if result.returncode == 0:
            print(result.stdout, end="", flush=True)
            return
        output = result.stdout + result.stderr
        if "lock" not in output.lower() or attempt == 3:
            raise RuntimeError(f"CodeGraph 同步失败：{output.strip()}")
        print("CodeGraph 正在更新，稍候重试。", flush=True)
        time.sleep(1)


def prepare_ast_grep_mcp(environment: dict[str, str]) -> None:
    """Install the pinned ast-grep MCP server binary into temp/tools when needed."""
    receipt = AST_GREP_TOOL / "sg-mcp" / "uv-receipt.toml"
    revision = AST_GREP_MCP.rsplit("@", 1)[1]
    installed = receipt.is_file() and revision in receipt.read_text(encoding="utf-8")
    if installed and AST_GREP_SERVER.is_file():
        try:
            result = subprocess.run(
                [str(AST_GREP_SERVER), "--help"],
                cwd=ROOT,
                env=environment | {"PYTHONHOME": ""},
                capture_output=True,
                text=True,
                check=False,
            )
            installed = result.returncode == 0
        except OSError:
            installed = False
    else:
        installed = False
    if not installed:
        tool_environment = environment | {
            "UV_TOOL_DIR": str(AST_GREP_TOOL),
            "UV_TOOL_BIN_DIR": str(AST_GREP_BIN_DIR),
        }
        run(
            executable("uv"),
            "tool",
            "install",
            "--force",
            f"sg-mcp @ {AST_GREP_MCP}",
            env=tool_environment,
        )


def init() -> None:
    prepare_toolchain()
    prepare_git_hook()
    graph = shutil.which("codegraph")
    local_bin = TOOLS / "codegraph" / "node_modules" / ".bin"
    local_graph = local_bin / ("codegraph.cmd" if os.name == "nt" else "codegraph")
    if not graph and not local_graph.exists():
        install(TOOLS / "codegraph", "@colbymchenry/codegraph@1.6.2")
    graph = graph or str(local_graph)
    zg = zvec_executable()
    if not zg:
        install(TOOLS / "zvec-grep", "@zvec/zvec-grep@0.3.0")
        zg = str(ZG)
    environment = os.environ.copy()
    environment["ZVEC_GREP_HOME"] = str(TOOLS / "zvec-grep" / "runtime")
    environment["ZVEC_GREP_MODEL_CACHE"] = str(TOOLS / "zvec-grep" / "models")
    # Let CodeGraph select its platform-specific index directory, including WSL.
    print("准备 CodeGraph 索引。", flush=True)
    subprocess.run([graph, "init"], cwd=ROOT, stdin=subprocess.DEVNULL, check=True)
    sync_graph(graph)
    run(
        zg,
        "--index",
        str(ROOT),
        "--mode",
        "direct",
        "--embedding",
        "local/potion-retrieval-32m",
        "--model-cache",
        environment["ZVEC_GREP_MODEL_CACHE"],
        "--glob",
        "!legacy/**",
        "--glob",
        "!docs/sources/**",
        env=environment,
    )
    # An installed npm shim is resolved via PATH; a local install uses Node directly.
    if Path(graph) == local_graph:
        graph_command = executable("node")
        shim = (
            TOOLS
            / "codegraph"
            / "node_modules"
            / "@colbymchenry"
            / "codegraph"
            / "npm-shim.js"
        )
        graph_args = [str(shim), "serve", "--mcp"]
    else:
        graph_command, graph_args = graph, ["serve", "--mcp"]
    prepare_ast_grep_mcp(environment)
    servers = build_mcp_servers(
        load_harness_config(),
        graph_command=graph_command,
        graph_args=graph_args,
        zg_path=zg,
    )
    sync_mcp("all", servers=servers)
    print(
        "工作区检索工具与 Harness 适配器已就绪。各客户端重连 MCP 或重启后生效。",
        flush=True,
    )


def status() -> None:
    run(str(BUN), "--version")
    run(executable("codegraph"), "status")
    zg = zvec_executable()
    if not zg:
        raise RuntimeError("找不到 zg，请先初始化工作区。")
    run(zg, "--status", "--mode", "direct")
    print_harness_status("all")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ("init", "status"):
            raise RuntimeError("用法：workspace init|status")
        (init if sys.argv[1] == "init" else status)()
    except (
        OSError,
        RuntimeError,
        TypeError,
        ValueError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"工作区初始化失败：{error}", file=sys.stderr)
        sys.exit(1)
