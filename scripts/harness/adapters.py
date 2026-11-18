"""Harness adapters for lifecycle gates and MCP server registration."""

from __future__ import annotations

import importlib
import json
import os
import shutil
import sys
import tempfile
import tomllib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, TypeVar, cast, final

_T = TypeVar("_T")


class _TomlTable(Protocol):
    def get(self, key: str, default: object = None) -> object: ...

    def __getitem__(self, key: str) -> object: ...

    def __setitem__(self, key: str, value: object) -> None: ...

    def pop(self, key: str, default: object = None) -> object: ...

    def setdefault(self, key: str, default: _T) -> _T: ...


class _TomlModule(Protocol):
    def parse(self, string: str) -> _TomlTable: ...

    def document(self) -> _TomlTable: ...

    def table(self) -> _TomlTable: ...

    def dumps(self, data: _TomlTable) -> str: ...


@dataclass(frozen=True)
class McpServer:
    """Canonical definition of a managed MCP server entry."""

    name: str
    scope: Literal["user", "workspace"]
    command: str
    args: list[str]
    cwd: str | None
    env: dict[str, str]
    startup_timeout_sec: int | None = None


@dataclass(frozen=True)
class GateRequest:
    """Normalized command-gate request parsed from harness hook stdin."""

    command: str
    cwd: str | None
    has_unicode_escape: bool


@dataclass(frozen=True)
class GateDecision:
    """Normalized command-gate result returned to a harness."""

    allow: bool
    reason: str = ""


@dataclass(frozen=True)
class HarnessStatus:
    """Observed harness presence and workspace integration status."""

    name: str
    detected: bool
    hook_configured: bool
    user_mcp: list[str]
    workspace_mcp: list[str]


class GateAdapter(Protocol):
    """Protocol for parsing hook stdin and emitting hook responses."""

    name: str

    def parse_gate_input(self, raw: str) -> GateRequest: ...

    def emit_gate_output(self, decision: GateDecision) -> int: ...


class HarnessAdapter(GateAdapter, Protocol):
    """Protocol for full agent harnesses supporting hooks and MCP sync."""

    def detect(self) -> bool: ...

    def sync_mcp(
        self, root: Path, servers: Sequence[McpServer], *, force: bool = False
    ) -> None: ...

    def status(
        self,
        root: Path,
        expected_user: Sequence[str],
        expected_workspace: Sequence[str],
    ) -> HarnessStatus: ...


def command_exists(cmd: str) -> bool:
    """Return True when an executable path or PATH command can be resolved."""
    if not cmd:
        return False
    return Path(cmd).is_file() or shutil.which(cmd) is not None


def atomic_write_text(path: Path, original: str, updated: str) -> bool:
    """Write LF text atomically when content changed; return True if written."""
    normalized = updated.replace("\r\n", "\n")
    if normalized == original:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False
    ) as temp:
        temporary = Path(temp.name)
        temp.write(normalized)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def _load_json(raw: str) -> object:
    return cast(object, json.loads(raw))


def _as_mapping(value: object) -> Mapping[str, object] | None:
    if isinstance(value, Mapping):
        return cast(Mapping[str, object], value)
    return None


def _parse_json_object(raw: str) -> dict[str, object]:
    data = _load_json(raw)
    if not isinstance(data, dict):
        raise TypeError("Hook payload must be a JSON object.")
    return cast(dict[str, object], data)


def _extract_present_names(
    mapping: object, expected: Sequence[str], *, check_enabled: bool = False
) -> list[str]:
    mapped = _as_mapping(mapping)
    if mapped is None:
        return []
    present: list[str] = []
    for name in expected:
        entry = _as_mapping(mapped.get(name))
        if entry is None:
            continue
        if check_enabled and entry.get("enabled") is False:
            continue
        present.append(name)
    return present


def _hook_uses_unified_tool(path: Path) -> bool:
    if not path.is_file():
        return False
    return "scripts/harness" in path.read_text(encoding="utf-8")


@final
class CanonicalAdapter:
    """Harness-neutral adapter reading {command, cwd} and emitting JSON."""

    name: str = "canonical"

    def parse_gate_input(self, raw: str) -> GateRequest:
        data = _parse_json_object(raw)
        cmd = data.get("command", "")
        cwd = data.get("cwd")
        return GateRequest(
            command=cmd if isinstance(cmd, str) else "",
            cwd=cwd if isinstance(cwd, str) else None,
            has_unicode_escape="\\u" in raw,
        )

    def emit_gate_output(self, decision: GateDecision) -> int:
        payload = (
            {"decision": "allow"}
            if decision.allow
            else {"decision": "deny", "reason": decision.reason}
        )
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0 if decision.allow else 2


