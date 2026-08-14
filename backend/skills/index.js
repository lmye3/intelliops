'use strict';

const systemMetrics = require('./system_metrics_collector');
const evidenceAnalyzer = require('./evidence_analyzer');
const runbookMatcher = require('./runbook_matcher');

function createCoreSkills(dependencies) {
  const skills = [
    systemMetrics.createSkill({ collectSnapshot: dependencies.collectSnapshot }),
    evidenceAnalyzer.createSkill({ llmAnalyze: dependencies.llmAnalyze }),
    runbookMatcher.createSkill()
  ];
  return Object.fromEntries(skills.map(skill => [skill.name, skill]));
}

module.exports = { createCoreSkills, systemMetrics, evidenceAnalyzer, runbookMatcher };
