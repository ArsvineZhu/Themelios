# 在普通脚本中使用模型与模板

将此目录复制到工作区外，再从 `examples/inventory` 复制 `install-release.ts` 到同一目录。运行：

```sh
bun install-release.ts /ABS/RELEASE/packages
THEMELIOS_MODEL_URL=http://127.0.0.1:8080/v1 THEMELIOS_MODEL_ID=your-model bun embedded-summary.ts
```

将 URL 和 ID 换成实际支持结构化输出的模型。端点要求认证时，在进程环境中设置 `THEMELIOS_MODEL_KEY`。Windows PowerShell 可用 `$env:THEMELIOS_MODEL_URL = 'http://127.0.0.1:8080/v1'` 和 `$env:THEMELIOS_MODEL_ID = 'your-model'` 设置相同变量。

脚本编译模板、追加材料正文、校验结构和值中的来源键，输出模型结果和实际模型信息。脚本不需要实例、数据库或应用服务。`bun run test:distribution -- --live` 会在独立目录安装并运行这个示例。
