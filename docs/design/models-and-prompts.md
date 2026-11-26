# 模型与提示词

`@themelios/models` 基于 Vercel AI SDK 提供厂商中立的模型访问、提示词编译、任务定义与多模态输入准备能力，同时支持独立嵌入与完整应用装配。

## 网关连接与显式能力绑定

模型体系将**网关连接（`Connection`）**与**模型绑定（`ModelBinding`）**明确解耦：

- `Connection` 声明协议（`openai-compatible`、`openai`、`google`、`cohere`）、`baseURL` 与凭据引用（`credential`）。任何提供统一网关协议的服务都可以标准连接方式接入，框架不为特定外部平台编写专有业务分支。
- `ModelBinding` 声明 `connection`、`providerModel`、`capabilities`（支持的 `operations`、`inputMimeTypes`、`needs` 模态、`structuredOutput`、`streaming`、`limits`）与参数默认值；不根据模型 ID 字符串猜测能力。
- `modelConfigurationSchema` 定义默认值、绑定、连接和任务路由。实例和独立脚本都将此配置传给 `createModels(configuration, options?)`。`modelConfigurationIssues` 检查引用、向量空间和准备规则。`models.tasks` 使用客户端的任务路由、期限和并发策略。
- 绑定、任务路由和单次请求依次提供模型参数。`providerOptions` 按提供方逐字段覆盖，因此可以给本次调用新增一个选项，同时沿用任务设置的接口类型。
- 一项任务可显式列出按序尝试的 `fallback` 模型绑定。只有主模型的连接不可用或被限流时才会尝试下一绑定。所有候选共享任务期限，执行时按各绑定能力准备材料；已经输出正文或单次请求显式选定模型时，维持该次调用的绑定。
- `ModelOutput` 显式声明原始文本或结构化对象。生成器按模式向模型请求输出，并用声明的 Zod Schema 解析结果。定义结构化任务时，模型对象的字段需要明确设为必填。任务还可用 `validateOutput` 校验引用及其他业务约束。

## 提示词（Liquid）与 AST 缓存

`createPrompts({ resourceRoot, overrideRoot, locale })` 与内联模板协同工作：

- **文件模板与实例覆盖**：从 `resourceRoot/<taskId>/` 加载内建模板，并以 `<instance>/config/prompts/<taskId>/` 覆盖；支持 `read`、`describe`、`diff`、`setOverride` 与 `reset`。
- **内联模板与直接标题**：`defineTask` 允许使用 `templates: { inline: true, system?, user }` 及明文 `title` / `purpose`，无需磁盘目录或翻译字典即可定义并运行任务。
- **AST 缓存与严格变量域**。重用未变更的入口模板 AST。每次渲染按实例覆盖和内建资源的顺序读取实际引用的局部模板。`system` 模板可访问 `{ task, examples }`，`user` 模板可访问 `{ ...variables, sources }`。任务在准备材料前解析变量，经解析的值用于模板和输出校验。模板直接读取来源的结构字段，可用 `extent`、`range` 和 `delivery` 过滤器格式化原件范围、选区和单份交付。

## 多模态输入准备与表示复用

`models.tasks` 在调用内部完成从原始输入到模型实际请求分片的全流程。

- **输入形态**。每项材料通过 `source` 指定存储选区、成果输出、内存字节或本地文件。`source: { file }` 在任务内读取本地文件，Core 的 `inlineText(text)` 直接构建内联文本。成果来源的 `result` 可传入 `Completed` 或已保存成果的引用。已保存成果在任务的期限和取消范围内读取。预览、普通生成和流式生成沿用同一套路由与准备规则。独立处理材料时，`createPreparation` 提供 `preview` 查看已就绪内容和待执行配方，`prepare` 执行配方并返回实际交付。
- **适配路由**。任务以 `accepts` 指定可接受的模态组合，每个组合中的模态须同时满足。准备流程统一选择显式配方、原生发送、适配器转换或辅助模型。适配器可声明何时必须规范化，例如图像需要朝正。转换流程沿用已知的原件范围，缺少范围时使用选定的适配器探测。原生附件缺少可用解码器时，范围可保持未知。图像适配器的 JPEG 或 WebP 质量可按配方设置。
- **来源与选区**。每项来源计划保存原件、来源键、选区及实际交付范围。`Completed` 的 `inputs` 保留同一个键和原件元数据，Content 保存成果时携带它们。调用方可指定已保存成果的命名输出，例如把逐字稿交给文本模型，同时保留音频原件与对应时段。该输出须通过成果的输入关系关联到同一原件选区，覆盖范围取自成果记录。准备流程检查实际交付能满足任务和模型能力，并验证交付范围落在请求选区内。音视频选区由适配器裁切，PCM WAV 按采样帧选择字节。
- **表示复用**。预览和执行通过内容服务读取相同选区与生效配方的已保存表示。配方身份包含参数和适配器声明的运行条件，例如 FFmpeg 的实际可执行文件身份。任务装配与适配器目录按调用捕获的配置快照复用。Content 负责保存、登记及读回已保存表示。
- **辅助提示词**。自动 `media.describe` 使用同一任务及实例模板，并读取该任务的变量、模型参数、期限和尝试次数。已保存表示的匹配考虑模型身份、参数及实际编译的提示词，包括被引用的局部模板。任务路由的变量默认值可由单次任务输入覆盖。

## 独立嵌入式使用入口

配置模型连接、绑定与路由后，通过 `models.tasks` 预览、运行、流式运行或批量提交独立任务。运行结果是带完整来源结构的 `Completed<O>`；`presentTask(task, result, locale?)` 根据成果中记录的来源调用任务定义的呈现方法。
