'use strict';

const VERSION = '1.1.0';

function tokens(value) {
  return String(value || '').toLowerCase().split(/[\s,;，；、|]+/).map(item => item.trim()).filter(item => item.length > 1);
}

function validate(input) {
  if (!input || typeof input !== 'object') throw new TypeError('input 必须是对象');
  if (typeof input.root_cause !== 'string' || !input.root_cause.trim()) throw new TypeError('root_cause 必须是非空字符串');
  if (!Array.isArray(input.available_runbooks)) throw new TypeError('available_runbooks 必须是数组');
  return input;
}

function match(input) {
  validate(input);
  const query = new Set(tokens(`${input.root_cause} ${input.environment || ''}`));
  const ranked = input.available_runbooks.map(runbook => {
    const words = new Set(tokens(`${runbook.id} ${runbook.title} ${runbook.symptoms} ${(runbook.tags || []).join(' ')}`));
    const hits = [...query].filter(word => words.has(word));
    const score = query.size ? hits.length / query.size : 0;
    return { runbook, score: Math.round(score * 1000) / 1000, hits };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.16) {
    return { status: 'no_match', matched_runbook: null, match_score: best ? best.score : 0, match_basis: [], parameters: {}, risk_level: input.risk_level || 'L1', rollback_conditions: [] };
  }
  return {
    status: 'matched', matched_runbook: { id: best.runbook.id, version: best.runbook.version, title: best.runbook.title },
    match_score: best.score, match_basis: best.hits, parameters: input.parameters || {},
    risk_level: best.runbook.risk || input.risk_level || 'L1', rollback_conditions: best.runbook.rollback_steps || []
  };
}

function createSkill() {
  return {
    name: 'runbook_matcher', version: VERSION, owner: 'Ranger',
    description: '依据根因、环境和风险匹配白名单 Runbook；无合适项时返回 no_match',
    input_schema: require('./input.schema.json'), output_schema: require('./output.schema.json'),
    async execute(input) { return match(input); }
  };
}

module.exports = { VERSION, tokens, validate, match, createSkill };
