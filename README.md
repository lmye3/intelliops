# 灵瞳智维 IntelliOps

Windows 独立运维 Agent 系统：4 个职责隔离的 Agent、14 个带 Schema 的 Skill、白名单 Runbook 沙箱、本地数字孪生实验室。

[Apache 2.0](LICENSE) · 零第三方 npm 依赖

---

## 是什么

一个免安装的 Windows 桌面应用（双击 EXE 即用）。它持续探测你本机和服务的真实状态，异常时走一条完整的处理链：

```
真实探测 → 事件生成 → Commander 分诊 → Detective 取证诊断
→ Ranger 风险决策 → (L3 人工审批) → 白名单沙箱恢复
→ 指标复验 → Sage 复盘沉淀
```

不是"给大模型一个 prompt"——每一步都有状态机约束、证据留痕、权限边界。

## 快速开始

1. 双击 `灵瞳智维IntelliOps.exe`
2. 数据保存在 `%LOCALAPPDATA%\IntelliOps\`
3. 后端只监听 `127.0.0.1:8766`

## 源码结构

```
_internal/backend/
├── main.js                    # 主程序（HTTP 服务、状态机、编排）
├── digital_twin.js            # 数字孪生（gateway/payment/inventory-app，端口 8871-8873）
├── twin_app.js                # 孪生应用入口
├── skills/                    # 14 个 Skill（每目录含 manifest + input/output Schema + index.js + SKILL.md）
├── sandbox/                   # 白名单 Runbook（JSON 定义）
├── evaluation/                # 评测集（intelliops-controlled-v2，50 场景）
├── integrations/
│   └── agentteams_adapter.js  # 官方 AgentTeams 连接适配器
└── lib/
    ├── evidence_ledger.js     # SHA-256 证据链
    ├── schema_validator.js    # JSON Schema 校验器
    └── secret_store.js        # 密钥管理（环境变量，不落明文）
```

## 可复用成果

| 成果 | 位置 | 复用方式 |
|------|------|---------|
| Skill 接口契约 | `docs/SKILL_CONTRACT.md` | 任何 Agent 平台可按契约加载 Skill |
| Runbook 规格 | `docs/RUNBOOK_SPEC.md` | 白名单恢复流程的通用定义格式 |
| API 契约 | `docs/API.md` | 全部 HTTP 接口（本机回环） |
| 数字孪生环境 | `digital_twin.js` | 3 组件 4 场景的本地故障演练环境 |
| 评测集 | `evaluation/scenarios.js` | 50 个受控场景，可重复运行 |
| AgentTeams 适配器 | `integrations/agentteams_adapter.js` | 与官方运行时的连接/派发/降级 |

## 文档

- `docs/API.md` — 接口契约
- `docs/SKILL_CONTRACT.md` — Skill 开发规范
- `docs/RUNBOOK_SPEC.md` — Runbook 定义规范
- `examples/添加一个Skill.md` — 逐步示例
- `examples/定义一个Runbook.md` — 逐步示例（含真实 RB-DB-POOL-002）
- `THIRD_PARTY_NOTICES.md` — 依赖声明（零第三方）
- `CONTRIBUTING.md` — 贡献指南

## 安全边界

- L0 只读自动 / L1 可逆自动留痕 / L2 高置信度+白名单 / L3 必须人批 / L4 只给建议
- 当前版本只启用 `simulation` 与 `sandbox`，`production` 模式关闭
- LLM 输出永远不会被当作命令执行；执行只认白名单 Runbook
- 密钥只走环境变量；数据全在本地

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
