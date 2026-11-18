# 模型与提示词

`@themelios/models` 基于 Vercel AI SDK 提供厂商中立的模型访问、提示词编译、任务定义与多模态输入准备能力，同时支持独立嵌入与完整应用装配。

## 网关连接与显式能力绑定

模型体系将**网关连接（`Connection`）**与**模型绑定（`ModelBinding`）**明确解耦：

- `Connection` 声明协议（`openai-compatible`、`openai`、`google`、`cohere`）、`baseURL` 与凭据引用（`credential`）。任何提供统一网关协议的服务都可以标准连接方式接入，框架不为特定外部平台编写专有业务分支。
- `ModelBinding` 声明 `connection`、`providerModel`、`capabilities`（支持的 `operations`、`inputMimeTypes`、`needs` 模态、`structuredOutput`、`streaming`、`limits`）与参数默认值；不根据模型 ID 字符串猜测能力。
- 需要结构化对象输出的任务，结构 Schema 通过 `providerOutputSchema` 检查必填约束后下发给模型，并结合 `validateOutput` 与来源校验保证语义正确。

## 提示词（Liquid）与 AST 缓存

`createPrompts({ resourceRoot, overrideRoot, locale })` 与内联模板协同工作：

- **文件模板与实例覆盖**：从 `resourceRoot/<taskId>/` 加载内建模板，并以 `<instance>/config/prompts/<taskId>/` 覆盖；支持 `read`、`describe`、`diff`、`setOverride` 与 `reset`。
- **内联模板与直接标题**：`defineTask` 允许使用 `templates: { inline: true, system?, user }` 及明文 `title` / `purpose`，无需磁盘目录或翻译字典即可定义并运行任务。
- **AST 缓存与严格变量域**：只加载任务入口及渲染实际引用的 partial，重用未变更模板的 Liquid AST。`system` 模板可访问 `{ task, examples }`，`user` 模板可访问 `{ ...variables, sources }`。渲染时严格校验变量与过滤器。

## 多模态输入准备与表示复用

`createPreparation` 与 `createTasks` 协调完成从原始输入到模型实际请求分片的全流程：

- **输入形态**：支持应用内已采用选区 `Selection`、内存字节 `{ bytes, mediaType }`、原始文本 `{ text }` 与本地路径 `{ path }`，通过 `tasks.preview` 可在不触发实际模型请求的情况下预览规划。
- **适配路由**：按任务输入需求与目标模型能力自动匹配原生发送、注册的 `RepresentationAdapter`（如 `@themelios/content` 的 `createImageAdapter` 朝正裁切缩放、 `@themelios/pdf` 的文本抽取/选页/光栅化渲染），或辅助模型策略（`media.describe` / `speech.transcribe`）。
- **表示复用**：预览和执行通过 `PreparationStore` 查找相同选区与生效配方的已保存表示，按原顺序加载实际输出。存储和登记由内容模块负责。

## 独立嵌入式使用入口

调用方仅配置模型连接、绑定与路由时，可以直接调用 `models.runTask(task, request, options)` 执行任务：不需要创建 `Installation`、`Database`、`Cas` 或 `ApplicationModule`，返回值是带完整来源结构的 `Completed<O>`。
