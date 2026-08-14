# 第三方依赖声明（Third-Party Notices）

## 运行时依赖

**IntelliOps 核心运行时零第三方 npm 依赖。**

主程序与后端仅使用 Node.js 内置模块（通过 `node:` 前缀显式引用）：

| 模块 | 用途 |
|------|------|
| `node:http` | 内置 HTTP 服务与真实探测客户端 |
| `node:https` | 对外部 LLM API 的加密请求 |
| `node:fs` | 数据文件读写、日志追加、Runbook 加载 |
| `node:path` | 数据目录与资源路径解析 |
| `node:os` | 平台判断与用户目录定位 |
| `node:crypto` | SHA-256 证据哈希、随机 ID |
| `node:child_process` | Windows 服务状态查询（sc.exe，白名单参数数组调用） |
| `node:worker_threads` | 数字孪生压测并发执行 |
| `node:net` | TCP 端口探测 |
| `node:perf_hooks` | 耗时测量 |
| `node:sea` | 单文件可执行应用资源加载 |

依赖来源：Node.js 官方运行时（MIT 许可，见 https://nodejs.org/ 随附 LICENSE）。

## 可选外部服务（非依赖，运行时按需连接）

| 服务 | 用途 | 数据流向 | 许可 |
|------|------|---------|------|
| 任意 OpenAI 兼容 LLM API（如 DeepSeek） | 诊断与复盘（可选，未配置时走 fallback 模板） | 仅发送脱敏后的故障文本 | 服务方条款 |
| AgentTeams 官方控制器（本地 127.0.0.1:8090） | 跨 Agent 协作通道（可选，断连自动降级） | 仅本地回环 | 服务方条款 |
| Windows `sc.exe` | Windows 服务状态查询与审批后启动（仅白名单参数数组） | 仅本机 | 微软 EULA |

## 前端

`app.html` 为自研单文件前端，无 CDN 引用、无第三方 JS 库、无外部字体（使用系统字体微软雅黑）。

## 供应链安全说明

- 无 npm registry 依赖 ⇒ 无依赖投毒风险面
- 全部依赖可在单次 `node --version` 检查后审计
- 构建产物（EXE）内的 Node.js 运行时版本见 `构建与验证报告.txt`
