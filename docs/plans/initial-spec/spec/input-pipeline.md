# 统一输入准备保留原件、实际表示与任务含义

`@themelios/application` 的 Preparation 把材料、任务要求与选定模型连接起来。Content 拥有不可变材料及精确读取，Models 接收已经准备好的文字和媒体 parts；Preparation 拥有表示选择、转换调用及本次输入事实。扩展通过这条路径服务全部任务和协议入口。

公共输入是 [Material](../contracts/core.ts)：已保存的 `Selection`、有界的内存 `InlineMaterial`，或某个完成成果的 `ResultOutput`。同次使用的角色通过 [TaskMaterial](../contracts/models.ts) 表示。普通任务得到 `PreparedInput.parts`、`sources` 和 `uses`，三者由同一准备过程产生。

## 实现按取得材料、确定性表示和模型任务分工

| 实施文件 | 责任 |
|---|---|
| `packages/application/src/inputs/sources.ts` | 从明确的 text、bytes、file、http(s) 来源取得原始字节及来源说明 |
| `packages/application/src/preparation.ts` | 固定材料顺序和任务语义，选择与执行当前表示配方 |
| `packages/application/src/inputs/resolve.ts` | 解析 Selection、InlineMaterial、ResultOutput，读取指定输出 |
| `packages/application/src/inputs/text.ts` | UTF-8 解码、文本选区和文本模型 part |
| `packages/application/src/inputs/image.ts` | sharp 探测、方向、裁切、尺寸/格式转换和图像来源 |
| `packages/application/src/inputs/directory.ts` | `S1...Sn`、可读范围、目录与 InputUse 同序绑定 |
| `extensions/pdf/src/{probe,text,native-pages}.ts` | PDF 页数与文字提取；配置原生 PDF 选页时生成选定页面文件 |
| `packages/application/src/textualize.ts` | 显式文字化：提取、转写、描述及可保存的完成结果 |

SourceAdapter 只取得外部内容。RepresentationAdapter 只做确定性探测和转换。转写、视觉描述与自由描述后结构化使用已经定义的模型任务；它们的完成值与普通模型任务相同。

## 同次准备固定原始材料和实际交付

准备依次执行以下操作：

1. 校验材料数量、原始 MIME 和任务 needs，保留调用方材料顺序及 `primary/context` 角色。
2. 解析每个 Material。Selection 指向已有不可变材料；InlineMaterial 在开始准备时捕获实际 bytes；ResultOutput 解析已有值或文件并保留其完成成果关联。
3. 用 MIME 探测和已安装解码器取得实际媒体类型与范围。文件扩展名和调用方提示只参与类型判断，解码结果冲突时给出 `content.media_mismatch`。
4. 结合原始选区、任务 needs 和模型能力，选择一个明确的本次表示配方。
5. 先检查所需解码器、外部工具、模型能力与预算，再执行本次转换。
6. 产生模型 parts、SourceDirectory 和 InputUse。对每个原始来源，`source` 是调用方传入材料，`delivered` 是实际提交的材料表示。
7. 固定完成的准备结果交给 Prompt 编译和 Models，随后清理本次工作文件和读取器。

实际交付与原始 Material 的选择完全一致且没有产生新表示时，`delivered=[source]`，例如精确文本选区或整件原生媒体。图像裁切、PDF 选页、音视频截取或文本提取产生新的 bytes 和实际覆盖；它们以转换成果的输出参与 `delivered`。媒体选区必须真正裁切后再发送，另一模型的新调用从原始 Material 重新执行准备。

## 配方按满足任务要求的表示排序

任务 needs 表示本次要理解的方面。`text` 指文字内容，`visual` 指图像、页面布局或可视信息，`speech` 指语音内容，`motion` 指连续时序变化。一个配方必须覆盖所有请求的方面；配置可明确指定某个已安装配方。

同一个原始媒体的默认选择顺序为：满足选区与 needs 的原生输入 → 已注册的确定性配方 → 调用方明确启用的模型准备。每条已注册配方声明输入 MIME、能够保留的 needs、输出 MIME、所需工具和参数 Schema。匹配时用固定的配方优先级，再按 id 升序消除同级歧义；一次准备记录最终选中的 id 和参数。

