# 示例：定义一个 Runbook

以项目内置的 `RB-DB-POOL-002`（v2.0.0）为真实范例，逐步说明每个字段的写法与原因。

完整文件见 `_internal/backend/sandbox/runbook-connection-pool.json`。

---

## 第 1 步：确定风险等级

这个操作要改沙箱支付服务的连接池容量，涉及服务行为变更 → **L3**。

判断参考：
- 只读 → L0
- 可逆且影响小 → L1
- 需要高置信度才能自动 → L2
- 必须人批 → L3
- 禁止自动 → L4

## 第 2 步：声明参数白名单

```json
"allowed_parameters": {
  "target_pool": { "type": "integer", "minimum": 8, "maximum": 128 }
}
```

为什么有范围：连接池太小没意义（<8），太大压垮沙箱（>128）。执行器逐项校验，超出直接拒绝——这一步挡住了 LLM 幻觉出来的离谱参数。

## 第 3 步：写前置条件

```json
"preconditions": [
  "execution_mode=sandbox",
  "target_service=payment-api",
  "approval_status=APPROVED"
]
```

三条缺一不可：
- 只能在沙箱跑，production 模式下此 Runbook 不可执行
- 只能作用于 payment-api，防止误伤其他服务
- L3 必须已批准

## 第 4 步：写验证标准（最重要）

```json
"verification_steps": [
  "run 36 real in-process concurrent requests",
  "error_rate<=5",
  "p95_latency_ms<=100"
]
```

验证必须可量化。写"确认恢复正常"是无效的——评委和系统都无法判断。"36 个真实并发请求、错误率≤5%、P95≤100ms"才可执行可复验。

## 第 5 步：写回滚

```json
"rollback_steps": [
  "restore pre-execution pool capacity",
  "repeat verification"
]
```

L2 及以上必须非空。回滚后同样要复验，不能"回滚了就完事"。

## 第 6 步：版本管理

- v1.0.0：初版
- v2.0.0：为什么升主版本？因为验证标准从"人工确认"改成了"36并发+阈值"，接口语义变了。

规则：任何步骤、参数、验证标准的变化都要升版本；执行记录里带 Runbook 版本，保证"当时按哪个版本执行的"可追溯。

---

## 自检清单

- [ ] L3 的 preconditions 里有 approval_status=APPROVED 吗？
- [ ] 每个参数都有类型+范围约束吗？
- [ ] 验证标准可量化吗？
- [ ] 有回滚步骤且回滚后复验吗？
- [ ] 版本号反映了本次变更的严重程度吗？
