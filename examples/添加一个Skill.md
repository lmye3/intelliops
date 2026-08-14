# 示例：添加一个 Skill

目标：新增一个 `disk_usage_collector` Skill，用于采集磁盘使用率证据。

---

## 第 1 步：建目录

```
skills/disk_usage_collector/
├── manifest.json
├── input.schema.json
├── output.schema.json
├── index.js
└── SKILL.md
```

## 第 2 步：写 manifest.json

```json
{
  "name": "disk_usage_collector",
  "version": "1.0.0",
  "owner": "Detective",
  "risk_level": "L0",
  "input_schema": "input.schema.json",
  "output_schema": "output.schema.json",
  "entrypoint": "index.js",
  "failure_mode": "fallback_with_explicit_status",
  "changelog": ["1.0.0: 初版"]
}
```

要点：
- `owner` 只能是四个 Agent 之一
- `risk_level` 必须 L0（只读采集），写 L2 会被拒绝——采集类 Skill 没有执行权

## 第 3 步：写 input.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["target_drive"],
  "additionalProperties": false,
  "properties": {
    "target_drive": { "type": "string", "minLength": 1, "maxLength": 3 },
    "time_range": { "type": "object" }
  }
}
```

要点：
- `additionalProperties: false` — 多余字段直接拒绝
- `target_drive` 限制 1-3 字符（如 "C:"），防止路径注入

## 第 4 步：写 output.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["percent_used", "source", "collected_at"],
  "properties": {
    "percent_used": { "type": "number", "minimum": 0, "maximum": 100 },
    "source": { "type": "string", "enum": ["real_os_query", "sample"] },
    "collected_at": { "type": "string" }
  }
}
```

要点：
- `source` 用枚举强制区分真实采集与示例数据
- `percent_used` 范围 0-100，超出即校验失败

## 第 5 步：写 index.js

```js
'use strict';
module.exports = async function execute(input, ctx) {
  // 输入已由 schema_validator 校验通过
  // 只做只读采集，不执行任何命令
  const os = require('node:os');
  return {
    percent_used: 42.5,   // 示例：真实实现读系统 API
    source: 'real_os_query',
    collected_at: new Date().toISOString(),
  };
};
```

## 第 6 步：写 SKILL.md 并注册

SKILL.md 说明输入/输出/失败处理/安全边界（参考现有 skills/*/SKILL.md）。

注册：在 `skills/index.js` 的清单数组中加一行，或按你版本的注册方式（v16.x 会自动扫描目录）。

## 第 7 步：自检

- [ ] 输入带恶意字段（如 `"cmd":"rm -rf /"`）是否被 additionalProperties:false 拒绝？
- [ ] 输出不符合 Schema 时 SkillRun 是否标记 FAILED？
- [ ] 失败时是否返回 `fallback_with_explicit_status` 而不是假数据？

自检方式：`POST /api/mcp` 调用 `tools/call`，或直接触发一次事件让 Detective 调用它。
