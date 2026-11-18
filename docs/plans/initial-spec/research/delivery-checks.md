# 本执行包已完成合同、示例和文件一致性检查

检查日期：2026-11-18。这里记录 Spec 编写时实际执行的检查；Themelios 产品实现、真实模型、网络协议和目标平台发行的完成路径见 [verification.md](../plan/verification.md)，由实现阶段运行。

## 类型合同与示例使用真实依赖通过检查

- TypeScript 7.0.2，Zod 4.6.7，`@types/bun` 1.4.4；库存解析依赖 csv-parse 7.0.3。
- 选项：strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、skipLibCheck=false、noEmit；按本包公开入口映射对应合同。
- 覆盖 `contracts/` 的全部 10 份 TypeScript 声明与 `examples/` 的全部 4 份 TypeScript 示例。
- 最终 `tsc --pretty false` 退出码 0，无诊断。

检查曾发现 Zod 默认值的原始输入泛型约束，以及严格可选属性对象中显式 undefined 的问题；均已修正。原始 TaskDefinition 输入 RawI 允许省略有默认值的字段，解析后 I/O 仍使用 Json。

## Protobuf 与数据文件可以被真实工具读取

| 检查 | 已观察结果 |
| --- | --- |
| Protobuf 编译 | application.proto 成功生成 descriptor；82 个 message、29 个 RPC |
| SQLite 初始化 | 在 SQLite 3.53.1 中执行 storage.sql，成功建立 8 张表与相应索引/约束 |
| SQL 外键与回滚 | 真实外键失败回滚材料行、来源边和 commit_seq |
| 根历史与可达性 | 两个 cut 的根可见性正确；已释放原件被成果引用时保留；越过最后根区间后才不可达 |
| JSON 与 TOML | 全部文件解析成功；默认配置和启用可选图像路线的 TOML 均解析成功 |
| 摘要 Schema | 输入/输出 JSON Schema 有效；请求变量和输出示例通过其对应 Schema |
| 内联材料 | summary-request.json 的 base64 解码字节与 summary-material.txt 完全一致 |
| 资源一致性 | 库存中英词典键一致，设置/错误引用存在；任务示例与公开合同一致 |

SQL 检查验证这里交付的 DDL 和查询语义；借用事务句柄寿命、实际 CAS IO 与并发资源行为由实现代码承担。类型检查针对接口和示例的相互一致性，真实第三方适配器运行在相应实施单元接通。

## 文件交付经过完整性检查

打包前检查全部 Markdown 相对文件链接，所有目标存在。最终 ZIP 从完成的分文件目录生成，读取全部条目并执行 CRC 检查；FILE-MANIFEST.json 记录每份内容文件的字节数和 SHA-256，方便解压后检查完整性。临时编写状态、测试安装依赖与本地分析脚本不进入执行包。

Space 附件、聊天附件和独立 Goal 均采用本次最终文件。外部上传完成后再回读目标页面，确认文件引用已经保存。
