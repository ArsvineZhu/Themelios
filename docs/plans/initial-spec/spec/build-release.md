# 构建与发行产出可独立消费的软件

Themelios 的本期交付包含正式 ESM 包、独立工作台与 Windows、Linux Portable 发行目录。外部应用从包 `exports` 调用公开接口，Portable 自带 Bun、程序、目标平台原生依赖及资源。Themelios 完成独立消费验证后停止，Nous 与 Nexus 的业务开发另行开展。

## 现有 Agent 工具链直接承担施工

用户已经在本机初始化工作区。实施入口先读取该工作区的 AGENTS、package.json、bunfig.toml、tsconfig、工具配置与未提交改动，将本包的文件责任映射到真实路径。保留已经配置好的 Agent 工具、统一检查和命令行为；新增能力接入现有入口。

用户提供的基线为 Bun 1.4.4、TypeScript 7.0.2、Zod 4.6.7、Rust 1.100.0、napi-rs 3.x；原型的 napi-rs 为 3.16.2。Node 24 只承担需要 Node 的构建辅助。Bun workspaces、catalog、isolated linker 与 bun.lock；Rust workspace 与 Cargo.lock 分别固定依赖。工具为 bun:test、Bun fmt、oxlint 1.93、ast-grep 0.51、nextest 0.9.152、Lefthook 2.2.2。实施仓已有精确补丁号和命令作为执行依据，新增依赖写入同一锁文件。

CodeGraph 用于查所有权、生产者与消费者；Context7 用于查实际依赖 API；Fallow 用于定位失效依赖与导出。它们服务于开发，发行物只携带产品运行需要的依赖。

`check:repo` 保持单一非交互入口。成功输出一行汇总；失败列出文件、规则、具体原因和可执行的重跑命令。局部修改调用相应检查目标，集成完成再运行完整检查。Lefthook 转调同一脚本，避免不同入口维护不同规则。

## 包出口就是跨包边界

本包架构中的公共包各有 package.json、src、dist、resources 和 tsconfig。`type` 固定为 `module`。公开入口由各包的 package.json `exports` 明确列出；每项同时指向 JavaScript 和声明文件。示例：

```json
{
  "name": "@themelios/models",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist", "resources", "README.md", "LICENSE"],
  "exports": {
    ".": {
      "types": "./dist/types/index.d.ts",
      "import": "./dist/index.js"
    },
    "./prompts": {
      "types": "./dist/types/prompts/index.d.ts",
      "import": "./dist/prompts/index.js"
    }
  }
}
```

公开入口固定如下；对应能力及依赖方向见 [架构](architecture.md)。每个子入口都在所属包的 exports 中列出实际 types/import 目标。

| 包入口 | 公开内容 |
| --- | --- |
| `@themelios/core` | Json、Selection、Completed、SavedFile、SavedResult、Flow、AppError 等共同值与 Schema |
| `@themelios/core/time` | 通用时间值、同域比较；不加载数据库 |
| `@themelios/runtime` | Installation、ApplicationModule、Session 及 runtime 公开合同；同时重导出 runtimeSettings、combineSettings |
| `@themelios/runtime/settings` | runtimeSettings、combineSettings、SettingsDefinition 与配置元数据合同 |
| `@themelios/runtime/network` | createNetwork、Network 与 NetworkOptions |
| `@themelios/runtime/secrets` | createSecrets、Secrets 与 CredentialRef |
| `@themelios/runtime/diagnostics` | Diagnostics 及公开日志/追踪合同 |
| `@themelios/storage` | Database、Cas、事务与公开维护方法 |
| `@themelios/storage/time` | createTimeDomains、timeSchemaSql、TimeDomains 与时间映射合同 |
| `@themelios/content` | createContent、Materials、Results、Representations |
| `@themelios/content/schema` | contentSchemaSql |
| `@themelios/models` | createModels、Models、连接/能力/请求/结果合同 |
| `@themelios/models/tasks` | defineTask、TaskDefinition、TaskDescription 与任务值合同 |
| `@themelios/models/prompts` | createPrompts、Prompts 及模板/编译预览合同 |
| `@themelios/application` | ApplicationApi、Operation 与应用装配合同 |
| `@themelios/application/tasks` | createTasks 与实际任务执行接口 |
| `@themelios/application/inputs` | createPreparation、createTextualize、来源与表示扩展合同 |
| `@themelios/transports` | CLI、HTTP、MCP、gRPC 适配器工厂与 Wire 合同 |

