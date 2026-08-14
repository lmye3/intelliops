# 贡献指南（CONTRIBUTING）

感谢你考虑为 IntelliOps 做贡献。项目遵循 Apache 2.0 协议。

---

## 可以贡献什么

按贡献门槛从低到高：

1. **文档修正**：README、API 文档、Skill 说明中的错误或不清晰之处
2. **新 Skill**：实现新证据采集或分析能力（见 `examples/添加一个Skill.md`）
3. **新 Runbook**：为沙箱环境定义新的恢复流程（见 `examples/定义一个Runbook.md`）
4. **评测场景**：向 `evaluation/scenarios.js` 添加新的受控场景
5. **监控连接器**：新的监控目标类型
6. **AgentTeams 适配**：改进 `integrations/agentteams_adapter.js`

## 硬性规则（违反即拒绝）

1. **不加第三方依赖**：本项目零 npm 依赖是刻意设计。新代码必须只使用 Node.js 内置模块。确需外部能力时，先开 Issue 讨论。
2. **不碰执行边界**：任何 Skill 的 `risk_level` 不得虚假声明为 L0；不得绕过白名单 Runbook。
3. **不加假证据**：fallback 输出必须显式标记 `llm_status: fallback_template`；示例数据必须标 `source: sample`。
4. **Schema 先行**：Skill 的 input/output Schema 必须先于实现提交；`additionalProperties: false` 是默认。
5. **测试必须可复现**：评测场景必须自带预期断言，任何人跑 `evaluation/run` 都应得到一致结论。

## 提交流程

1. 开 Issue 描述动机（不要直接提交大 PR）
2. 在分支上实现，提交信息描述"为什么"而非"改了什么"
3. 自测：触发一次真实事件验证新能力，附上 SkillRun / AgentRun 留痕
4. PR 描述里写明：新增了什么、改动了什么接口、如何验证

## 安全相关贡献

涉及以下范围的改动，必须先经安全评审：
- `lib/schema_validator.js`、`lib/evidence_ledger.js`、`lib/secret_store.js`
- 审批逻辑（approvals 相关）
- 执行器与沙箱边界
- AgentTeams 适配器的网络行为

## 代码风格

- 与现有文件保持一致（2 空格缩进、单引号、分号）
- 中文注释与文档使用 UTF-8
- 所有对外字段名使用 snake_case（与现有 API 一致）
