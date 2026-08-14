'use strict';

const VERSION = '1.1.0';
const ALLOWED_METRICS = new Set(['cpu_percent', 'memory_percent', 'disk_percent', 'cpu_count', 'memory_used_gb', 'memory_total_gb']);

function validate(input) {
  if (!input || typeof input !== 'object') throw new TypeError('input 必须是对象');
  if (typeof input.target_service !== 'string' || !input.target_service.trim()) throw new TypeError('target_service 必须是非空字符串');
  if (!Array.isArray(input.metrics) || input.metrics.length === 0) throw new TypeError('metrics 必须是非空数组');
  const metrics = [...new Set(input.metrics.map(String))];
  const invalid = metrics.filter(name => !ALLOWED_METRICS.has(name));
  if (invalid.length) throw new RangeError(`不支持的指标: ${invalid.join(', ')}`);
  const seconds = Math.max(0, Math.min(3600, Number(input.time_range && input.time_range.seconds) || 0));
  return { target_service: input.target_service.trim(), metrics, time_range: { seconds } };
}

function unitFor(name) {
  if (name.endsWith('_percent')) return 'percent';
  if (name.endsWith('_gb')) return 'GB';
  return 'count';
}

function createSkill(dependencies) {
  if (!dependencies || typeof dependencies.collectSnapshot !== 'function') throw new TypeError('collectSnapshot dependency is required');
  return {
    name: 'system_metrics_collector', version: VERSION, owner: 'Detective',
    description: '采集带时间戳的本机真实指标，并显式标记数据来源与采集错误',
    input_schema: require('./input.schema.json'), output_schema: require('./output.schema.json'),
    async execute(rawInput) {
      const input = validate(rawInput);
      const collectedAt = new Date().toISOString();
      const snapshot = await dependencies.collectSnapshot(input.target_service, input.time_range);
      if (!snapshot || typeof snapshot !== 'object') throw new Error('指标采集器未返回对象');
      const samples = [];
      const errors = [];
      for (const name of input.metrics) {
        const value = snapshot[name];
        if (typeof value === 'number' && Number.isFinite(value)) {
          samples.push({ metric: name, value, unit: unitFor(name), timestamp: collectedAt, source: snapshot.source || 'real_local_system_probe' });
        } else errors.push({ metric: name, error: 'metric_unavailable' });
      }
      return {
        skill: 'system_metrics_collector', version: VERSION, target_service: input.target_service,
        collection_mode: 'real', data_source: snapshot.source || 'real_local_system_probe',
        collected_at: collectedAt, samples, errors
      };
    }
  };
}

module.exports = { VERSION, ALLOWED_METRICS, validate, createSkill };