@final
class CodexAdapter:
    """Adapter for Codex CLI hooks (.codex/hooks.json) and TOML MCP config."""

    name: str = "codex"

    def user_config_path(self) -> Path:
        home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
        return Path(home) / "config.toml"

    def workspace_config_path(self, root: Path) -> Path:
        return root / ".codex" / "config.toml"

    def hook_path(self, root: Path) -> Path:
        return root / ".codex" / "hooks.json"

    def detect(self) -> bool:
        return bool(
            os.environ.get("CODEX_HOME")
            or os.environ.get("CODEX_THREAD_ID")
            or os.environ.get("CODEX_SESSION_ID")
            or shutil.which("codex")
            or (Path.home() / ".codex").is_dir()
        )

    def parse_gate_input(self, raw: str) -> GateRequest:
        data = _parse_json_object(raw)
        tool_input = _as_mapping(data.get("tool_input"))
        cmd = tool_input.get("command", "") if tool_input is not None else ""
        cwd = data.get("cwd")
        return GateRequest(
            command=cmd if isinstance(cmd, str) else "",
            cwd=cwd if isinstance(cwd, str) else None,
            has_unicode_escape="\\u" in raw,
        )

    def emit_gate_output(self, decision: GateDecision) -> int:
        if decision.allow:
            return 0
        sys.stderr.write(f"{decision.reason}\n")
        return 2

    def sync_mcp(
        self, root: Path, servers: Sequence[McpServer], *, force: bool = False
    ) -> None:
        """Register user and workspace MCP servers in Codex TOML configs.

        Preserves existing valid user-global entries unless force=True.
        """
        user_servers = [s for s in servers if s.scope == "user"]
        workspace_servers = [s for s in servers if s.scope == "workspace"]
        self._sync_toml(
            self.user_config_path(),
            user_servers,
            preserve_valid=not force,
            include_cwd=False,
        )
        self._sync_toml(
            self.workspace_config_path(root),
            workspace_servers,
            preserve_valid=False,
            include_cwd=True,
        )

    def _sync_toml(
        self,
        path: Path,
        servers: Sequence[McpServer],
        *,
        preserve_valid: bool,
        include_cwd: bool,
    ) -> None:
        tomlkit = cast(_TomlModule, cast(object, importlib.import_module("tomlkit")))

        original = path.read_text(encoding="utf-8") if path.exists() else ""
        doc = tomlkit.parse(original) if original else tomlkit.document()
        table = doc.setdefault("mcp_servers", tomlkit.table())
        for item in servers:
            existing = _as_mapping(table.get(item.name))
            if preserve_valid and existing is not None:
                cmd = existing.get("command")
                if isinstance(cmd, str) and command_exists(cmd):
                    continue
            entry = table.setdefault(item.name, tomlkit.table())
            entry.pop("url", None)
            entry.pop("enabled_tools", None)
            entry.pop("disabled_tools", None)
            entry["command"] = item.command
            entry["args"] = list(item.args)
            if include_cwd and item.cwd is not None:
                entry["cwd"] = item.cwd
            entry["enabled"] = True
            if item.env:
                entry_env = entry.setdefault("env", tomlkit.table())
                for key, value in item.env.items():
                    entry_env[key] = value
            if item.startup_timeout_sec is not None:
                entry.setdefault("startup_timeout_sec", item.startup_timeout_sec)
        atomic_write_text(path, original, tomlkit.dumps(doc))

    def status(
        self,
        root: Path,
        expected_user: Sequence[str],
        expected_workspace: Sequence[str],
    ) -> HarnessStatus:
        user_data = _read_toml(self.user_config_path())
        workspace_data = _read_toml(self.workspace_config_path(root))
        return HarnessStatus(
            name=self.name,
            detected=self.detect(),
            hook_configured=_hook_uses_unified_tool(self.hook_path(root)),
            user_mcp=_extract_present_names(
                user_data.get("mcp_servers"), expected_user, check_enabled=True
            ),
            workspace_mcp=_extract_present_names(
                workspace_data.get("mcp_servers"),
                expected_workspace,
                check_enabled=True,
            ),
        )