| 原件与本次需要 | 完整行为 |
|---|---|
| UTF-8 文字 | 使用原文或合法 UTF-8 字节选区，作为文字 part |
| 图片，模型支持其 MIME 与 visual | 方向处理后的整图或裁切图；必要时转成模型接受的 PNG/JPEG/WebP |
| PDF，模型原生接受 PDF 且满足 needs | 整件直接输入；选页由 PDF 扩展生成仅含这些页的新 PDF |
| PDF，任务仅需 text，模型接受文字 | PDF 扩展提取指定页文字，保留页到输出文本的覆盖信息 |
| PDF，任务需 visual，模型接受图像 | 使用安装的 PDF 渲染配方，按页生成图像；无该配方时报 `input.capability_missing` |
| 音频，模型原生接受所需 speech 信息 | 整件或扩展产生的实际片段作为媒体 part |
| 音频，目标模型仅接受文字 | 显式 `textualize` 调用已配置转写模型，完成后把转写成果作为材料传入目标任务 |
| 视频，模型原生接受 motion/speech 需求 | 使用整件或实际截取的媒体；带原始时间范围 |
| 视频，目标模型接受图片且任务只需 visual | 使用已安装抽帧配方，目录列出实际帧时刻 |
| 视频，任务需 motion 但只有静态抽帧能力 | 返回缺少 motion 能力，指出需要原生视频模型或满足该语义的已安装配方 |

联合任务的输入超出容量时返回 `model.input_too_large`，包含材料位置、已知大小和上限。分段、抽样、多个独立摘要改变任务语义，必须通过选区、配方参数或 `runMany` 明确表达。

## 文本选区保持原文坐标

`materials.text(selection)` 处理 `text/plain` 和 `text/markdown`。默认整件；文本范围是 UTF-8 字节半开区间，必须处于字节长度内并落在 UTF-8 字符边界。程序保存原件时保留原始换行和 Unicode 序列；按展示需要处理的文本是新表示。

ResultOutput 的 `$value` 若是字符串，直接作为文字；其他 JSON 值统一使用 `JSON.stringify(value, null, 2) + '\n'`，在模型侧作为文字 part。已保存的 `$value` 绑定到结果原件的 `{kind:'json',pointer:'/value'}` 逻辑选区；`materials.text()` 读取该值时采用同一格式。JSON Pointer 按 RFC 6901 解码，缺失字段报范围错误。指定文件输出时，Completed 按名称取得 `ProducedFile.material`，SavedResult 取得 `files[name].material`；两者的文件描述都保留 `sourceIndices`，其零基下标始终对应各自成果的 inputs。未知输出名称返回 `content.output_not_found`。直接结果传递不会重新调用先前模型。

Preparation 依来源顺序生成 `[S1]`、`[S2]` 等短标记和各自的文字/媒体 parts。模板目录只提供名称、角色、MIME 与范围；Tasks 在 user 模板文字后追加材料 parts，正式来源绑定来自同次准备。文字正文保持各自边界，并只发送一次。

## 图像转换固定坐标面和顺序

本期支持 JPEG、PNG 和 WebP；其他图像由 sharp 的实际解码能力和已声明配方扩展。InputUse 的图片选区坐标使用应用 EXIF 方向后的左上原点像素面。处理顺序固定为：

1. 探测尺寸、页/帧数量与方向，计算应用方向后的宽高；检查像素预算。
2. 应用方向并取得规范像素面，再执行 `{x,y,width,height}` 裁切；范围验证以该像素面为准。
3. 模型有尺寸或字节限制时按显式配方缩放和编码。缩放保持比例，默认保持原始尺寸，禁止默认放大。
4. 透明图保持 PNG/WebP 透明度；转 JPEG 时必须由配方指定背景颜色。动图多帧在默认静态任务中报告需选帧或明确的转换配方。
5. 输出实际 bytes、MIME 和尺寸，转换成果的 producer 保存 `sharp` 版本、配方 id 和实际参数。

采用 sharp 的 `autoOrient`、extract、resize 和编码操作。方向与裁切的实现必须保证上述语义；若链接调用的内部执行顺序不能直接保证，就先 materialize 方向后的图再裁切。只对已提出的范围或模型明确限制做转换，避免每次无必要的重编码。

