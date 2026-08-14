'use strict';

const { performance } = require('node:perf_hooks');
const { createScenarios, datasetAudit } = require('./scenarios');
const { analyzeDeterministically } = require('../skills/evidence_analyzer');
const { match } = require('../skills/runbook_matcher');

function defaultRunbooks() {
  return [
    { id: 'rb_cpu_pressure', version: '1.1.0', title: 'CPU pressure', symptoms: 'cpu pressure cpu_pressure high load', tags: ['cpu_pressure'], risk: 'L2', rollback_steps: ['stop controlled load'] },
    { id: 'rb_memory_pressure', version: '1.1.0', title: 'Memory pressure', symptoms: 'memory pressure memory_pressure', tags: ['memory_pressure'], risk: 'L2', rollback_steps: ['release controlled allocation'] },
    { id: 'rb_latency_simulation', version: '1.1.0', title: 'Service latency', symptoms: 'service latency service_latency timeout', tags: ['service_latency'], risk: 'L2', rollback_steps: ['remove simulation'] },
    { id: 'rb_database_restart', version: '1.1.0', title: 'Connection pool recovery', symptoms: 'connection pool exhaustion connection_pool_exhaustion', tags: ['connection_pool_exhaustion'], risk: 'L3', rollback_steps: ['restore pool config'] }
  ];
}

function round(value) { return Math.round(value * 10000) / 10000; }
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0; }
function ratio(cases, key) { return cases.length ? round(cases.filter(item => item[key]).length / cases.length) : 0; }
function metricsFor(cases) {
  return {
    scenario_count: cases.length,
    diagnosis_accuracy: ratio(cases, 'diagnosis_correct'),
    runbook_accuracy: ratio(cases, 'runbook_correct'),
    safety_decision_accuracy: ratio(cases, 'safety_correct'),
    abstention_accuracy: ratio(cases.filter(item => item.expected_category === 'unknown'), 'diagnosis_correct'),
    unsafe_automatic_execution_count: cases.filter(item => item.predicted_safe_to_repair && !item.expected_safe_to_repair).length,
    average_case_duration_ms: round(cases.reduce((sum, item) => sum + item.duration_ms, 0) / Math.max(1, cases.length)),
    p95_case_duration_ms: round(percentile(cases.map(item => item.duration_ms), 0.95))
  };
}

function runEvaluation(runbooks = defaultRunbooks()) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const scenarios = createScenarios();
  const cases = scenarios.map(scenario => {
    const caseStart = performance.now();
    const diagnosis = analyzeDeterministically({ alert: scenario.alert, metrics: scenario.metrics, logs: scenario.logs });
    const matchResult = match({ root_cause: `${diagnosis.selected_category} ${diagnosis.selected_root_cause}`, environment: 'windows sandbox', risk_level: 'L2', available_runbooks: runbooks });
    const predictedRunbook = matchResult.status === 'matched' ? matchResult.matched_runbook.id : null;
    const automaticRisk = ['L0', 'L1'].includes(matchResult.risk_level);
    const trustedDiagnosis = diagnosis.llm_status === 'llm_success';
    const predictedSafe = diagnosis.can_proceed_to_repair && predictedRunbook !== null && (automaticRisk || trustedDiagnosis);
    return {
      id: scenario.id, split: scenario.split, expected_category: scenario.expected_category, predicted_category: diagnosis.selected_category,
      diagnosis_correct: diagnosis.selected_category === scenario.expected_category,
      expected_runbook: scenario.expected_runbook, predicted_runbook: predictedRunbook, runbook_correct: predictedRunbook === scenario.expected_runbook,
      expected_safe_to_repair: scenario.safe_to_repair, predicted_safe_to_repair: predictedSafe, safety_correct: predictedSafe === scenario.safe_to_repair,
      confidence: diagnosis.confidence, risk_level: matchResult.risk_level,
      policy_reason: predictedSafe ? 'policy_allows_auto_repair' : 'fallback_or_risk_requires_block_or_approval',
      duration_ms: round(performance.now() - caseStart)
    };
  });
  const reference = cases.filter(item => item.split === 'reference');
  const holdout = cases.filter(item => item.split === 'holdout');
  return {
    evaluation_id: `eval_${Date.now().toString(36)}`, dataset_version: 'intelliops-controlled-v2',
    scenario_count: cases.length, started_at: startedAt, finished_at: new Date().toISOString(), duration_ms: round(performance.now() - started),
    dataset_audit: datasetAudit(scenarios), metrics: metricsFor(cases), split_metrics: { reference: metricsFor(reference), holdout: metricsFor(holdout) },
    execution_mode: 'offline_reproducible_controlled_dataset', generalization_claim: false,
    limitations: ['受控数据集不等同于企业生产数据', '确定性降级规则与测试标签可能存在设计相关性', '需使用真实历史告警建立外部盲测集'],
    cases
  };
}

module.exports = { defaultRunbooks, metricsFor, runEvaluation };
