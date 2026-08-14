# IntelliOps 接口契约（API Contract）

基础地址：`http://127.0.0.1:8766`（仅监听本机回环）
数据格式：JSON（UTF-8）
版本：v16.1（接口随版本演进，破坏性变更在 CHANGELOG 中声明）

---

## 一、健康与总览

### GET /api/health
返回：`{ app, version, status, total_incidents, resolved, open, runbooks, ai_configured, data_directory }`

### GET /api/overview
返回：`{ generated_at, app_version, runtime_mode, counts{incidents, active, resolved, alerts, agent_runs, skill_runs, tool_calls, pending_approvals, rollbacks, monitor_targets, monitor_enabled}, latest_incident, latest_metrics, sandbox, monitoring }`

### GET /api/runtime
返回：`{ runtime_mode, statement, official_target, official_runtime_connected, official_runtime_status, topology{manager, workers}, transport, shared_state }`

---

## 二、监控目标

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/monitor/targets` | 全部监控目标 |
| POST | `/api/monitor/targets` | 新建目标（字段校验，见监控契约） |
| POST | `/api/monitor/targets/{id}/toggle` | 启用/停用 |
| POST | `/api/monitor/targets/{id}/check` | 立即探测一次 |
| DELETE | `/api/monitor/targets/{id}` | 删除（历史探测保留） |
| GET | `/api/monitor/results` | 探测历史（limit 参数） |
| GET | `/api/monitor/snapshot` | 本机实时指标 |
| GET | `/api/monitor/history` | 指标历史 |
| GET | `/api/monitor/capabilities` | 执行能力边界声明 |
| POST | `/api/monitor/settings` | 全局开关 `{enabled}` |
| POST | `/api/monitor/inject` | 受控故障注入（仅沙箱场景） |

监控目标类型与字段契约：

| 类型 | config 必填 | thresholds 可选 |
|------|------------|----------------|
| system | — | cpu_percent / memory_percent / disk_percent（1-100） |
| http | url, expected_min(100-599), expected_max | latency_ms（1-30000） |
| tcp | host, port（1-65535） | — |
| process | process_name（1-120字符，白名单字符集） | — |
| application | process_name | mem_mb（1-65536）, min_uptime_min |
| windows_service | service_name（字母数字_.-） | recovery_action: none / start_with_approval |

---

## 三、事件与Agent运行

### GET /api/incidents
返回事件数组，每项：`{ id, title, severity, service, status, current_agent, created_at, timeline[], fingerprint, llm_status, source }`

status 取值（状态机）：`NEW → TRIAGED → DIAGNOSING → DIAGNOSED → AWAITING_APPROVAL → APPROVED → EXECUTING → VERIFYING → RESOLVED`，失败分支 `FAILED / ROLLED_BACK / REJECTED`。

### POST /api/incidents
请求：`{ title, severity, service, description }`

### GET /api/skill-runs · GET /api/tool-calls
SkillRun 与 ToolCall 留痕：含 agent_run_id、input_hash、duration_ms、status。

---

## 四、审批

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/approvals` | 待审批列表 |
| GET | `/api/approvals/history` | 全部审批历史 |
| POST | `/api/approvals/{id}/approve` | `{action: "approve"/"reject", approver, comment}` |

审批记录：`{ id, event_id, risk_level, operation, target, parameters, runbook_id, rollback_plan, content_hash, status, approver, decided_at, comment }`

规则：审批后操作参数变化（content_hash 不匹配）→ 原审批自动失效。

---

## 五、Skill 与 Runbook

### GET /api/skills
返回注册的 Skill 清单（manifest + input_schema）。

### GET /api/runbooks · POST /api/runbooks
白名单 Runbook 管理。匹配：`GET /api/runbooks/rag-match?q=`（TF-IDF 向量相似度）。

---

## 六、数字孪生与评测

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/twin/status` | 孪生组件状态（gateway/payment/inventory-app，端口 8871-8873） |
| POST | `/api/twin/demo/start` | 启动一次演示场景 |
| GET | `/api/twin/demo-runs` | 演示运行历史 |
| POST | `/api/twin/reset` | 重置孪生环境 |
| GET | `/api/evaluation/latest` | 最近一次评测结果 |
| POST | `/api/evaluation/run` | 运行评测集 |
| GET | `/api/evaluation/ai-impact` | AI 影响实测统计 |

---

## 七、AI 与知识

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/ai/config` | 配置与状态（Key 仅存环境变量，不落文件明文） |
| POST | `/api/ai/test` | 连接测试 |
| POST | `/api/ai/diagnose` | AI 诊断（失败回退 fallback，状态区分） |
| POST | `/api/ai/postmortem` | AI 复盘 |
| GET | `/api/knowledge` | 知识库（84 lessons / 4 runbook_updates 当前值） |
| GET | `/api/llm-calls` | LLM 调用留痕 |

---

## 八、MCP 与 AgentTeams

### POST /api/mcp
JSON-RPC 2.0：`tools/list` 与 `tools/call`。已暴露工具：`system_metrics_collector`、`evidence_analyzer`、`runbook_matcher`。

### GET /api/agentteams/config
从运行状态动态生成 AgentTeams 配置（非静态 YAML）：agents / skills / hitl_points / flow。

### GET /api/agentteams/status
`{ connected, mode, controller_url, ... }` — 断连时本地编排自动降级。

---

## 错误约定

| HTTP 状态 | 含义 |
|-----------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 状态机非法迁移 / 参数校验失败 |
| 404 | 资源不存在 |
| 422 | 字段校验失败（含具体字段错误） |

所有错误响应带 `detail` 字段，描述可操作的具体原因。