每个拥有本地化词典的包在自身 exports 中提供 `./locales` 子出口，命名导出 `locales` 常量，类型为 `语言 -> 完整messageKey -> 模板`。应用按 [诊断与网络](observability-network.md) 的合并规则组成 ApplicationModule.locales；例如 Runtime 词典使用 `@themelios/runtime/locales`，Content 词典使用 `@themelios/content/locales`。locales、runtime/settings、network、secrets 与 diagnostics 子入口只加载本能力，导入它们不会打开实例或装载文件锁 Native。

schema、类型、资源加载函数从这些入口提供。资源文件留在所属包，由该包基于 `import.meta.url` 找到；应用的覆盖目录由实例解析器提供。

TS 使用 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes 与 project references。跨包导入经解析后必须属于该包已声明的 dependencies，并经过其 exports。同包合法 `../../` 继续使用；只看字符串形状的禁止规则会误伤正常模块组织。

边界检查复用 TypeScript 解析结果，覆盖静态 import/export、字面量动态 import 和 require。运行依赖写 dependencies；纯开发工具写 devDependencies；只在类型中使用的公开依赖仍需让消费者能够解析声明。ast-grep 承担少量可以准确表达的项目规则；包归属判断放在现有包边界脚本中。

## JavaScript 与声明从同一份源代码构建

`scripts/build-packages.ts` 读取工作区 manifests 与真实依赖，按拓扑顺序构建。

1. 运行固定 TypeScript 的声明构建：各包设置 composite、declaration、emitDeclarationOnly、rootDir=src、outDir=dist/types。项目引用负责声明顺序。
2. 对 exports 对应的 TS 入口调用 Bun.build，目标 Bun、格式 ESM，第三方及其他工作区包保持 external；包内模块可以由 bundler 整理。多入口共享 chunk 留在同一 dist。
3. 复制当前包声明的 resources。默认 Prompt、语言资源、任务说明与 proto 产物都由它们的生产者生成后进入包内容。
4. 构建 runtime 原生模块及实际启用的扩展，再完成依赖这些模块的工作台入口。

