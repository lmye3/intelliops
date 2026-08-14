'use strict';

const VERSION = '1.1.0';

function validate(input) {
  if (!input || typeof input !== 'object') throw new TypeError('input 必须是对象');
  if (!input.alert || typeof input.alert !== 'object') throw new TypeError('alert 必须是对象');
  if (!Array.isArray(input.logs)) throw new TypeError('logs 必须是数组');
  if (!Array.isArray(input.metrics)) throw new TypeError('metrics 必须是数组');
  return input;
}

function metricValue(metrics, name) {
  const row = metrics.find(item => item && item.metric === name);
  return row && Number(row.value);
}

function analyzeDeterministically(input) {
  const alertText = `${input.alert.title || ''} ${input.alert.description || ''} ${input.alert.code || ''}`.toLowerCase();
  const logText = input.logs.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' ').toLowerCase();
  const text = `${alertText} ${logText}`;
  const evidence = [];
  let rootCause = '现有证据不足，不能可靠确定根因';
  let category = 'unknown';
  if (/pool_timeout|连接池|connection pool/.test(text)) {
    category = 'connection_pool_exhaustion'; rootCause = '数据库连接池容量不足或配置异常，导致并发请求等待超时';
    evidence.push({ ref: 'logs:pool-timeout', source: 'logs', claim: '日志包含连接池等待超时信号' });
  } else if (/process.*not.*running|进程未运行|not running/.test(text)) {
    category = 'process_not_running'; rootCause = '目标应用进程未运行';
    evidence.push({ ref: 'alert:process-state', source: 'alert', claim: '探测结果确认进程不存在' });
  } else if (/latency|timeout|延迟|超时/.test(text)) {
    category = 'service_latency'; rootCause = '服务响应延迟超过运行基线';
    evidence.push({ ref: 'alert:latency', source: 'alert', claim: '告警包含延迟或超时信号' });
  }
  const cpu = metricValue(input.metrics, 'cpu_percent');
  const memory = metricValue(input.metrics, 'memory_percent');
  if (Number.isFinite(cpu) && cpu >= 90) {
    category = 'cpu_pressure'; rootCause = 'CPU 持续高负载造成服务处理能力下降';
    evidence.push({ ref: 'metric:cpu_percent', source: 'metrics', claim: `CPU=${cpu}%` });
  }
  if (Number.isFinite(memory) && memory >= 90) {
    category = 'memory_pressure'; rootCause = '内存压力导致服务可用资源不足';
    evidence.push({ ref: 'metric:memory_percent', source: 'metrics', claim: `memory=${memory}%` });
  }
  evidence.push(...(Array.isArray(input.evidence_refs) ? input.evidence_refs : []));
  const confidence = category === 'unknown' ? 0.42 : Math.min(0.95, 0.68 + Math.min(3, evidence.length) * 0.09);
  return {
    status: category === 'unknown' ? 'insufficient_evidence' : 'analyzed',
    analysis_mode: 'deterministic_fallback', llm_status: 'fallback_template', model: '',
    candidates: [{ root_cause: rootCause, category, confidence, evidence_refs: evidence }],
    selected_root_cause: rootCause, selected_category: category, confidence,
    evidence_refs: evidence, counter_evidence: input.counter_evidence || [],
    missing_evidence: category === 'unknown' ? ['可验证指标', '相关服务日志', '最近配置变更'] : [],
    can_proceed_to_repair: false,
    fallback_reason: 'llm_not_configured_or_unavailable'
  };
}

function createSkill(dependencies = {}) {
  return {
    name: 'evidence_analyzer', version: VERSION, owner: 'Detective',
    description: '分析告警、指标和日志，输出候选根因、置信度、证据引用、反证与缺失证据',
    input_schema: require('./input.schema.json'), output_schema: require('./output.schema.json'),
    async execute(rawInput, context) {
      const input = validate(rawInput);
      if (typeof dependencies.llmAnalyze === 'function') {
        try {
          const result = await dependencies.llmAnalyze(input, context);
          if (!result || !Array.isArray(result.candidates) || typeof result.confidence !== 'number') throw new TypeError('LLM 输出结构不合法');
          return { ...result, analysis_mode: 'llm', llm_status: 'llm_success', can_proceed_to_repair: result.confidence >= 0.80 };
        } catch (error) {
          const fallback = analyzeDeterministically(input);
          return { ...fallback, llm_status: 'fallback_template', llm_error: String(error.message || error), fallback_reason: 'llm_call_or_schema_failed' };
        }
      }
      return analyzeDeterministically(input);
    }
  };
}

module.exports = { VERSION, validate, analyzeDeterministically, createSkill };
