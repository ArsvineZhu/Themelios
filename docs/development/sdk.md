# 在应用中使用 Themelios

一段模型脚本可只安装 `@themelios/models`。需要材料、来源和保存时可组合 `@themelios/application`。自有业务表可以直接使用 Runtime 和 Storage，再按需加入 Content 和 Transports。受控的模型示例默认使用本地固定响应，适合在空环境运行；配置真实服务后可以发送相同请求。

## 安装与运行

在 Themelios 工作区执行 `bun run pack:packages`。在自己的 `package.json` 中声明用到的包，例如：

```json
{
  "type": "module",
  "dependencies": { "@themelios/models": "0.1.0" }
}
```

从工作区安装到自己的项目目录：

```sh
bun scripts/install-packages.ts ./artifacts/packages /path/to/my-app
```

复制[独立脚本示例](../../examples/embedded/README.md)可以运行内联和文件模板两种摘要。复制[库存示例](../../examples/inventory/README.md)可运行自己的 SQLite 业务、原子导入、历史和原件导出。下文其余 SDK 示例可直接在工作区运行，先执行一次 `bun run build:packages`。

## 带业务表的实例

用 `createApplicationModule({ id, formatId, settings, resourceRoot, tasks, schemaSql }, open)` 建立实例。将业务 DDL 传给 `schemaSql`。打开回调收到 `{ env, database, api, models }`，在其中建立应用公开的业务操作。省略回调时直接得到标准材料和任务 API。

`applicationSettings` 提供 Runtime、内容、存储和模型设置。用 `defineSettings` 定义应用字段，再以 `combineSettings(applicationSettings, businessSettings)` 组合。应用负责配置及启动自己使用的传输。库存示例通过这条路径将 CSV 原件与库存版本一起提交。

下面的应用把原件和模型成果分别与自己的业务行共同保存。按[模型配置示例](../examples/themelios.toml)设置 `./notes/config/installation.toml`，在同一文件中添加任务路由 `[models.tasks."note.label"]` 并设 `model = "summary"`。创建一份 UTF-8 的 `observation.txt`。

```ts
import { applicationSettings, createApplicationModule } from "@themelios/application";
import { defineTask, z } from "@themelios/models";
import { Installation } from "@themelios/runtime";

const label = z.strictObject({ title: z.string() });
const task = defineTask({
  id: "note.label",
  title: "观察记录标题",
  purpose: "为选定观察记录写一个简短标题",
  input: z.strictObject({}),
  output: label,
  requirements: { minMaterials: 1, inputs: [{ mediaType: "text/plain", accepts: [["text"]] }] },
  templates: { inline: true, user: "Give this observation a short title." },
});
const app = createApplicationModule({
  id: "example.notes", formatId: "example.notes",
  settings: applicationSettings, resourceRoot: ".", tasks: [task],
  schemaSql: `
    CREATE TABLE observations (
      id TEXT PRIMARY KEY, source_ref TEXT NOT NULL REFERENCES artifacts(ref), captured_text TEXT NOT NULL
    );
    CREATE TABLE labels (
      observation_id TEXT PRIMARY KEY REFERENCES observations(id),
      result_ref TEXT NOT NULL REFERENCES artifacts(ref)
    );
  `,
}, ({ api, database }) => ({
  async addObservation(id: string, file: string) {
    return api.materials.adoptAnalyzed({ file, mediaType: "text/plain" }, {
      async analyze(capture) {
        return new Response(await capture.read()).text();
      },
      attach(tx, selected, text) {
        tx.sql.run("INSERT INTO observations VALUES (?, ?, ?)", id, selected.ref, text);
        return selected;
      },
    });
  },
  async labelObservation(id: string) {
    const observation = database.read((tx) => tx.sql
      .query<{ source_ref: string }>("SELECT source_ref FROM observations WHERE id = ?").get(id));
    if (!observation) throw new Error("Observation not found");
    const source = { ref: observation.source_ref };
    const completed = await api.tasks.run({ task: task.id, variables: {}, materials: [{ source }] });
    await api.results.adopt(completed, (tx, saved) => {
      tx.sql.run("INSERT INTO labels VALUES (?, ?)", id, saved.ref);
    });
  },
  async readLabel(id: string) {
    const row = database.read((tx) => tx.sql
      .query<{ result_ref: string }>("SELECT result_ref FROM labels WHERE observation_id = ?").get(id));
    if (!row) throw new Error("Observation has no label");
    return (await api.results.read(row.result_ref, { schema: label })).value;
  },
}));

const instance = Installation.at("./notes", app).instance("default");
await instance.init();
const writer = await instance.open();
try {
  await writer.api.addObservation("today", "./observation.txt");
  await writer.api.labelObservation("today");
} finally {
  await writer.close();
}
const reader = await instance.open({ mode: "read-only" });
try {
  console.log(await reader.api.readLabel("today"));
} finally {
  await reader.close();
}
```

