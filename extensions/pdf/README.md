# @themelios/pdf

为 Themelios 的材料准备注册 PDF 探测、选页、文字提取和渲染。页码从 1 开始，`{kind:"pages",start:2,end:3}` 选择第 2 页。

```ts
import { createPdfAdapters } from "@themelios/pdf";
import { createPreparation } from "@themelios/models";

const preparation = createPreparation({
  adapters: createPdfAdapters({maxBytes: 4194304, maxPixels: 1000000}),
});
```

三个配方分别为 `pdf.text`（选页文字）、`pdf.pages`（选页后的 PDF）和 `pdf.render`（选页 PNG）。给扫描页选择视觉路线。部署支持图片渲染时要带上包内 PDF 资源和依赖。
