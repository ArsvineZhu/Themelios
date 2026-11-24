# 模型与提示词

`@themelios/models` 基于 Vercel AI SDK 提供厂商中立的模型访问、提示词编译、任务定义与多模态输入准备能力，同时支持独立嵌入与完整应用装配。

## 网关连接与显式能力绑定

模型体系将**网关连接（`Connection`）**与**模型绑定（`ModelBinding`）**明确解耦：

- `Connection` 声明协议（`openai-compatible`、`openai`、`google`、`cohere`）、`baseURL` 与凭据引用（`credential`）。任何提供统一网关协议的服务都可以标准连接方式接入，框架不为特定外部平台编写专有业务分支。
- `ModelBinding` 声明 `connection`、`providerModel`、`capabilities`（支持的 `operations`、`inputMimeTypes`、`needs` 模态、`structuredOutput`、`streaming`、`limits`）与参数默认值；不根据模型 ID 字符串猜测能力。
- 绑定、任务路由和单次请求依次提供模型参数。`providerOptions` 按提供方逐字段覆盖，因此可以给本次调用新增一个选项，同时沿用任务设置的接口类型。
- 一项任务可显式列出按序尝试的 `fallback` 模型绑定。只有主模型的连接不可用或被限流时才会尝试下一绑定。所有候选共享任务期限，执行时按各绑定能力准备材料；已经输出正文或单次请求显式选定模型时，维持该次调用的绑定。
- 需要结构化对象输出的任务，结构 Schema 通过 `providerOutputSchema` 检查必填约束后下发给模型，并结合 `validateOutput` 与来源校验保证语义正确。

## 提示词（Liquid）与 AST 缓存

`createPrompts({ resourceRoot, overrideRoot, locale })` 与内联模板协同工作：

- **文件模板与实例覆盖**：从 `resourceRoot/<taskId>/` 加载内建模板，并以 `<instance>/config/prompts/<taskId>/` 覆盖；支持 `read`、`describe`、`diff`、`setOverride` 与 `reset`。
- **内联模板与直接标题**：`defineTask` 允许使用 `templates: { inline: true, system?, user }` 及明文 `title` / `purpose`，无需磁盘目录或翻译字典即可定义并运行任务。
- **AST 缓存与严格变量域**。重用未变更的入口模板 AST。每次渲染按实例覆盖和内建资源的顺序读取实际引用的局部模板。`system` 模板可访问 `{ task, examples }`，`user` 模板可访问 `{ ...variables, sources }`。渲染时严格校验变量与过滤器。

## 多模态输入准备与表示复用

`createPreparation` 与 `createTasks` 协调完成从原始输入到模型实际请求分片的全流程：

- **输入形态**。支持存储选区 `Selection`、成果输出 `{ result, output }`、内存字节 `{ bytes, mediaType }`、原始文本 `{ text }` 与本地路径 `{ path }`。`result` 可传入本次生成的 `Completed` 或已保存成果的 `ArtifactRef`。已保存成果在任务的期限和取消范围内读取。`tasks.preview` 展示已准备部件和待执行配方。部件齐备时与执行使用同样的完整请求预算校验。
- **适配路由**。根据任务输入和模型能力选择原生发送、`RepresentationAdapter` 转换或辅助模型。适配器可声明匹配媒体何时必须规范化，例如图像需要朝正。转换路线使用选中的适配器探测原件。可选解码器无法读取原生附件时，原件范围保持未知，附件继续按模型的原生能力处理。图像适配器在实际编码时使用默认质量，显式指定 JPEG 或 WebP 质量可要求重新编码。
- **来源与选区**：每项记录原件范围、请求选区，以及实际交付部件的媒体类型和覆盖范围。需要时间选区的模型路线必须先产出实际切片；内建 PCM WAV 适配器按采样帧选择字节。无法安全提取选区时，在发出模型请求前返回能力错误。
- **表示复用**。预览和执行通过 `PreparationStore` 查找相同选区与生效配方的已保存表示。配方身份包含参数和适配器声明的运行条件，例如 FFmpeg 的实际可执行文件身份。任务装配与适配器目录按调用捕获的配置快照复用。Content 负责保存和登记。
- **辅助提示词**：自动 `media.describe` 使用同一任务与实例模板。已保存表示的匹配考虑模型身份与实际编译的提示词，包括被引用的局部模板。任务路由可提供变量默认值，单次任务输入可覆盖。

## 独立嵌入式使用入口

调用方仅配置模型连接、绑定与路由时，可以直接调用 `models.runTask(task, request, options)` 执行任务：不需要创建 `Installation`、`Database`、`Cas` 或 `ApplicationModule`，返回值是带完整来源结构的 `Completed<O>`。
