# Skill 接口契约（Skill Contract）

一个 Skill 是一个独立目录，必须包含 5 个文件：

```
skills/<skill_name>/
├── manifest.json          # 身份声明（必填）
├── input.schema.json      # 输入 JSON Schema（必填，draft 2020-12）
├── output.schema.json     # 输出 JSON Schema（必填）
├── index.js               # 执行入口（必填）
└── SKILL.md               # 人类可读说明（必填）
```

---

## manifest.json 契约

```json
{
  "name": "evidence_analyzer",
  "version": "1.1.0",
  "owner": "Detective",
  "risk_level": "L0",
  "input_schema": "input.schema.json",
  "output_schema": "output.schema.json",
  "entrypoint": "index.js",
  "failure_mode": "fallback_with_explicit_status",
  "changelog": [
    "1.1.0: 真实LLM调用与真实证据调用、UTF-8修复",
    "1.0.0: 初版"
  ]
}
```

字段约束：
- `owner`：只能是四个 Agent 之一（Commander / Detective / Ranger / Sage）
- `risk_level`：L0-L4，与执行权限绑定。L0 = 只读，无执行权限
- `failure_mode`：`fallback_with_explicit_status`（失败必须显式标记，不得伪装成功）或 `fail_hard`（失败即 SkillRun FAILED）
- `version`：SemVer；接口不兼容时必须升主版本

---

## input.schema.json 契约（真实示例节选）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["target_service", "metrics"],
  "additionalProperties": false,
  "properties": {
    "target_service": { "type": "string", "minLength": 1, "maxLength": 120 },
    "time_range": { "type": "object" },
    "metrics": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": { "enum": ["cpu_percent", "memory_percent", "disk_percent", ...] }
    }
  }
}
```

硬性规则：
- `additionalProperties: false` — 未知字段直接拒绝，不接受 prompt 注入
- 枚举白名单 — 不接受任意指标名
- 长度与范围约束 — 防超长输入

---

## 执行约定

1. 输入经 `lib/schema_validator.js` 严格校验，失败即 SkillRun 标记 FAILED，不进入执行。
2. 每次执行产生 SkillRun 记录：`skill_run_id / skill_name / skill_version / agent_run_id / input_hash / status / duration_ms / output`。
3. `input_hash` = SHA-256(canonical(input))，用于"输入未变化可复用结果"判断。
4. 输出必须符合 output.schema.json，校验失败同样标记 FAILED。
5. LLM 相关 Skill 输出必须带 `llm_status`：`llm_success` / `fallback_template` / `llm_failed`，三者不允许混淆。

---

## 当前注册的 14 个 Skill

| Skill | Owner | 风险 | 版本 |
|-------|-------|------|------|
| system_metrics_collector | Detective | L0 | 1.1.0 |
| evidence_analyzer | Detective | L0 | 1.1.0 |
| runbook_matcher | Ranger | L0 | 1.1.0 |
| alert-aggregator | Commander | L0 | 1.0.0 |
| log-hunter | Detective | L0 | 1.0.0 |
| metric-analyzer | Detective | L0 | 1.0.0 |
| change-scanner | Detective | L0 | 1.0.0 |
| runbook-matcher | Ranger | L0 | 1.0.0 |
| recovery-verifier | Ranger | L0 | 1.0.0 |
| rollback-executor | Ranger | L0 | 1.0.0 |
| monitor-evidence-collector | Detective | L0 | 1.0.0 |
| monitor-recovery-verifier | Ranger | L0 | 1.0.0 |
| twin-evidence-collector | Detective | L0 | 1.0.0 |
| twin-recovery-verifier | Ranger | L0 | 1.0.0 |

复用价值：Skill 的 manifest + Schema 是自描述的。任何实现同一契约的 Agent 平台都可以直接加载，不依赖 IntelliOps 的主程序。