工作区日常运行也通过 dist exports。第一次执行测试/工作台前完成一次构建，后续按改动增量更新。现有开发命令可以提供 watch；一次性检查保持非交互。类型检查使用 `bun check --no-script -b`，声明构建使用现有固定 TypeScript 工具，检查入口不重复运行两套同目的全仓检查。[Bun type checking](https://bun.sh/docs/runtime/check)

构建以声明、JavaScript 与资源全部写入完成作为成功。失败返回非零并指出未完成的包；发行脚本只使用本次成功构建的产物。执行者可改变内部构建并发与缓存，保持 exports、资源与目标产物一致。

## 本地包是独立消费的输入

`scripts/pack-packages.ts` 先确认各包 build 成功，再在每个可发行包目录执行 `bun pm pack --destination <absolute-artifacts-dir> --quiet`。实际文件写入 `artifacts/packages/`。由 Bun 将 workspace/catalog 引用转换为普通版本；检查打包后的 package.json 中所有内部依赖都有本批次对应版本。[Bun pack](https://bun.sh/docs/pm/cli/pm)、[workspaces](https://bun.sh/docs/pm/workspaces)

独立消费者创建在 Themelios 仓库之外，只安装这一批 tgz 与自身依赖。一次安装显式列出需要的 Themelios tgz，使未发布到 registry 的内部包由同批文件满足。consumer 的 tsconfig、运行目录和锁文件由 consumer 自己持有。验证时临时关闭源码路径别名，消费者只使用 `@themelios/*` 公共入口。

本期包版本统一从 0.1.0 发布候选起步；如果实施仓已经有有效版本，沿用当前版本序列。公网 scope 的注册和 npm/GitHub Release 发布属于另一次授权；本次施工完成本地 tgz 与 Portable 候选即可。

未来 Nous 用 submodule 固定 Themelios/Nexus 的源码提交；各子仓仍在自己的根目录安装、构建和打包。Nous 安装它们的发行包，自己的 Bun workspace/catalog/lockfile 保持独立。

## Portable 采用完整目录布局

默认发行实现采用自带 Bun 的目录包。这样目标系统直接装载 sharp、libvips 和 runtime N-API 模块，路径与普通包运行保持一致。Bun 的单文件编译可作为后续发行优化，替换时继续满足同一移动、原生装载与资源验收。[Bun executable](https://bun.sh/docs/compiler/executables)、[sharp installation](https://sharp.pixelplumbing.com/install/)

| 位置 | 内容与所有者 |
| --- | --- |
| `themelios` / `themelios.cmd` | 启动器；根据自身路径定位安装根，保留调用者 cwd |
| `runtime/bun` / `runtime/bun.exe` | 固定目标平台 Bun 运行时 |
| `app/release.json` | 发行版本、目标平台、启动入口、能力和资源位置 |
| `app/launch.mjs` | 读取发行清单、验证目标并导入实际应用入口 |
| `app/package.json`、`app/bun.lock` | 已构建应用的依赖清单与锁定解析 |
| `app/packages/*/dist`、`app/packages/*/resources` | 已构建的公共包和资源 |
| `app/apps/workbench/dist` | 独立工具的实际入口 |
| `app/node_modules` | 目标平台完整生产依赖 |
| `config/installation.toml` | 安装级人工配置 |
| `instances/<name>/` | 实例配置、SQLite、CAS、日志与运行信息 |
| `LICENSE`、`THIRD-PARTY-NOTICES` | 实际分发组件需要的许可文本 |

`release.json` 中的全部路径相对安装根；正式材料引用与实例身份保持路径无关。启动器向程序传安装根与原始 cwd 两个内部启动值。CLI 里的相对输入文件、输出文件按原始 cwd 解析；实例内路径按实例根解析。

发行清单使用以下固定形状，空的 recipes/tools 仍写空数组或空对象。packages 记录本次安装的 Themelios 包版本；recipes 从实际装配的 RepresentationAdapter.description 生成，工具位置只收本次随包分发的程序。

```ts
interface ReleaseManifest {
  schemaVersion: 1;
  applicationId: string;
  formatId: string;
  version: string;
  target: 'windows-x64-msvc' | 'linux-x64-gnu';
  runtime: { name: 'bun'; version: string; path: string };
  entry: string;
  packages: Record<string, string>;
  recipes: { id: string; version: string }[];
  tools: Record<string, string>;
}
```

`runtime.path` 分别为 `runtime/bun.exe` 或 `runtime/bun`，entry 为 `app/apps/workbench/dist/main.js`。启动器先用固定位置的 Bun 执行 `app/launch.mjs`；该文件读取清单，检查 schemaVersion、目标平台和入口存在，然后以文件 URL 导入入口，向入口传递安装根、原始 cwd 与未改写的用户参数。清单中的路径拒绝绝对值及越出安装根的解析结果。applicationId/formatId 来自同一 ApplicationModule，运行配置另从 installation.toml 与实例配置读取。

## 构建脚本在独立 staging 组装发行物

`scripts/build-portable.ts` 接收 `--target windows-x64-msvc|linux-x64-gnu` 和 `--output <directory>`。默认目标是当前受支持平台；第一批发行目标固定 Windows x64 与 Linux x64 glibc。其他 OS/CPU 由后续实际需求增加。

1. 以 `artifacts/staging/<target>-<unique>/` 作为本次私有目录。写入所需 workspace manifests、原始 bun.lock 和已构建 dist/resources/native；目录结构与工作区路径一致。缺少任一 exports 目标、资源或 native 产物时停止，并给出具体路径。
2. staging 的 app 目录保持原始依赖声明和 catalog；使用 `bun install --production --frozen-lockfile --linker hoisted --filter '@themelios/workbench...'` 安装工作台及工作区依赖闭包。若实际工作台包名不同，脚本从 `apps/workbench/package.json` 取准确名称。关闭 globalStore，保留 optional dependencies，沿用项目已批准的 trustedDependencies。staging 是新目录，因此其中没有历史 devDependencies 残留。
3. 原生模块在目标平台构建/取得：Windows 使用 MSVC 目标，Linux 使用 GNU 目标。sharp 的目标二进制与 libvips 按目标平台安装，runtime 自有 `.node` 从本次 Rust 构建复制。发行脚本只收当前 target 对应的 native 产物。
4. 将固定版本 Bun 运行时复制到 runtime/；从实际 `bun --version`、目标平台和本次构建产物写 release.json。程序入口始终由发行清单解析。
5. 使用标准文件复制将 staging 内部 workspace 链接物化到最终发行树；第三方链接同样解析到普通文件。链接目标必须位于 staging 内，指向开发工作区或全局 cache 的链接直接报错。已有标准复制/归档工具承担复制，不实现新的依赖解析器。
6. 写启动器、默认安装配置和所需许可文本，随后运行下面的真实使用场景。全部成功后将完整候选目录移动至 output，再生成 ZIP 或 tar.gz。中途失败只清理本次 staging，保留已存在的其他发行候选。

开发仓继续使用 isolated linker。Portable 的 hoisted staging 只是物理发行布局，包级正式依赖仍由开发检查及 tgz 独立消费约束。[Bun filter](https://bun.sh/docs/pm/filter)、[Bun install](https://bun.sh/docs/pm/cli/install)、[isolated installs](https://bun.sh/docs/pm/isolated-installs)

构建脚本使用 Bun/TypeScript 和参数数组启动子进程；路径作为单独参数传入。默认无交互、无隐藏付费请求；stdout 返回产物目录，详细构建失败在 stderr。正式启动器使用 `bun --no-install <absolute-app-launch.mjs> ...`，缺依赖立即报告发行缺失。[Bun runtime flags](https://bun.sh/docs/runtime)

## 原生模块跟随拥有它的能力发行

Runtime 的原生锁实现位于 Cargo crate `native/runtime`，crate 名 `themelios-runtime-native`。napi-rs 生成 `packages/runtime/native/<target>/themelios_runtime.node`，TS 内部加载器位于 `packages/runtime/src/native.ts`。包的 files 收入实际支持目标的 native 目录；调用者使用 Installation/Instance 公开接口。

加载器按 `process.platform`、`process.arch` 和受支持的 libc 目标选择路径。找不到目标时返回 `runtime.native_unavailable`，详情为所需 target、运行时版本与模块路径，启动在打开数据库前结束。Native 包版本与 runtime 包版本同批生成；N-API 版本、Bun 实际装载、Rust 锁的两个进程互斥行为在原生集成场景中检查。

Rust 内部只承担锁所需的 OS 资源寿命与 N-API 绑定；配置、实例布局、错误翻译和任务编排由 TS owner 负责。Nexus 以后发布其数值 crate/绑定时，独立拥有其源码、Cargo.lock、包与二进制；Themelios 只按正式 exports 消费实际需要的能力。

sharp 通过自己的 npm 包及平台 optional dependency 装载。发行物保留其 libvips 动态库目录；图片验收调用 resize/裁剪并读回真实图像尺寸，检查实际转换结果。[sharp installation](https://sharp.pixelplumbing.com/install/)

PDF、音频、视频扩展的工具选择及能力边界由 [输入管线](input-pipeline.md) 定义。发行 manifest 列出实际打包能力。若某扩展选择外部可执行程序，将其目标平台文件放在 `app/resources/tools/<target>/`，调用使用明确绝对路径；允许用户配置既有工具路径时，该路径按定义它的配置文件解析。

## 命令入口保持少而完整

| 命令 | 产出或行为 |
| --- | --- |
| `bun run check:repo` | 现有格式、类型、lint、包边界与正式本地测试；付费模型调用独立执行 |
| `bun run build:packages` | JavaScript、声明、资源与当前平台 native；支持 `--watch` 时明确由调用者选择 |
| `bun run pack:packages` | `artifacts/packages/*.tgz`，已解析普通依赖版本 |
| `bun run build:portable -- --target windows-x64-msvc` | Windows 完整 Portable 候选 |
| `bun run build:portable -- --target linux-x64-gnu` | Linux glibc 完整 Portable 候选 |
| `bun run docs:tasks` | 从实际任务定义生成任务、输入输出、Prompt 位置和运行示例 |
| `bun run test:distribution` | 仓库外 tgz 消费、当前平台移动后启动与原生能力 |
| `bun run test:live` | 读取显式 provider 配置，执行少量真实模型应用场景 |

已存在的同义入口可以保留原名并在 README 给出映射；产品能力与统一行为保持本章要求。检查脚本支持按文件/包缩小范围，不引入逐任务提交或逐任务评审制度。

## 发行完成条件来自独立使用

在一台没有 Themelios 源码路径、没有单独 Bun/Node 开发环境的目标系统中，解压到带空格与中文的目录。完成以下操作：

1. 启动工作台并 init/open 一个实例；查看配置说明；在错误配置下得到可读的启动原因。
2. 接纳 UTF-8 文本和一张真实图片，读取选区、执行图片变换、保存和重开成果；将整个 Portable 目录移动后重做读取。
3. 运行一个真实模型任务，保存后关闭，断开 provider 再读出结果与来源。配置问题和模型请求失败能够定位到实际连接/任务。
4. 启动 HTTP、MCP 与 gRPC 入口，用正式客户端分别调用同一任务/材料操作；取消一个流，确认上游请求与当前资源结束。
5. 从另一进程打开同一实例，收到占用错误；主进程正常退出或被终止后，新进程能够重新打开。

这组操作的实现位置和执行先后见 [发行实施计划](../plan/distribution.md)。各平台分别记录实际运行结果；无法运行某一目标时，该目标保持未完成并说明所缺执行环境。最终提交包含真实产物路径、最短使用示例与已知功能缺口，完成后停止 Themelios 本期施工。