`materials.adoptAnalyzed` 让 `analyze` 异步读取本次捕获的原件。它和 `materials.adopt`、`results.adopt` 都在内容的提交事务中同步写入业务行，业务外键持有对应内容，写入回调返回业务值。`tasks.run` 返回完成值，应用可用 `results.adopt` 关联业务。需要直接保存到实例保留目录时用 `tasks.runAndSave`，流式操作使用 `tasks.stream` 或 `tasks.streamAndSave`。

## 模型、结构化任务和提示词

`bun examples/sdk/models.ts` 对同一份茶叶笔记演示四类模型接口。`bun examples/sdk/model-lifecycle.ts` 演示 503 重试、文本和 JSON 截断、结构校验失败、调用期限、显式取消与关闭。收到 `model.output_truncated` 时，可以缩短要求的输出或提高 `maxOutputTokens`。模型脚本结束时调用 `await models.close()`。

| 想得到什么 | 请求实例 | 示例结果 |
| --- | --- | --- |
| 文本生成 | 绑定兼容 OpenAI、OpenAI 或 Google 模型，调用 `models.generate({model:"tea",messages:[{role:"user",parts:[{kind:"text",text:"Name one tea"}]}],output:textOutput})` | `value: "Earl Grey"` |
| JSON 对象 | 将 `output` 设为 `{kind:"json",schema:z.strictObject({tea:z.string()})}` | `value: {tea:"Earl Grey"}` |
| 流式生成 | `for await (const event of models.stream(request))` | 处理 `text-delta` 渲染增量，`result` 取得最终值，`error` 展示失败 |
| Embedding | 配置 `embeddingSpace` 的 ID、维数和度量。`models.embed({model:"tea",inputs:[[{kind:"text",text:"tea"}]],purpose:"query"})`；改用 `purpose:"document"` 处理待索引文档。Google 路线可在同一项中附图片 | 设 `normalization:"l2"` 时向量 `[3,4]` 变成 `[0.6,0.8]` |
| 转写与时间戳 | 原生 OpenAI 转写绑定，`models.transcribe({model:"tea",audio:{mediaType:"audio/wav",bytes},language:"en",timestamps:"word"})`；可改成 `segment` 或省略。模型须声明所用时间戳粒度；示例启用 `providerOptions.openai.responseFormat="verbose_json"` | `text: "Tea"`，时间戳以毫秒表示 |
| 重排 | Cohere 绑定，`models.rank({model:"tea",query:"tea",documents:["Chair","Earl Grey"],topN:1})` | `ranking:[{index:1,score:0.95}]`，索引指向输入中的 Earl Grey |

`createModels(configuration, options?)` 接收实例 `models` 配置的同一结构，包含 `connections`、`bindings`、`tasks` 及默认期限、尝试次数和并发数。第二个参数可注入网络、凭据解析、诊断和模板等运行资源。连接定义协议、API 根地址和 `env:` 或 `file:` 凭据引用，绑定定义真实模型 ID、操作、支持的 MIME 类型、结构化和流式能力及模型参数。原生 OpenAI 默认走 `/responses`，在绑定或本次调用的 `parameters.providerOptions.openai.api` 设 `chat` 时走 `/chat/completions`。兼容 OpenAI 的连接支持生成和向量，原生 OpenAI 另有转写，Google 支持生成和向量，Cohere 用于重排。请求使用模型支持的参数，按需给绑定增加字节、图像和生成 token 限制。