缩放后的图像是新表示。`delivered` 引用该输出，`source` 保留原图选区。图片本身的像素坐标与程序从文本中逐字节复制的 CopyMap 分别处理。

## PDF 扩展给出可重复的页级文字表示

本期交付一个真实可安装的 PDF 扩展，使用 `pdfjs-dist`。扩展公开 `pdf.text` 配方和 PDF 探测，向既有准备注册接口接入。文本和图片任务执行器无需识别 PDF 内部对象。

提取算法固定：

1. 以 bytes 载入 PDF，取得页数；页面范围为一基半开 `[start,end)`，缺省为 `[1,pageCount+1)`。
2. 依页面升序取得 `getTextContent()`，仅消费包含 `str` 的文字 item，按 PDF.js 的 item 顺序构造行；`hasEOL` 后插入换行，相邻非空 item 间在原有边界无空白时插入一个空格。
3. 每页生成 UTF-8 文字块，页之间插入两个换行；同时记录每页在输出文本文字中的字节范围。页码标识作为元数据和目录说明，不伪装原文件正文。
4. 输出转换成果：`value={pages:[{page,start,end}]}`，`files` 包含 `text.txt`；producer 标记扩展及 pdfjs 版本。
5. 清理 PDF loading task 和页面资源。解密失败、损坏或读取失败返回具体 `content.decode_failed` 及原件引用。

PDF.js 提取会处理空白，文字的精确 byte range 归属于新文字表示，来源记录对应原 PDF 页。已选页中某页没有可提取文字时，将它加入 `value.emptyPages`；当任务要求涵盖全部选页时，`forModel` 返回这些页缺少文字表示的错误，提示可用的渲染/视觉路线。显式提取操作仍可返回已有文字和空页信息，调用方可以审阅。

原生 PDF 选页使用 `pdf-lib` 的页面复制能力创建新文件，记录新页顺序到原页号的映射；页面只含请求范围。渲染扩展可以采用 PDF.js 与适配的 canvas 实现，依赖与 Portable 资源单独打包。基础交付以文字扩展证明扩展接缝，页面渲染按应用安装选择启用。

内置确定性配方的参数有以下具体形状，供扩展注册和配置 Schema 直接采用：

| 配方 | 参数与默认 | 产出 |
|---|---|---|
| `image.normalize` | `format:'source'|'png'|'jpeg'|'webp'` 默认 source；可选正整数 maxWidth/maxHeight；quality 为 1..100、默认 90，仅用于有损编码；转 JPEG 且原件有 alpha 时需明确 background 色值 | 一个名为 `image` 的图片输出；value 保存实际宽高和格式 |
| `pdf.text` | 空对象；页范围来自 Material.Range | `text.txt` 及页到文本范围、emptyPages |
| `pdf.pages` | 空对象；页范围来自 Material.Range | `pages.pdf` 及新页序号对应原页号的数组 |

`format:source` 且模型不接受原始格式时，按 PNG、JPEG、WebP 顺序选择双方共同支持的格式；透明原件优先 PNG。已明确指定的格式不可被另一种格式静默替换。无方向变化、裁切或大小/格式要求时可以直接交付原图。用户已指定选区优先于任何缩放，参数省略时保持该选区原始尺寸。

## 扩展接口提供足够的输入与明确的输出

[contracts/input.ts](../contracts/input.ts) 定义 `SourceAdapter`、`RepresentationAdapter`、`Preparation` 与显式 `Textualize`。新增扩展只实现其实际需要的接缝。

`SourceAdapter.open({uri, mediaType?, name?})` 返回 Content 的 `AcceptInput`。来源 scheme 在应用装配时映射到唯一适配器。file 取得本机文件，http(s) 通过 Network 取得响应流，外部服务采用自己的明确 scheme。HTTP 来源保存最终 URL、获取时刻与可用的 ETag/Last-Modified；重定向和凭据遵循 Network 的规则。接纳结束后材料读取使用已捕获的 bytes。

`MediaInput` 包含原 Material、媒体事实、可选 Range，以及可重开同一不可变原件的 `open()`。Selection 通过 `materials.read(ref)` 读取；流必须消费完或主动 cancel。适配器只拿本次材料和 CallOptions，原件数据库身份由 `source` 携带。

