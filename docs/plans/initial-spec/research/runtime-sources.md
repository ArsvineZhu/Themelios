# 运行基础采用成熟机制并保留清楚的资源所有权

本次资料读取时间为2026-11-18。项目版本基线采用用户提供的Bun 1.4.4与Rust 1.100.0；其余依赖采用实施工作区锁文件中的实际版本，并依据对应文档接入。下列判断已落实到安装、配置和诊断规范。

| 具体决定 | 直接依据与链接 | 影响实现的事实 |
|---|---|---|
| 实例锁采用Rust标准库，经napi薄接缝持有 | [File::try_lock](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock)、[Rust 1.89稳定项](https://blog.rust-lang.org/2025/08/07/Rust-1.89.0/) | 标准库已提供跨平台文件锁；Session持有句柄，进程退出由OS释放 |
| 停止采用定时心跳抢占实例锁 | [proper-lockfile说明](https://github.com/moxystudio/node-proper-lockfile)、[维护者仓库issue #121](https://github.com/moxystudio/node-proper-lockfile/issues/121)、[暂停调试issue #71](https://github.com/moxystudio/node-proper-lockfile/issues/71) | mtime/stale机制会受到进程暂停和抢占时序影响；本项目本地单主场景已有更直接的OS机制 |
| Network拥有Bun.FetchSession | [Bun Fetch](https://bun.sh/docs/runtime/networking/fetch) | session持有自己的连接设置和池；explicit proxy=false可以固定直连行为 |
| TOML读写使用Bun内置API | [Bun TOML](https://bun.sh/docs/runtime/toml) | parse/stringify满足人工配置读取与程序owned覆盖文件写入；保注释由文件所有权解决 |
| managed.toml用同目录原子替换 | [write-file-atomic](https://github.com/npm/write-file-atomic) | 临时写入、fsync、rename以及同文件写入串行化已有成熟实现 |
| 日志用Pino与rotating-file-stream | [Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)、[rotating-file-stream](https://github.com/iccicci/rotating-file-stream) | 日志结构化和轮换各由已有依赖承担；Session仍要显式关闭自己拥有的stream |
| 操作上下文使用实例内ALS | [Node AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage) | 异步调用继承上下文，用户接口无需反复传实例和关联信息 |
| OTel实例内provider与手动业务span | [OTel JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)、[OTel context](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/context.md) | span/metrics/exporter采用标准实现；显式父context避免多个嵌入实例共享全局注册状态 |
| 每实例词典、每调用固定翻译函数 | [i18next API](https://www.i18next.com/overview/api) | createInstance与getFixedT可分别管理资源和调用语言 |

## 资源切换在提交前完成全部可失败准备

配置更新采用“完整候选校验→准备真实资源→保存文件→同步交换内存指针”。最后的内存段只采用已经构造的对象，原资源继续供在途调用使用。把资源析构放到旧调用结束后，可以同时保持新设置生效与旧请求一致性。

对已有实例和已配置连接，实施验证聚焦四项真实组合：Windows上的文件原子替换与持锁冲突、慢响应体取消、旧请求跨资源更新继续完成、两个Session的日志/语言隔离。验证结果反馈到对应适配实现；其余通用依赖的内部行为由上游维护。

## 用户范围决定当前配置只需要三种生效方式

首发字段采用next-call、reload、restart。保存结果、备份、GC和离线迁移由各自明确操作承担，完成点位于其实际数据owner。配置本身持有desired和effective快照，不承担这些操作的执行历史。