要将例子接到本机或自选网关，在 Bash 执行下列命令并填入模型 ID；使用 PowerShell 时通过 `$env:` 设置同名变量。需要认证时额外设置 `DEMO_KEY`。向量模型提供 `DEMO_DIMENSIONS`，转写提供 `DEMO_AUDIO`。

```sh
DEMO_LIVE=1 DEMO_PROTOCOL=openai-compatible DEMO_URL=http://127.0.0.1:8080/v1 \
  DEMO_MODEL=MODEL_ID bun examples/sdk/models.ts generate
```

注册一个可重复使用的任务。已有配置的 `models` 会选择调用指定模型，变量经 Zod 校验，原文由准备流程附入模型请求。

```ts
import { defineTask, textOutput, z } from "@themelios/models";
import { inlineText } from "@themelios/core";

const teaName = defineTask({
  id: "tea.name",
  title: "Tea name",
  purpose: "Extract the tea name from a note",
  input: z.strictObject({ language: z.string().default("en") }),
  output: textOutput,
  requirements: { minMaterials: 1, inputs: [{ mediaType: "text/plain", accepts: [["text"]] }] },
  templates: { inline: true, user: "Name the tea using {{ language }}. Cite S1." },
});

const completed = await models.tasks.run(teaName, {
  variables: {},
  materials: [{ source: inlineText("Bring Earl Grey at 3.") }],
});
console.log(completed.value);
```

| 任务能力 | 怎样用 |
| --- | --- |
| 文件模板 | 将 `templates` 改为 `{system:"system.md.liquid",user:"user.md.liquid"}`，将这两个文件放入 `resourceRoot/tea.name/`，以 `createModels(configuration, {resourceRoot})` 或 `createPrompts({resourceRoot})` 设置资源目录。独立摘要脚本的 `--file-prompt` 演示完整用法。 |
| 语言、变量和真实来源 | 模板直接读 `{{ language }}` 和 `sources`。每项有 `key`，例如 `S1`，以及结构化的 `originalExtent`、`requestedRange` 和 `delivered`。用 `extent`、`range` 和 `delivery` 过滤器格式化这些数据。在 `validateOutput(value,sources)` 校验输出引用，`sources.has("S1")` 检查键，`sources.link("S1")` 构造展示链接。用 `presentTask(task, result, locale?)` 按任务定义呈现即时或已保存的成果。 |
| 发现与编辑 | `describeTask(task,prompts)` 取得变量、例子、输出、要求和模板位置。已打开应用的 `session.api.prompts` 支持 `read`、`describe`、`diff`、`setOverride`、`reset`；可从工作台逐条调用。 |
| 路由和预览 | 在 `createModels` 的配置中设 `tasks:{"tea.name":{model:"tea"}}`。`await models.tasks.preview(teaName,input)` 查看实际提示词和待执行配方，`models.tasks.run` 或 `models.tasks.stream` 执行。 |
| 批处理 | `models.tasks.runMany(teaName,[input,{...input,materials:[]}])` 返回 `[成功项, 失败项]`，保留输入顺序。 |
| 传递完成值或文件 | SDK 材料统一在 `source` 中传入选区、`inlineText(text)`、`{bytes,mediaType}`、`{file}` 或 `{result:completed,output:"notes.txt"}`。已保存成果在 `result` 传 `saved.ref`，省略 `output` 使用成果正文。经 JSON 协议传内联字节时，`bytes` 使用 Base64，例如 `{source:{bytes:"VGVh",mediaType:"text/plain"}}`。 |
| 交付已有表示 | 给某页论文使用已保存的摘录：`{source:{ref:paper.ref,range:{kind:"pages",start:2,end:3}},representation:{result:extraction.ref,output:"excerpt.txt"}}`。成果 `extraction` 的附件须关联到该页选区并记录实际覆盖范围。任务接受 `[["text"],["visual"]]` 时可将摘录交付给文本绑定。预览和新成果中的 `S1` 都指向论文第 2 页，并记录实际使用的文本。 |

