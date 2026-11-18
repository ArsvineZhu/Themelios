# 在普通脚本中使用模型与模板

将此目录复制到工作区外，再从 `examples/inventory` 复制 `install-release.ts` 到同一目录。运行：

```sh
bun install-release.ts /ABS/RELEASE/packages
THEMELIOS_MODEL_URL=http://127.0.0.1:8080/v1 THEMELIOS_MODEL_ID=your-model bun embedded-summary.ts
```

将 URL 和 ID 换成实际支持结构化输出的模型。端点要求认证时，在进程环境中设置 `THEMELIOS_MODEL_KEY`。Windows PowerShell 可用 `$env:THEMELIOS_MODEL_URL = 'http://127.0.0.1:8080/v1'` 和 `$env:THEMELIOS_MODEL_ID = 'your-model'` 设置相同变量。

示例只声明 `@themelios/models`。默认使用脚本内联的 Prompt。运行 `bun embedded-summary.ts --file-prompt` 可以从 `resources/sample.summary/` 加载模板。两种方式都校验结构化结果中的来源键。
