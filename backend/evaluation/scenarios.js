'use strict';

const crypto = require('node:crypto');

const families = [
  {
    category: 'connection_pool_exhaustion', expected_runbook: 'rb_database_restart',
    titles: ['支付请求排队', '数据库连接获取超时', '订单接口间歇失败', '连接资源不足'],
    logs: ['POOL_TIMEOUT waiting for connection', 'connection pool queue exceeded', '连接池等待超时'], metrics: []
  },
  {
    category: 'cpu_pressure', expected_runbook: 'rb_cpu_pressure',
    titles: ['订单计算变慢', '工作线程吞吐下降', '主机计算资源紧张', '请求队列持续增长'],
    logs: ['request queue growing', 'worker throughput degraded', 'scheduler contention observed'], metrics: [{ metric: 'cpu_percent', value: 94 }]
  },
  {
    category: 'memory_pressure', expected_runbook: 'rb_memory_pressure',
    titles: ['检索服务资源紧张', '缓存节点出现抖动', '分配延迟增加', '工作集持续扩张'],
    logs: ['allocation pressure', 'working set growth', 'garbage collection frequency increased'], metrics: [{ metric: 'memory_percent', value: 93 }]
  },
  {
    category: 'service_latency', expected_runbook: 'rb_latency_simulation',
    titles: ['API响应变慢', '上游请求超过SLO', '接口出现长尾', '服务响应超时'],
    logs: ['upstream latency timeout', 'p95 latency above baseline', 'request deadline exceeded'], metrics: []
  },
  {
    category: 'process_not_running', expected_runbook: null,
    titles: ['桌面程序状态异常', '目标应用离线', '客户端进程消失', '应用探测失败'],
    logs: ['process not running', 'target process not found', '进程未运行'], metrics: []
  }
];

function scenario(family, index, split) {
  const valueOffset = (index % 4) - 1;
  const metrics = family.metrics.map(item => ({ ...item, value: item.value + valueOffset }));
  const title = family.titles[index % family.titles.length];
  const log = family.logs[(index * 2 + 1) % family.logs.length];
  return {
    id: `${split}-${family.category}-${String(index + 1).padStart(2, '0')}`, split,
    alert: { title, description: `${title}，由探测器批次 ${index + 1} 发现`, code: index % 2 ? 'OBSERVATION' : family.category.toUpperCase() },
    logs: [log, `correlation_id=case-${family.category}-${index + 1}`], metrics,
    expected_category: family.category, expected_runbook: family.expected_runbook, safe_to_repair: false
  };
}

function createScenarios() {
  const scenarios = [];
  for (const family of families) {
    for (let index = 0; index < 8; index += 1) scenarios.push(scenario(family, index, index < 3 ? 'reference' : 'holdout'));
  }
  const adversarial = [
    { id: 'holdout-unknown-generic', title: '服务行为发生变化', logs: ['signal requires investigation'], metrics: [], expected: 'unknown' },
    { id: 'holdout-borderline-cpu', title: '资源接近阈值', logs: ['no saturation'], metrics: [{ metric: 'cpu_percent', value: 89 }], expected: 'unknown' },
    { id: 'holdout-borderline-memory', title: '容量需要观察', logs: ['allocation stable'], metrics: [{ metric: 'memory_percent', value: 88 }], expected: 'unknown' },
    { id: 'holdout-counter-signal', title: '接口出现延迟', logs: ['latency warning'], metrics: [{ metric: 'cpu_percent', value: 96 }], expected: 'cpu_pressure', runbook: 'rb_cpu_pressure' },
    { id: 'holdout-no-match-disk', title: '磁盘空间不足', logs: ['disk usage warning'], metrics: [{ metric: 'disk_percent', value: 96 }], expected: 'unknown' },
    { id: 'holdout-noise-only', title: '例行状态消息', logs: ['heartbeat ok'], metrics: [{ metric: 'cpu_percent', value: 24 }], expected: 'unknown' },
    { id: 'blind-disk-capacity', title: '存储卷接近容量上限', logs: ['filesystem remaining space low'], metrics: [{ metric: 'disk_percent', value: 97 }], expected: 'disk_pressure' },
    { id: 'blind-dns-resolution', title: '服务发现间歇失败', logs: ['name resolution returned temporary failure'], metrics: [], expected: 'network_dns_failure' },
    { id: 'blind-process-crash', title: '桌面客户端异常退出', logs: ['exit code 1 without shutdown marker'], metrics: [], expected: 'process_not_running' },
    { id: 'blind-pool-contention', title: '存储访问排队', logs: ['resource acquire deadline exceeded under concurrency'], metrics: [], expected: 'connection_pool_exhaustion', runbook: 'rb_database_restart' }
  ];
  for (const item of adversarial) scenarios.push({
    id: item.id, split: 'holdout', alert: { title: item.title, description: item.title, code: 'GENERIC' },
    logs: item.logs, metrics: item.metrics, expected_category: item.expected,
    expected_runbook: item.runbook || null, safe_to_repair: false
  });
  return scenarios;
}

function datasetAudit(scenarios) {
  const fingerprints = scenarios.map(item => crypto.createHash('sha256').update(JSON.stringify({ alert: item.alert, logs: item.logs, metrics: item.metrics })).digest('hex'));
  return {
    exact_duplicate_count: fingerprints.length - new Set(fingerprints).size,
    reference_count: scenarios.filter(item => item.split === 'reference').length,
    holdout_count: scenarios.filter(item => item.split === 'holdout').length,
    categories: [...new Set(scenarios.map(item => item.expected_category))].sort()
  };
}

module.exports = { createScenarios, datasetAudit };