## 媒体、材料、来源和成果

运行 `bun examples/sdk/media-content.ts`。该程序建立实例、导入笔记和原件、组合并保存成果，再用实际生成的图片和 PDF 演示选区。`createContent({database,cas})` 使用以 `contentSchemaSql` 初始化的数据库。应用结束时关闭 Database 和 CAS。

| 功能 | 示例 |
| --- | --- |
| 本地文件、字节与流 | `await materials.accept({file:"notes.md"})` 记录文件来源。也可用 `{bytes,mediaType:"text/plain"}`，或 `{body:new Blob([bytes]).stream(),mediaType:"text/plain",origin:{kind:"application",locator:"tea/18",capturedAt:iso}}`。 |
| 元数据、短引用和原件 | `materials.inspect(a.ref)` 查看尺寸、类型和创建切面。`materials.resolve(materials.agentRef(a.ref))` 得原引用。`materials.read(a.ref)` 给字节流；`materials.export(a.ref,"copy.md")` 写入新文件。 |
| 文本、结构、JSON | 对 `# Tea\n\n三点见。`，`materials.text({ref:a.ref,range:{kind:"text",start:7,end:10}})` 得 `三`。`materials.structure(a.ref)` 返回标题和段落坐标。对 `{"tea":{"price":20}}`，使用 `{kind:"json",pointer:"/tea/price"}` 得 `20`。 |
| 保留目录与来源 | `materials.listRetained({at:cut,limit:2})` 分页读取某次提交的显式保留目录。`materials.retain(ref)` 登记保留，`materials.release(ref)` 把材料从当前目录移除。当前业务拥有的材料在应用中查询。`materials.sources(ref,{depth:3})` 查成果的输入和文件。 |
| 与业务一并导入 | `await materials.adopt({bytes,mediaType:"text/plain"}, (tx,{ref}) => { tx.sql.run("INSERT INTO notes VALUES (?)", ref); return ref; })`。定义 `notes.ref REFERENCES artifacts(ref)` 持有材料。需要用同一份原件建立索引时，用 `materials.adoptAnalyzed(input, {analyze,attach})` 从 `capture.read()` 读取字节，把分析结果交给写入回调。 |
| 命名附件与成果图 | `await results.save({value:{title:"Tea"},producer:{kind:"application",name:"tea.report"},inputs,files:[{name:"notes.txt",material:{bytes,mediaType:"text/plain"},sourceIndices:[0]}]})` 保留几个输入及附件来源。`inputs` 中分别记录 `source`、`delivered` 和 `role`；上一步的完成值可作为材料，保存时随图一次采用。 |
| 读已保存的成果 | `await results.read(saved.ref,{schema:z.object({title:z.string()})})` 取得校验后的 `value`。成果的 `files` 是保留原顺序的命名附件列表。选择 `output:"notes.txt"` 将命名附件送到下一个任务，使用 `$value` 引用正文。 |
| 登记、命中、移除表示 | `await representations.set({source:selection,purpose:"model-input",recipe:"notes.text",result:saved.ref,outputs:["notes.txt"]})`。`notes.txt` 的 `sourceIndices` 须指向成果中对应的原件选区。`await representations.read(selection,"model-input","notes.text")` 一次取得成果与可复用的输出名，未登记时返回 `undefined`。用 `remove` 删除当前登记。检索表示使用 `purpose:"retrieval-text"`。 |
| 图像探测与处理 | 用 `probeMediaType(bytes,"image/png")` 检查实际类型。`createImageAdapter({maxPixels:1000,maxBytes:1048576})` 探测尺寸，输入 `range:{kind:"image",x:1,y:0,width:2,height:2}` 裁切朝正后的 3×3 图片。参数 `{format:"jpeg",quality:80,maxWidth:1,maxHeight:1,background:"#fff"}` 缩放并输出 JPEG；还可选 PNG、WebP 或源格式。 |
| PDF 读页、输出 PDF 或渲染 | 注册 `createPdfAdapters({maxBytes:4194304,maxPixels:1000000})`。`probe` 返回原件页数，`available` 检查处理资源。对 `range:{kind:"pages",start:2,end:3}`，`pdf.text` 得选页文字，`pdf.pages` 得只含第 2 页的 PDF，`pdf.render` 按参数 `maxWidth` 和 `maxHeight` 输出该页 PNG。 |
| 自定义适配器 | `media-content.ts` 注册 `counter.words`，以 `available`、`probe`、`prepare` 声明并处理 `application/x-counter`，通过命名附件输出 `text/plain`。把适配器交给 `createPreparation({adapters:[counter]})`，调用 `preview` 查看待执行配方，调用 `prepare` 得到实际交付。 |