@final
class AntigravityAdapter:
    """Adapter for Antigravity hooks (.agents/hooks.json) and MCP JSON configs."""

    name: str = "antigravity"

    def user_config_path(self) -> Path:
        gemini_dir = os.environ.get("ANTIGRAVITY_GEMINI_DIR") or str(
            Path.home() / ".gemini"
        )
        rel_dir = os.environ.get("ANTIGRAVITY_CONFIG_REL_DIR") or "config"
        return Path(gemini_dir) / rel_dir / "mcp_config.json"

    def workspace_config_path(self, root: Path) -> Path:
        return root / ".agents" / "plugins" / "themelios" / "mcp_config.json"

    def hook_path(self, root: Path) -> Path:
        return root / ".agents" / "hooks.json"

    def detect(self) -> bool:
        return bool(
            os.environ.get("ANTIGRAVITY_AGENT")
            or os.environ.get("ANTIGRAVITY_GEMINI_DIR")
            or shutil.which("agy")
            or (Path.home() / ".gemini" / "antigravity").exists()
            or (Path.home() / ".gemini" / "config").is_dir()
        )

    def parse_gate_input(self, raw: str) -> GateRequest:
        data = _parse_json_object(raw)
        tool_call = _as_mapping(data.get("toolCall"))
        args = _as_mapping(tool_call.get("args")) if tool_call is not None else None
        cmd = args.get("CommandLine", "") if args is not None else ""
        cwd = data.get("cwd")
        if not isinstance(cwd, str) or not cwd:
            workspace_paths = data.get("workspacePaths")
            if isinstance(workspace_paths, list):
                items = cast(list[object], workspace_paths)
                if items and isinstance(items[0], str):
                    cwd = items[0]
        return GateRequest(
            command=cmd if isinstance(cmd, str) else "",
            cwd=cwd if isinstance(cwd, str) else None,
            has_unicode_escape="\\u" in raw,
        )

    def emit_gate_output(self, decision: GateDecision) -> int:
        payload = (
            {"decision": "allow"}
            if decision.allow
            else {"decision": "deny", "reason": decision.reason}
        )
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return 0

    def sync_mcp(
        self, root: Path, servers: Sequence[McpServer], *, force: bool = False
    ) -> None:
        """Register user and workspace-plugin MCP servers for Antigravity.

        Preserves existing valid user-global entries unless force=True.
        """
        user_servers = [s for s in servers if s.scope == "user"]
        workspace_servers = [s for s in servers if s.scope == "workspace"]
        self._sync_json(
            self.user_config_path(),
            user_servers,
            preserve_valid=not force,
            replace_all=False,
        )
        self._sync_json(
            self.workspace_config_path(root),
            workspace_servers,
            preserve_valid=False,
            replace_all=True,
        )

    def _sync_json(
        self,
        path: Path,
        servers: Sequence[McpServer],
        *,
        preserve_valid: bool,
        replace_all: bool,
    ) -> None:
        original = path.read_text(encoding="utf-8") if path.exists() else ""
        if replace_all or not original.strip():
            doc: dict[str, object] = {}
        else:
            parsed = _load_json(original)
            if not isinstance(parsed, dict):
                raise TypeError(f"MCP 配置文件格式无效：{path}")
            doc = cast(dict[str, object], parsed)
        raw_servers = doc.setdefault("mcpServers", {})
        if not isinstance(raw_servers, dict):
            raise TypeError(f"mcpServers 必须是 JSON 对象：{path}")
        servers_map = cast(dict[str, object], raw_servers)
        for item in servers:
            existing = _as_mapping(servers_map.get(item.name))
            if preserve_valid and existing is not None:
                cmd = existing.get("command")
                if isinstance(cmd, str) and command_exists(cmd):
                    continue
            entry: dict[str, object] = {
                "command": item.command,
                "args": list(item.args),
            }
            if item.env:
                entry["env"] = dict(item.env)
            servers_map[item.name] = entry
        updated = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
        atomic_write_text(path, original, updated)

    def status(
        self,
        root: Path,
        expected_user: Sequence[str],
        expected_workspace: Sequence[str],
    ) -> HarnessStatus:
        user_data = _read_json(self.user_config_path())
        workspace_data = _read_json(self.workspace_config_path(root))
        return HarnessStatus(
            name=self.name,
            detected=self.detect(),
            hook_configured=_hook_uses_unified_tool(self.hook_path(root)),
            user_mcp=_extract_present_names(user_data.get("mcpServers"), expected_user),
            workspace_mcp=_extract_present_names(
                workspace_data.get("mcpServers"), expected_workspace
            ),
        )


def _read_toml(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _read_json(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    data = _load_json(path.read_text(encoding="utf-8"))
    return cast(dict[str, object], data) if isinstance(data, dict) else {}


GATE_ADAPTERS: dict[str, GateAdapter] = {
    "canonical": CanonicalAdapter(),
    "codex": CodexAdapter(),
    "antigravity": AntigravityAdapter(),
}

HARNESS_ADAPTERS: dict[str, HarnessAdapter] = {
    "codex": CodexAdapter(),
    "antigravity": AntigravityAdapter(),
}
