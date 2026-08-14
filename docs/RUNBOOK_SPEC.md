# Runbook 规格（Runbook Spec）

Runbook 是沙箱恢复操作的**唯一执行依据**。系统不会执行任何 Runbook 白名单之外的操作。

---

## Schema（真实示例：sandbox/runbook-connection-pool.json）

```json
{
  "id": "RB-DB-POOL-002",
  "version": "2.0.0",
  "risk_level": "L3",
  "allowed_parameters": {
    "target_pool": { "type": "integer", "minimum": 8, "maximum": 128 }
  },
  "timeout_seconds": 30,
  "preconditions": [
    "execution_mode=sandbox",
    "target_service=payment-api",
    "approval_status=APPROVED"
  ],
  "execution_steps": [
    "set sandbox connection-pool capacity to approved target"
  ],
  "verification_steps": [
    "run 36 real in-process concurrent requests",
    "error_rate<=5",
    "p95_latency_ms<=100"
  ],
  "rollback_steps": [
    "restore pre-execution pool capacity",
    "repeat verification"
  ]
}
```

---

## 字段约束

| 字段 | 约束 |
|------|------|
| `id` | 全局唯一，`RB-` 前缀，含语义段 |
| `version` | SemVer；步骤变更必须升版本 |
| `risk_level` | L0-L4。L3/L4 强制走审批 |
| `allowed_parameters` | JSON Schema 风格。执行前逐项校验类型与范围，超范围拒绝 |
| `timeout_seconds` | 执行超时即中止并记录 |
| `preconditions` | 全部满足才执行。含 execution_mode（sandbox/simulation）、target_service、approval_status |
| `execution_steps` | 仅允许对沙箱组件的白名单操作，不接受任意命令文本 |
| `verification_steps` | 必须包含可量化的复验标准（如并发数、error_rate、p95 阈值） |
| `rollback_steps` | L2 及以上必须非空 |

---

## 执行边界（不可绕过）

1. **模式限制**：当前版本只允许 `simulation` 和 `sandbox`。`production` 模式在代码中关闭。
2. **白名单**：执行器只认 `allowed_parameters` 中声明的参数；LLM 生成的文本永远不会被当作命令执行。
3. **审批绑定**：L3 操作必须存在状态为 APPROVED 的审批，且审批的 content_hash 与当前参数一致。
4. **复验绑定**：验证未通过 → 状态进 FAILED；有回滚方案才允许进 ROLLED_BACK；绝对不标 RESOLVED。
5. **留痕**：每次执行产生 ToolCall 记录（stdout/stderr/exit_code/duration_ms）。

---

## 内置 Runbook 清单

| ID | 用途 | 风险 |
|----|------|------|
| RB-DB-POOL-002 | 沙箱连接池容量恢复 | L3 |
| built-in/windows-service-start/v1 | Windows 服务审批后启动（sc.exe 参数数组） | L3 |
| 数字孪生恢复配方（restore_config / restart_service / restart_managed_application） | 孪生组件恢复 | L1-L3 |

---

## 如何新增一个 Runbook

参见 `examples/定义一个Runbook.md`。提交前自检：
- 参数约束是否覆盖全部可执行参数？
- 验证步骤是否有可量化阈值？
- L2+ 是否有回滚步骤？
- preconditions 是否声明了 execution_mode 与 approval_status？