运行 `bun examples/sdk/source-extents.ts`，对 12 字节文本选 `[3,5)` 得 `DE`，对四页 PDF 只选第 2 页。目录将原件规模、请求选区和实际交付分别呈现。`bun examples/sdk/preparation.ts` 让真实回环服务分别接收图像描述、音频转写请求和主模型调用，展示保存后复用同一选区，及 WAV 选段发往转写服务的实际字节。其他受支持的音视频格式需要与选区相符的适配器，完整原件可按真实模型能力发送。

`pdf.pages` 生成面向模型的选页文件，移除可引用范围外对象的注释，包括页面链接、附件注释和交互控件。要保留原始 PDF 的交互内容，用 `materials.export` 导出原件。

通过 `import {createMediaAdapters} from "@themelios/media"` 安装 FFmpeg 配方。直接装配准备流程时使用 `createPreparation({adapters: createMediaAdapters()})`。应用实例可用 `adapters: ({ media }) => createMediaAdapters(media)`，回调接收生效的材料准备设置。

| 配方 | 输入实例 | 交付 |
| --- | --- | --- |
| `media.audio` | 给 MP3 或视频素材选择 `[1050,1650)` 毫秒 | PCM WAV，可提供给转写绑定 |
| `video.clip` | 给 MP4 选择 `[1050,1650)` 毫秒 | 可单独播放的 MP4；来源仍按原件坐标，交付时长按编码结果记录 |
| `video.frame` | 对同一视频范围设置 `{maxWidth:640,maxHeight:480}` | 该范围内第一张解码帧的 PNG，并记录帧在原件中的实际时刻 |

例如需要用视觉绑定分析视频选区的单帧时，将以下内容合并到工作台任务配置：

```toml
[[models.tasks."document.summary".preparation.representations]]
mediaType = "video/*"
recipe = "video.frame"
parameters = { maxWidth = 640, maxHeight = 480 }
```

主模型需声明 `image/png` 和 `visual`，并支持任务的结构化输出。在视频源的 `source.range` 填入时间选区，再用 `task preview` 查看选择的配方。图片的实际交付范围随执行结果保存。

## SQLite、对象存储和时间

运行 `bun examples/sdk/storage.ts`。示例用自有业务表持有原始收据，备份恢复后从业务行读回原始字节。Runtime 的 `withOfflineInstance` 给维护操作取得实例锁。

运行 `bun examples/sdk/search.ts assam`，可用 SQLite FTS5 按词项查找笔记。示例在写入笔记、原件和索引后备份实例，并从恢复得到的 SQLite 直接查询 `assam`，读回 `Black tea` 及原文。领域词法、排序和向量索引由消费应用选择。