`RepresentationAdapter` 的 description 提供固定 id/version、支持的 MIME、保留的 needs、输出 MIME、参数 Zod 和优先级；`probe()` 取得实际 Extent，`available()` 列出缺少的工具或资源，`prepare()` 返回 `PreparedRepresentation`。

每个转换结果是普通 `Completed<Json>`：`producer.kind='transform'`，`producer.name=recipe.id`，`producer.version=recipe.version`；inputs 的 source 是本次原始 Material，files 是真实生成的 bytes 或已保存 Selection。`PreparedRepresentation.outputs` 选择需要提交的 file 名称。Preparation 把这些输出转换成 `ResultOutput` 放进当前 InputUse.delivered，直接读取它们形成 ModelPart。后续保存递归采用已经完成的结果树。

`probe()` 返回 unknown 时，由需要该范围的具体转换处理并报告结果。全件未知媒体仅在模型和接入器明确接受其 MIME 且任务不要求无法取得的范围时原生传递。用户请求页号、时间或像素选区时，需要对应真实 Extent 校验。

## 任务配置明确启用模型准备

`models.tasks.<task-id>.preparation` 的合同为：

```ts
type PreparationPolicy = {
  representations?: readonly {
    mediaType: string;
    recipe: string;
    parameters?: Json;
  }[];
  models?: readonly {
    mediaType: string;
    recipe: 'media.describe' | 'speech.transcribe';
    model: string;
  }[];
};
```

规则先匹配精确 MIME，再匹配 `type/*`；同一列表中的重复 pattern 在配置加载时报错。显式 representation 规则优先选择指定配方，参数按该配方 Schema 解析。没有规则时采用本章默认顺序；没有 models 规则时仅运行原生和确定性路径。

`speech.transcribe` 将实际音频片段交给所选转写绑定，生成 UTF-8 `text.txt` 和转写完成值。`media.describe` 用所选描述模型理解原件，输入先经过原生或确定性准备，再使用内置描述 Prompt 产生文字。描述模型必须覆盖该原件的 task needs；模型准备内部只执行这一层辅助请求，它的输入准备限定为原生/确定性路径。

生成的文字随后输入最终目标模型。辅助结果作为 ResultOutput 保留在当前 inputs.delivered 中，其 producer 保存实际辅助模型；最终任务的 producer 只描述自己的生成。辅助准备和最终生成共享外层总期限与取消信号，各次请求使用剩余期限。辅助请求成功、最终请求失败时，显式 `textualize` 路径能让调用者事先保留辅助成果；普通自动准备只交付当前任务的成功完成值。

needs 检查覆盖整条选中路线：原件的 visual/speech/motion 要求由辅助模型满足，生成的文字再按 text 能力送入最终模型。不能把原件的 visual 要求继续施加给只接收已完成描述文字的最终模型，也不能仅因最终模型接受文字就声称原件已经得到理解。该路线及两个模型的实际输入分别保留在完成结果树中。

`preview` 列出将发生的确定性转换与每项 `requiresModel:true` 的辅助请求，并呈现选中的模型绑定。它不执行这些请求。

## 文字化是可以独立调用和保存的实际能力

`textualize.run({material, mode, model?, instructions?})` 返回 `Completed<Textualized>`，files 中固定包含名为 `text.txt` 的输出。mode 为：

- `extract`：文本原件直接读取；PDF 使用 `pdf.text`。结果含文字、页范围和空页信息，纯文本的页列表为空。
- `describe`：用已配置且满足原件模态的模型生成自然语言描述；结果含 `mode` 与 `text`。
- `transcribe`：用指定转写绑定生成文字；结果含语言、时长与实际时间粒度，缺少的语言/时长为 null，缺少的时间段为 []。

`model` 在 describe/transcribe 中明确选择绑定；缺省时使用 `models.tasks['media.describe']` 或 `models.tasks['speech.transcribe']` 的模型配置。`instructions` 进入本次 user 消息；它不能改变程序决定的来源和坐标。

独立构造 `createTextualize` 时通过 `routes` 提供同一任务路由，或在请求中显式给 model。内置描述定义与模板见 [media-description.ts](../examples/tasks/media-description.ts)；其图像需求为 visual，PDF 需求为 text+visual，音频为 speech，视频为 visual+speech+motion。任务只需某一部分时，由应用定义对应较窄的描述任务和明确表示，不把一组帧误记为完整视听描述。

