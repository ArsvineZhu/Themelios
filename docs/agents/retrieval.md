# 代码与资料检索

工作区入口 `dev.ps1` 和 `dev.sh` 的 `env` 模式设置当前 shell 的开发环境并创建所需的 `temp/` 目录，不安装工具或配置 MCP。`init` 模式准备指定版本的 Bun 和开发依赖，安装缺失的 CodeGraph 和 Zvec-grep、准备本仓库索引并通过 `scripts/harness/` 同步已检测到的 Agent Harness（Codex、Antigravity 等）MCP 配置；按用户要求初始化后，在对应客户端重连 MCP 或重启生效。检索索引排除 `legacy/`；Zvec-grep 也排除历史讨论目录 `docs/sources/`。

## 检索本仓库

- 仓库已有 CodeGraph 索引时，定位源码或理解调用链先用 CodeGraph。`explore` 可同时获取相关源码和关系；已知符号需要单独定位时可用 MCP `codegraph_search`、CLI `codegraph query` 或 `node`，查调用关系可用 `callers`、`callees`、`impact`，指定文件区分同名符号。检查关键调用关系时结合精确文本搜索和实际源码。
- 不知道名称、需要跨代码和文档查找时，用 Zvec-grep 的 `zvec_grep_search` 或 `zg --hybrid "问题"`；定位源码仍先按上一条使用 CodeGraph。精确词项可用 `zg --fts "符号"`，穷尽引用可用 `zg --rg -F "符号" scripts`。中文文档可按中文问题搜索，英文代码问题可使用英文描述并按路径收窄。
- 索引可能滞后于文件修改。查询时关注新鲜度，CLI 需要同步结果时使用 `zg --refresh wait --hybrid "问题"`；现有 CodeGraph 索引需要更新时使用 `codegraph sync`。缺少索引时使用其他可用检索方式。

### CodeGraph：结构与上下文

在 MCP 中按需要使用 `codegraph_search`、`codegraph_node`、`codegraph_callers`、`codegraph_callees`、`codegraph_impact` 或 `codegraph_explore`。`node` 需要源码时传 `includeCode=true`；关系查询提供符号所在文件，避免同名符号混淆。`explore` 适合需要一组关联源码时使用，指定文件或符号，并按需要限制 `maxFiles`。

```sh
codegraph query configure_mcp
codegraph node configure_mcp --file scripts/workspace.py
codegraph callers zvec_executable --file scripts/workspace.py
codegraph explore "scripts/workspace.py init"
```

图关系用于发现调用路径；重要的修改范围需再通过 `zg --rg` 或 `rg` 及源码确认。查看索引状态用 `codegraph status`，更新用 `codegraph sync`。

### Zvec-grep：语义与词项发现

MCP 的 `zvec_grep_search` 以项目目录为 `root`，可按自然语言、词项或组合查询。CLI 示例：

```sh
zg --hybrid "where a cancelled blocking task waits before releasing resources" --limit 5
zg --vector "how workspace tools are initialized" --limit 5
zg --fts "configure_mcp" --limit 5
zg --rg -F "configure_mcp" scripts
zg --refresh wait --hybrid "后台工作重试" --glob 'docs/**'
```

默认向量模型在本地运行；索引保存在项目的 `.zvec-grep/`，模型与服务状态位于 `temp/tools/zvec-grep/`。`zg --status` 查看索引，`zg --index` 更新；显式 `--mode direct` 的查询默认不等待刷新。使用结果中的路径与行号阅读原文，不把历史讨论当成当前实现。

## 参考项目

选用或替换通用机制时，检索适用项目的实际代码和官方资料，结合 Themelios 的用途、接口和依赖决定采用方式。需要本地参考仓库时放在 `temp/reference-code/`。