| 功能 | 实例 |
| --- | --- |
| 写对象、去重、读取 | `const blob = await cas.put(new Blob([bytes]).stream())`；重复写相同字节得相同 `ref`。`cas.stat(blob.ref)` 查看字节数，`cas.read(blob.ref,{start:0,end:5})` 只读前五个字节，`cas.export(blob.ref,dest)` 导出。 |
| 业务事务拥有原件 | 定义业务列 `blob_ref TEXT NOT NULL REFERENCES blobs(ref)`。`database.write(tx => { const ref = tx.registerBlob(blob); tx.sql.run("INSERT INTO receipts VALUES (?, ?)",id,ref); })`。业务行与字节登记同事务提交，删除拥有行后允许回收字节。 |
| 当前与历史 | 在版本表保存 `tx.seq`。`database.read(tx => tx.sql.query(sql).get(resolveCut(tx,at)))` 在同一读快照解析提交切面。库提供提交次序，应用决定实体版本何时生效。 |
| 备份和恢复 | `backupStorage` 用一致 SQLite 快照和正式引用复制对象，`restoreStorage` 恢复到未创建的目标。`verifyStorage` 检查对象和库；Content 实例可附加 `verifyContent` 检查来源和结果图。应用可以选择需要随备份保留的实例 `config/…` 文件。 |
| 回收和历史保留 | `collectStorage` 可推进历史下界并让业务在同一事务清理旧拥有行。`collectContent` 从现存业务外键 `REFERENCES artifacts(ref)` 和显式保留区间出发保留来源与表示，再交 Storage 回收对象。独立的 `materials.accept` 和 `results.save` 各自登记显式保留。 |
| 注册业务时域 | `database.defineTimeDomain({id:"market",kind:"linear",label:"市集轮次",tickSeconds:{numerator:"60",denominator:"1"}})`；`getTimeDomain("market")` 取回。可注册 `opaque` 域表示无顺序语义的标识。 |

运行 `bun examples/sdk/core.ts` 可在无实例情况下使用公共类型。它将 `A茶B` 的字节 `[1,4)` 读为 `茶` 并保存在完成值中，展示 JSON、内容引用和短码往返，以及页、时间、图像、JSON Pointer 选区。`utcPoint("2026-11-18T20:00:00+08:00")` 对应 `2026-11-18T12:00:00.000Z`，`comparePoints` 比较线性域的点，`matchRange` 对持续区间、不确定时点和未知时间返回 `matches`、`no_match` 或 `unknown`。`createFlow` 依次交付 progress、文本和结果，`openCall` 可与 `AbortController` 组合。`appError` 和 `toErrorInfo` 交付给客户端，`traceId` 可定位同一次操作。

## 安装、会话、配置、网络和诊断

运行 `bun examples/sdk/runtime.ts`。示例把默认货架从 `south` 改为 `east`，已经在执行的取货继续使用 `south`，新调用使用 `east`。实例也可以使用 SDK 指定不同的配置根、数据根或外置目录。

| 功能 | 实例 |
| --- | --- |
| 安装、定位、外置和只读 | `Installation.at(root,application,{configRoot:"config",dataRoot:"data"})`；`instance("main").init()`、`locate()`、`open({mode:"read-only"})`；`installation.external(otherPath)` 打开任意位置的实例。使用后 `await session.close()`。 |
| 自有配置和来源 | 用 `defineSettings({schema,fields,validateEffective})` 定义应用设置。模块的 `settings` 可以直接使用该定义，也可以用 `combineSettings` 组合不同所有者。`session.configuration.explain("/shelf")` 查看贡献层，`set("/shelf","east")` 固定实例值，`unset` 恢复继承，`reload` 重读手写 TOML。 |
| 资源捕获和释放 | 在 `application.open(env)` 中用 `env.bindResource(s=>s.shelf,prepare)` 关联变化的资源。工厂通过已注册的 `slot.get()` 获取依赖，依赖更换时 Runtime 一起更新使用方。用 `env.own({close})` 登记会话持有的普通资源。旧调用退出后释放上代资源。 |
| 执行、流与取消 | `env.execution.run("tea.ready",work)`，`env.execution.start("tea.wait",work)` 返回任务，可 `.cancel()` 后等待 `.result`；`env.execution.flow("tea.feed",makeFlow)` 由流的消费者驱动。 |
| 诊断与本地化 | `env.diagnostics.span("tea.print",work)` 和 `env.diagnostics.log("info","tea.shelf.ready",{shelf})` 写同一调用的 JSONL；`env.localize("tea.ready",{shelf})` 渲染应用字典。用 `mergeLocales` 组合平台与应用字典。 |
| 凭据和网络 | `createSecrets({baseDir:root})` 解析 `env:API_TOKEN` 或 `file:demo.key`。用 `createNetwork({timeoutMs:1000,secrets})` 创建网络客户端，再调用 `network.fetch(new Request(url))`。消费或取消响应体后调用 `network.close()`。安装级网络可选择代理、认证和额外 CA。 |
| 端点与离线独占 | `session.setEndpoints({status:"in-process"})` 替换实例端点。用 `session.publishEndpoints({http:url})` 为监听器公布端点，停止监听时关闭返回的登记。工作进程关闭后，可用 `withOfflineInstance(instance,work)` 或 `withInstanceLock(root,work)` 排他维护。 |