文字化完成后可直接作为下一任务的 context，也可由应用显式保存。要登记检索表示，应用执行 `results.save(completed)`，随后 `representations.set({source, purpose:'retrieval-text', recipe, result:saved.ref, output:'text.txt'})`。登记来源必须是正式 Selection。普通材料读取及主模型调用不因存在文字化可能而自动创建检索表示。

需要视觉 Embedding 的应用可把图像原生提交到相应空间；文字空间使用已完成文字表示。Preparation 和 Models 统一记录实际使用的表示，索引组织及向量算法由消费应用负责。

## 音视频扩展有具体配方接入位置

本期完成原生音频/视频 ModelPart 的传递、转写操作和能力检查。安装 FFmpeg 扩展后可提供以下确定性配方：

| 配方 | 必需参数与产出 |
|---|---|
| `audio.clip` | 原始时间范围 `[startMs,endMs)`；用解码后的时间裁切输出音频，记录输出零点到原件 startMs 的映射 |
| `video.clip` | 同一时间范围，保留所选的音轨和画面；使用明确的编码格式并记录实际输出时长 |
| `video.frames` | `timesMs:number[]`、输出格式和最大边长；每个请求时刻解码取得实际帧，输出按时刻排序的图片及真实帧时间 |
| `video.audio` | 选择音轨和时间范围，输出可被转写服务接受的音频及原件时间关系 |

FFmpeg 通过参数数组启动进程，源文件与输出文件使用独立参数。时间裁切采用 `trim/atrim`，重新设置输出时间原点采用 `setpts/asetpts`；每个输出同时记录到原时间的关系。抽帧返回实际帧的呈现时间，多个请求落到同一帧时按实际帧去重并保留请求映射。取消终止子进程并清理工作文件。

这些配方与 PDF 渲染是已定义的扩展落点。基础交付完整实现文本、图片与 PDF 文字扩展；已有应用选用音视频扩展时实现对应配方、依赖和操作验收。缺少工具通过 `available()` 在模型请求前呈现，基础安装仍可执行自己的已安装能力。

## 容量和资源直接限制本次工作

内存材料超过 `content.maxInlineBytes` 时先通过 `materials.accept` 接纳为 Selection。准备阶段从原件流读入、转码输出和最后媒体 parts 均受本次材料字节预算控制；计算采用实际 bytes，结合模型更小的输入上限取有效值。图像像素数另按 `preparation.image.maxPixels` 检查，防止很小压缩文件扩张到不可用的内存规模。

较大原件读取用流与受管理工作文件；只将当前模型请求所需部分放入有界内存。临时目录归本次调用，成功/失败/取消都清理。返回的 Completed 只包含调用方仍可读取的内存 bytes、正式 Selection 或已完成的 ResultOutput；清理临时目录不会使成功结果失效。

SDK 导入文件的路径在接纳时捕获内容。远程入口接收上传或正式引用，进入这条管线后行为相同。范围不匹配、解码失败、缺少配方及超过预算都在对应材料位置报告，错误含 source key、原件引用或名称及失败动作。

## 扩展完成条件使用同一条真实任务路径

| 操作 | 应观察到的结果 |
|---|---|
| 中英混合文字的字节选区，包括 emoji | 原文边界正确；半个 UTF-8 字符报范围错误 |
| 带 EXIF 方向图片的裁切和模型输入 | 裁切区域符合朝正后的图像坐标，实际模型获得该区域 |
| 文字 PDF 只选择第二至第三页 | 提取文字仅覆盖该页范围，来源仍能定位原页 |
| 扫描 PDF 无文字页 | 在需要完整文字的任务中指出缺少表示；显式提取保留空页列表 |
| 载入 PDF 扩展并运行既有摘要任务 | 使用相同 Task/Preparation/Models 路径，只增加扩展注册 |
| 一次返回的转换成果继续传入任务并随后保存 | 模型使用实际 bytes，保存后原件、转换产物和最终成果关系可读取 |
| 取消正在进行的转换或辅助转写 | 进程/网络请求停止，临时资源释放，已正式保存的结果仍可读 |
| 文本化成功后切换模型做结构化 | 使用已完成文字和原件的明确角色，无重复转写 |