## 让业务操作同时从 SDK、CLI、HTTP/SSE 和 MCP 使用

`examples/sdk/media-content.ts` 注册的 `notes.echo` 把 `tea` 变成 `TEA`，通过 SDK 派发、HTTP 和 MCP 发现同一操作。`examples/inventory` 演示完整可运行 CLI、HTTP 上传、SSE 进度、二进制下载和 MCP 服务。

```ts
const echo = defineOperation<typeof session.api>()({
  id: "notes.echo",
  description: "Uppercase a note",
  permission: "read",
  input: z.strictObject({ text: z.string() }),
  output: z.string(),
  execute: (_app, { text }) => text.toUpperCase(),
});
const operations = [echo];
const directory = createOperationDirectory(operations);
const principal = { id: "reader", permissions: ["read" as const] };
const outcome = callOperation(session.api, directory, echo.id, { text: "tea" }, {
  principal, locale: "en", options: {},
});
if (outcome.kind === "unary") console.log(await outcome.result);
```

从 `@themelios/runtime/operations` 导入 `defineOperation`、`createOperationDirectory` 和 `callOperation`。应用可从 `@themelios/application` 加入 `standardOperations()`，或者只组合实例、配置、内容、任务中的某些操作包。注册目录检查 ID 唯一性，执行前检查实际权限。宿主可以设置展示函数供人类终端使用。

| 入口 | 运行实例 |
| --- | --- |
| CLI | `runApplicationCli(installation,Bun.argv.slice(2),{name:"myapp",operations,principal})` 根据点分 ID 生成命令。可声明 `cli:{command:"upper <text>",parseInput:([text])=>({text})}`，运行 `bun main.ts upper tea` 得 `TEA`。通过 `configure` 自定义命令时，用 `wiring.invoke(id, readInput, { output })` 调用操作并将最终 JSON 写入指定新文件，省略 `output` 时输出到终端。 |
| HTTP | `createHttpHandler(session.api,{operations,policy,secrets,authenticate})` 返回 `fetch` 和 `close`。缺省发送 `POST /operations/notes.echo`，正文 `{"text":"tea"}` 得 `"TEA"`。用 `http` 数组声明专用路径，空数组关闭该入口。 |
| SSE 与原件下载 | `kind:"stream"` 执行函数返回 `Flow`，最终值由输出 Schema 校验。`kind:"binary-read"` 返回 `{info:{mediaType,sizeBytes},body}`。库存的 `/inventory/import-stream` 和 `/inventory/source/REF` 分别演示二者。 |
| MCP | `createMcpEndpoint` 可单独挂载 HTTP MCP，`serveMcpStdio` 服务本地子进程，`createHttpHandler` 可启用 `enableMcp`。用 `tools/list` 取得可调用的子集，再调用 `notes_echo`。宿主声明 `resource` 让客户端使用 `resources/read`，提供 `agentRefs` 时为材料转换短引用。 |
| gRPC | `startGrpcServer(session.api,{address:{host:"127.0.0.1",port:0}},remoteOptions)` 提供独立监听。`remoteOptions` 使用相同的操作、认证和策略。调用 `Operations.Invoke` 读取 `notes.echo`，使用 `Stream` 或 `Upload` 传输流；关闭时调用 `await server.close()`。 |
| 整个监听与关闭 | `serveApplication(session,{http:{address:{host:"127.0.0.1",port:0},options},ready,signal})` 选择可用端口，`ready` 返回端点，取消信号关闭监听。请在 `finally` 中调用 `await session.close()`。宿主可用 `allowOperations` 对外只提供 `notes.echo`。 |

工作台可用命令和协议请求见[工作台命令与协议](operations.md)。设计职责见[平台架构](../ARCHITECTURE.md)。
