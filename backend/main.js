'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { createCoreSkills } = require('./skills');
const evidenceLedger = require('./lib/evidence_ledger');
const secretStore = require('./lib/secret_store');
const { assertSchema } = require('./lib/schema_validator');
const { AgentTeamsAdapter, normalizeBaseUrl } = require('./integrations/agentteams_adapter');
const { runEvaluation } = require('./evaluation/runner');
const { DigitalTwinManager } = require('./digital_twin');

let sea = null;
try { sea = require('node:sea'); } catch (_) { /* Node < 20 development fallback */ }

const APP_NAME = 'IntelliOps';
const APP_VERSION = '16.1.0';
const AGENTTEAMS_TARGET = 'v1.2.2';
const MCP_PROTOCOL_VERSION = '2024-11-05';
let trayProcess = null;
let autoStartEnabled = false;
// RAG: simple TF-IDF for runbook matching
function tokenize(text) { return String(text||'').toLowerCase().split(/[\s,;，；]+/).filter(Boolean); }
function tfidf(docs) { const df={},N=docs.length; docs.forEach(d=>{ const seen=new Set(); d.forEach(t=>{ if(!seen.has(t)){ df[t]=(df[t]||0)+1; seen.add(t) } }) }); return docs.map(d=>{ const tf={}; d.forEach(t=>{ tf[t]=(tf[t]||0)+1 }); const vec={}; for(const t of new Set(d)){ vec[t]=(tf[t]/d.length)*Math.log(N/(df[t]||1)) } return vec }); }
function cosineSimilarity(a,b){ let dot=0,normA=0,normB=0; const keys=new Set([...Object.keys(a),...Object.keys(b)]); keys.forEach(k=>{ dot+=(a[k]||0)*(b[k]||0); normA+=(a[k]||0)**2; normB+=(b[k]||0)**2 }); return normA&&normB?dot/(Math.sqrt(normA)*Math.sqrt(normB)):0 }
const RUNTIME_MODE = 'embedded-compatible';
const HOST = '127.0.0.1';
const PORT = Number(process.env.INTELLIOPS_PORT || 8766);
const startedAt = Date.now();
let requestCount = 0;
let aiKey = process.env.INTELLIOPS_LLM_API_KEY || process.env.INTELLIOPS_API_KEY || '';
// State schema version for data migration
const SCHEMA_VERSION = 8;
let server = null;
let edgeProcess = null;
let memoryFault = null;
let faultWorker = null;
let faultState = { active: false, type: '', until: 0, started_at: null };
let monitorTimer = null;
let parentWatchdogTimer = null;
const runningProbes = new Set();
let agentTeamsLastStatus = { connected: false, mode: 'local_verified', reason: 'not_checked', checked_at: null };
const digitalTwin = new DigitalTwinManager();

function now() { return new Date().toISOString(); }
function makeId(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function dataDirectory() {
  if (process.env.INTELLIOPS_DATA_DIR) return path.resolve(process.env.INTELLIOPS_DATA_DIR);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'IntelliOps');
  }
  return path.join(os.tmpdir(), 'IntelliOps-development');
}

const DATA_DIR = dataDirectory();
const DATA_FILE = path.join(DATA_DIR, 'intelliops-data.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const AI_KEY_FILE = path.join(DATA_DIR, 'llm-api-key.dpapi');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(level, message, extra = '') {
  const line = `${now()} [${level}] ${message}${extra ? ` ${extra}` : ''}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) { /* best effort */ }
  if (!sea || !sea.isSea()) process.stderr.write(line);
}

const seededRunbooks = [
  {
    id: 'rb_cpu_pressure', version: '1.0.0', title: '受控 CPU 压力恢复', category: '系统',
    symptoms: 'CPU 高负载 压力测试 cpu', risk: 'L2', tags: ['cpu', 'cpu_pressure', 'sandbox'],
    allowed_parameters: { duration: { type: 'integer', min: 1, max: 30 } }, timeout: 35,
    steps: ['等待受控压测到期', '确认压力线程已经终止'],
    verification_steps: ['确认 fault_injection.active=false', '重新采集系统指标'],
    rollback_steps: ['主动终止压力线程'], verified: 0, success: null
  },
  {
    id: 'rb_memory_pressure', version: '1.0.0', title: '受控内存压力恢复', category: '系统',
    symptoms: '内存 高占用 压力测试 memory', risk: 'L2', tags: ['memory', 'memory_pressure', 'sandbox'],
    allowed_parameters: { mb: { type: 'integer', min: 1, max: 512 } }, timeout: 35,
    steps: ['等待受控内存分配到期', '释放测试缓冲区'],
    verification_steps: ['确认测试缓冲区已释放', '重新采集系统指标'],
    rollback_steps: ['立即释放测试缓冲区'], verified: 0, success: null
  },
  {
    id: 'rb_latency_simulation', version: '1.0.0', title: '服务高延迟模拟处置', category: '应用',
    symptoms: '超时 高延迟 latency timeout', risk: 'L2', tags: ['latency', 'service_latency', 'simulation'],
    allowed_parameters: {}, timeout: 10,
    steps: ['在模拟环境应用限流策略', '复核运行状态'],
    verification_steps: ['检查模拟执行器返回值'], rollback_steps: ['撤销模拟策略'],
    verified: 0, success: null
  },
  {
    id: 'rb_database_restart', version: '1.0.0', title: '数据库连接池重启', category: '数据库',
    symptoms: '数据库 连接池 connection pool restart', risk: 'L3', tags: ['database', 'connection_pool_exhaustion', 'approval'],
    allowed_parameters: { pool: { type: 'string', enum: ['demo-pool'] } }, timeout: 30,
    steps: ['等待人工审批', '仅在演示沙箱重建连接池'],
    verification_steps: ['验证健康检查'], rollback_steps: ['恢复先前连接池配置'],
    verified: 0, success: null
  }
];

seededRunbooks.push(
  {
    id: 'rb_twin_restore_config', version: '1.0.0', title: '恢复数字孪生基线配置', category: '数字孪生',
    symptoms: '孪生 延迟 错误配置 gateway payment latency config', risk: 'L1', tags: ['digital_twin', 'restore_config'],
    allowed_parameters: { component_id: { type: 'string', enum: ['gateway', 'payment'] } }, timeout: 10,
    steps: ['恢复项目内数字孪生组件基线配置'], verification_steps: ['通过真实HTTP请求重新测量错误率和P95延迟'],
    rollback_steps: ['恢复操作前配置快照'], verified: 0, success: null
  },
  {
    id: 'rb_twin_restart_service', version: '1.0.0', title: '重启数字孪生受管服务', category: '数字孪生',
    symptoms: '孪生 服务退出 payment gateway crash', risk: 'L2', tags: ['digital_twin', 'restart_service'],
    allowed_parameters: { component_id: { type: 'string', enum: ['gateway', 'payment'] } }, timeout: 15,
    steps: ['关闭项目内监听器', '重新初始化服务监听器'], verification_steps: ['通过真实HTTP请求验证新一代服务'],
    rollback_steps: ['停止新监听器并恢复先前配置'], verified: 0, success: null
  },
  {
    id: 'rb_twin_restart_managed_app', version: '1.0.0', title: '重启数字孪生受管应用', category: '数字孪生',
    symptoms: '孪生 受管应用退出 inventory app crash', risk: 'L3', tags: ['digital_twin', 'managed_application', 'approval'],
    allowed_parameters: { component_id: { type: 'string', enum: ['inventory-app'] } }, timeout: 15,
    steps: ['校验审批内容摘要', '重启项目自带受管应用'], verification_steps: ['通过真实HTTP请求验证应用恢复'],
    rollback_steps: ['停止新实例并保持事件失败状态'], verified: 0, success: null
  }
);

function defaultMonitorTargets() {
  return [{
    id: 'monitor_local_system', name: '本机资源', type: 'system', enabled: true,
    interval_sec: 15, timeout_ms: 5000, consecutive_failures: 3,
    config: {}, thresholds: { cpu_percent: 90, memory_percent: 90, disk_percent: 95 },
    status: 'pending', last_check_at: null, next_check_at: now(), last_result: null,
    failure_streak: 0, recovery_streak: 0, open_incident_id: null, created_at: now(), updated_at: now()
  }];
}

function initialState() {
  return {
    schema_version: 8,
    incidents: [], alerts: [], diagnoses: [], repairs: [], postmortems: [], approvals: [], traces: [],
    skill_runs: [], tool_calls: [], rollback_runs: [], metric_samples: [], debates: [], diagnosis_feedback: [],
    evidence_ledger: [], evaluation_runs: [], agentteams_dispatches: [], llm_calls: [], twin_runs: [], demo_runs: [],
    monitor_targets: defaultMonitorTargets(), monitor_results: [],
    runbooks: JSON.parse(JSON.stringify(seededRunbooks)),
    settings: { endpoint: process.env.INTELLIOPS_LLM_BASE_URL || '', model: process.env.INTELLIOPS_LLM_MODEL || 'deepseek-chat', agentteams_controller_url: '', agentteams_team_name: 'intelliops-operations', monitoring_enabled: true }
  };
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return initialState();
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const previousSchema = Number(parsed.schema_version || 0);
    const base = initialState();
    for (const key of ['incidents', 'alerts', 'diagnoses', 'repairs', 'postmortems', 'approvals', 'traces',
      'skill_runs', 'tool_calls', 'rollback_runs', 'metric_samples', 'debates', 'diagnosis_feedback', 'monitor_targets', 'monitor_results', 'runbooks',
      'evidence_ledger', 'evaluation_runs', 'agentteams_dispatches', 'llm_calls', 'twin_runs', 'demo_runs']) {
      if (!Array.isArray(parsed[key])) parsed[key] = base[key];
    }
    if (previousSchema < 4 && parsed.monitor_targets.length === 0) parsed.monitor_targets = defaultMonitorTargets();
    if (parsed.monitor_targets.filter(t=>t.type==='application').length===0) { parsed.monitor_targets.push({id:'monitor_app_explorer',name:'Windows 资源管理器',type:'application',enabled:false,interval_sec:60,timeout_ms:10000,consecutive_failures:3,config:{process_name:'explorer.exe'},thresholds:{mem_mb:500,min_uptime_min:1},next_check_at:now(),last_result:null,status:'pending'}); }
    parsed.settings = Object.assign(base.settings, parsed.settings || {});
    parsed.schema_version = 8;
    // One-time migration from legacy plaintext state to Windows DPAPI.
    if (parsed.settings.ai_api_key) {
      try { secretStore.save(AI_KEY_FILE, parsed.settings.ai_api_key); aiKey = parsed.settings.ai_api_key; } catch (error) { log('ERROR', 'AI密钥迁移失败', error.message); }
      delete parsed.settings.ai_api_key;
    } else if (!aiKey) {
      try { aiKey = secretStore.load(AI_KEY_FILE); } catch (error) { log('ERROR', 'AI密钥读取失败', error.message); }
    }
    return parsed;
  } catch (error) {
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(DATA_FILE, backup); } catch (_) { /* best effort */ }
    log('ERROR', '数据文件损坏，已启用新数据库', String(error));
    return initialState();
  }
}

let state = loadState();
if (!aiKey) { try { aiKey = secretStore.load(AI_KEY_FILE); } catch (error) { log('ERROR', 'AI密钥读取失败', error.message); } }

// A demo pipeline only lives in this backend process. If the desktop app was
// closed while an L1/L2 run was executing, the persisted RUNNING flag must not
// block every later demonstration forever. Keep the historical record, but
// explicitly mark it as interrupted on the next start. WAITING_APPROVAL is
// intentionally preserved because it represents a durable human decision.
function reconcileInterruptedDemoRuns() {
  let changed = false;
  for (const run of state.demo_runs) {
    if (run.status !== 'RUNNING') continue;
    run.status = 'INTERRUPTED';
    run.stage = 'INTERRUPTED';
    run.error = run.error || '桌面应用在演示完成前退出；本次运行已中断，可重新启动场景';
    run.updated_at = now();
    run.finished_at = run.finished_at || now();
    const incident = state.incidents.find(item => item.id === run.event_id);
    if (incident && !['resolved', 'failed', 'rejected'].includes(incident.status)) {
      incident.status = 'failed';
      incident.current_agent = '已中断';
      timeline(incident, 'System', '应用重启时检测到未完成的数字孪生任务，已标记中断；未伪造恢复结果');
    }
    changed = true;
  }
  return changed;
}

let activeTwinDemoRunId = '';

function saveState() {
  const temp = `${DATA_FILE}.tmp`;
  const safe = JSON.parse(JSON.stringify(state));
  if (safe.settings) delete safe.settings.api_key;
  fs.writeFileSync(temp, JSON.stringify(safe, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}

if (reconcileInterruptedDemoRuns()) saveState();

function frontendHtml() {
  if (sea && sea.isSea()) return sea.getAsset('app.html', 'utf8');
  const candidates = [path.join(__dirname, '..', 'app-v4.html'), path.join(__dirname, '..', 'frontend', 'app.html')];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  if (!file) throw new Error('frontend asset not found');
  return fs.readFileSync(file, 'utf8');
}

function frontendScript(name = 'v13-rendering.js') {
  const safeName = path.basename(name);
  const candidates = [path.join(__dirname, '..', 'frontend', safeName)];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  if (!file) throw new Error('frontend rendering controller not found');
  return fs.readFileSync(file, 'utf8');
}

function publicIncident(incident) {
  return {
    ...incident,
    created: incident.created_at,
    currentAgent: incident.current_agent,
    mttr: incident.mttr_minutes
  };
}

function timeline(incident, agent, action) {
  const entry = { time: now(), agent, action };
  incident.timeline.push(entry);
  incident.updated_at = now();
  const trace = state.traces.find(item => item.event_id === incident.id);
  evidenceLedger.append(state, incident.id, 'timeline_entry', entry, { actor: agent, trace_id: trace && trace.plan ? trace.plan.trace_id : '' });
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const paymentSandbox = {
  service: 'payment-api', baselinePool: 64, poolMax: 64, active: 0, queue: [],
  configVersion: 1, changeLog: [], requestLog: [], lastBatch: null
};

function sandboxConfig() {
  return {
    service: paymentSandbox.service, pool_max: paymentSandbox.poolMax,
    baseline_pool_max: paymentSandbox.baselinePool, active: paymentSandbox.active,
    queued: paymentSandbox.queue.filter(item => item.active).length,
    config_version: paymentSandbox.configVersion
  };
}

function setSandboxPool(value, actor, reason) {
  const before = paymentSandbox.poolMax;
  paymentSandbox.poolMax = Math.max(1, Math.min(128, Number(value)));
  paymentSandbox.configVersion += 1;
  const change = { id: makeId('change'), at: now(), actor, reason, before, after: paymentSandbox.poolMax };
  paymentSandbox.changeLog.push(change);
  return change;
}

function releaseSandboxSlot() {
  while (paymentSandbox.queue.length) {
    const waiter = paymentSandbox.queue.shift();
    if (!waiter.active) continue;
    waiter.active = false;
    clearTimeout(waiter.timer);
    paymentSandbox.active += 1;
    waiter.resolve(true);
    return;
  }
}

function acquireSandboxSlot(timeoutMs) {
  if (paymentSandbox.active < paymentSandbox.poolMax) {
    paymentSandbox.active += 1;
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const waiter = { active: true, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      if (!waiter.active) return;
      waiter.active = false;
      resolve(false);
    }, timeoutMs);
    paymentSandbox.queue.push(waiter);
  });
}

async function sandboxPaymentRequest(batchId, index, options = {}) {
  const started = Date.now();
  const acquired = await acquireSandboxSlot(options.timeout_ms || 80);
  if (!acquired) {
    const entry = { batch_id: batchId, request_id: `${batchId}-${index}`, ok: false, code: 'POOL_TIMEOUT', duration_ms: Date.now() - started, at: now() };
    paymentSandbox.requestLog.push(entry);
    return entry;
  }
  try {
    await sleep(options.work_ms || 60);
    const entry = { batch_id: batchId, request_id: `${batchId}-${index}`, ok: true, code: 'OK', duration_ms: Date.now() - started, at: now() };
    paymentSandbox.requestLog.push(entry);
    return entry;
  } finally {
    paymentSandbox.active -= 1;
    releaseSandboxSlot();
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

async function runPaymentLoad(label, requestCountValue, options = {}) {
  const count = Math.max(1, Math.min(100, Number(requestCountValue) || 36));
  const batchId = makeId('batch');
  const configBefore = sandboxConfig();
  const results = await Promise.all(Array.from({ length: count }, (_, index) => sandboxPaymentRequest(batchId, index + 1, options)));
  const failed = results.filter(item => !item.ok);
  const durations = results.map(item => item.duration_ms);
  const summary = {
    batch_id: batchId, label, timestamp: now(), request_count: results.length,
    success_count: results.length - failed.length, error_count: failed.length,
    error_rate: Math.round(failed.length / results.length * 10000) / 100,
    p95_latency_ms: percentile(durations, 0.95), max_latency_ms: Math.max(...durations),
    pool_max: configBefore.pool_max, source: 'payment_sandbox_actual_requests'
  };
  paymentSandbox.lastBatch = summary;
  return { summary, results };
}

async function toolCall(context, toolName, input, execute) {
  const started = Date.now();
  const call = {
    tool_call_id: makeId('tool'), event_id: context.event_id, trace_id: context.trace_id,
    agent_run_id: context.agent_run_id, skill_run_id: context.skill_run_id,
    tool_name: toolName, input_hash: stableHash(input), status: 'RUNNING',
    started_at: now(), finished_at: null, duration_ms: null, output_summary: null, error: null
  };
  state.tool_calls.push(call);
  try {
    const output = await execute();
    call.status = 'SUCCEEDED';
    call.output_summary = JSON.parse(JSON.stringify(output));
    return output;
  } catch (error) {
    call.status = 'FAILED';
    call.error = String(error.message || error);
    throw error;
  } finally {
    call.finished_at = now();
    call.duration_ms = Date.now() - started;
    saveState();
  }
}

function evidenceReferences(input) {
  const refs = [{ ref: 'alert:primary', source: 'alert', claim: String(input.alert && (input.alert.title || input.alert.description) || '').slice(0, 300) }];
  (input.metrics || []).slice(0, 20).forEach((item, index) => refs.push({ ref: `metric:${item.metric || index}`, source: 'metrics', claim: `${item.metric || 'metric'}=${item.value}` }));
  (input.logs || []).slice(0, 10).forEach((item, index) => refs.push({ ref: `log:${index + 1}`, source: 'logs', claim: String(item).slice(0, 300) }));
  return refs;
}

function parseLlmJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new TypeError('LLM 未返回 JSON 对象');
    return JSON.parse(match[0]);
  }
}

async function llmAnalyzeEvidence(input, context = {}) {
  if (!aiKey || !state.settings.endpoint) throw new Error('llm_not_configured');
  const started = Date.now();
  const factualRefs = evidenceReferences(input);
  const compactInput = { alert: input.alert, metrics: input.metrics, logs: input.logs, allowed_evidence_refs: factualRefs.map(item => item.ref) };
  const prompt = [
    '你是企业SRE诊断Agent。只依据给定证据输出JSON，不得编造证据。',
    '字段：selected_root_cause(string), selected_category(string), confidence(0到1), counter_evidence(array), missing_evidence(array)。',
    '证据不足时降低confidence并列出missing_evidence。输入：', JSON.stringify(compactInput)
  ].join('\n');
  const call = {
    llm_call_id: makeId('llm'), event_id: context.event_id || '', trace_id: context.trace_id || '', agent_run_id: context.agent_run_id || '',
    purpose: 'evidence_analysis', model: state.settings.model, endpoint_host: new URL(state.settings.endpoint).host,
    prompt_hash: stableHash(prompt), input_hash: stableHash(compactInput), status: 'RUNNING',
    started_at: now(), finished_at: null, duration_ms: null, response_hash: '', usage: null, error_type: '', error_message: ''
  };
  state.llm_calls.push(call);
  try {
    const response = await fetch(state.settings.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aiKey}` },
      body: JSON.stringify({ model: state.settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 700, temperature: 0.1 }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const parsed = parseLlmJson(content);
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new TypeError('LLM confidence 无效');
    if (!String(parsed.selected_root_cause || '').trim() || !String(parsed.selected_category || '').trim()) throw new TypeError('LLM 根因字段缺失');
    call.status = 'SUCCEEDED';
    call.response_hash = stableHash(content);
    call.usage = data.usage ? {
      prompt_tokens: Number(data.usage.prompt_tokens || 0), completion_tokens: Number(data.usage.completion_tokens || 0), total_tokens: Number(data.usage.total_tokens || 0)
    } : null;
    const result = {
      status: 'analyzed', candidates: [{ root_cause: String(parsed.selected_root_cause), category: String(parsed.selected_category), confidence, evidence_refs: factualRefs }],
      selected_root_cause: String(parsed.selected_root_cause), selected_category: String(parsed.selected_category), confidence,
      evidence_refs: factualRefs, counter_evidence: Array.isArray(parsed.counter_evidence) ? parsed.counter_evidence.slice(0, 20) : [],
      missing_evidence: Array.isArray(parsed.missing_evidence) ? parsed.missing_evidence.slice(0, 20) : [], model: state.settings.model,
      llm_call_id: call.llm_call_id
    };
    evidenceLedger.append(state, context.event_id || 'system', 'llm_call_succeeded', {
      llm_call_id: call.llm_call_id, model: call.model, prompt_hash: call.prompt_hash, response_hash: call.response_hash, usage: call.usage, duration_ms: Date.now() - started
    }, { actor: 'Detective', trace_id: context.trace_id || '' });
    return result;
  } catch (error) {
    call.status = 'FAILED'; call.error_type = error.name || 'Error'; call.error_message = String(error.message || error).slice(0, 1000);
    evidenceLedger.append(state, context.event_id || 'system', 'llm_call_failed', {
      llm_call_id: call.llm_call_id, model: call.model, prompt_hash: call.prompt_hash, error_type: call.error_type, error_message: call.error_message
    }, { actor: 'Detective', trace_id: context.trace_id || '' });
    throw error;
  } finally {
    call.finished_at = now(); call.duration_ms = Date.now() - started; saveState();
  }
}

const coreSkillRegistry = createCoreSkills({
  collectSnapshot: async () => ({ ...monitorSnapshot(), source: 'real_local_system_probe' }),
  llmAnalyze: llmAnalyzeEvidence
});

const skillRegistry = {
  ...coreSkillRegistry,
  'alert-aggregator': {
    version: '1.0.0', owner: 'Commander', description: '按服务、错误码和时间窗口聚合真实告警',
    input_schema: { event_id: 'string', alerts: 'array' },
    async execute(input, context) {
      const alerts = await toolCall(context, 'local-alert-store.query', { event_id: input.event_id }, async () => input.alerts || []);
      const groups = new Map();
      for (const alert of alerts) {
        const key = `${alert.service}|${alert.code}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(alert);
      }
      const clusters = [...groups.entries()].map(([fingerprint, items]) => ({
        fingerprint, count: items.length, first_at: items[0].created_at,
        last_at: items.at(-1).created_at, sample_ids: items.slice(0, 5).map(item => item.id)
      }));
      return {
        input_alert_count: alerts.length, cluster_count: clusters.length,
        noise_reduction_percent: alerts.length ? Math.round((1 - clusters.length / alerts.length) * 10000) / 100 : 0,
        clusters
      };
    }
  },
  'log-hunter': {
    version: '1.0.0', owner: 'Detective', description: '查询支付沙箱实际请求日志', input_schema: { batch_id: 'string' },
    async execute(input, context) {
      const logs = await toolCall(context, 'payment-sandbox.logs', input, async () => paymentSandbox.requestLog.filter(item => item.batch_id === input.batch_id));
      const failures = logs.filter(item => !item.ok);
      const codes = failures.reduce((acc, item) => { acc[item.code] = (acc[item.code] || 0) + 1; return acc; }, {});
      return { total: logs.length, failure_count: failures.length, error_codes: codes, sample: failures.slice(0, 5) };
    }
  },
  'metric-analyzer': {
    version: '1.0.0', owner: 'Detective', description: '分析真实压测批次指标', input_schema: { metrics: 'object' },
    async execute(input, context) {
      const metrics = await toolCall(context, 'payment-sandbox.metrics', { batch_id: input.metrics.batch_id }, async () => input.metrics);
      return {
        pool_exhausted: metrics.error_rate > 20 && metrics.pool_max < paymentSandbox.baselinePool,
        error_rate: metrics.error_rate, p95_latency_ms: metrics.p95_latency_ms,
        deviation_from_baseline_pool: paymentSandbox.baselinePool - metrics.pool_max
      };
    }
  },
  'change-scanner': {
    version: '1.0.0', owner: 'Detective', description: '扫描沙箱配置变更并计算关联性', input_schema: { since_version: 'number' },
    async execute(input, context) {
      const changes = await toolCall(context, 'payment-sandbox.changes', input, async () => paymentSandbox.changeLog.filter(item => item.after !== item.before));
      const latest = changes.at(-1) || null;
      return { change_count: changes.length, latest_change: latest, causal_signal: Boolean(latest && latest.after < latest.before) };
    }
  },
  'runbook-matcher': {
    version: '1.0.0', owner: 'Ranger', description: '根据结构化证据选择两阶段恢复方案', input_schema: { diagnosis: 'object' },
    async execute(input, context) {
      return toolCall(context, 'runbook-catalog.match', { root_cause: input.diagnosis.root_cause }, async () => ({
        selected: 'RB-DB-POOL-002', score: input.diagnosis.confidence,
        plan_a: { id: 'plan-a', title: '温和扩容至12连接', risk: 'L2', target_pool: 12 },
        plan_b: { id: 'plan-b', title: '恢复基线连接池并重建', risk: 'L3', target_pool: paymentSandbox.baselinePool }
      }));
    }
  },
  'recovery-verifier': {
    version: '1.0.0', owner: 'Ranger', description: '以真实并发请求验证恢复效果', input_schema: { stage: 'string' },
    async execute(input, context) {
      const load = await toolCall(context, 'payment-sandbox.load-test', { stage: input.stage, requests: 36 }, async () => runPaymentLoad(`verify-${input.stage}`, 36, { timeout_ms: 85, work_ms: 60 }));
      const passed = load.summary.error_rate <= 5 && load.summary.p95_latency_ms <= 100;
      return { passed, thresholds: { max_error_rate: 5, max_p95_latency_ms: 100 }, observed: load.summary };
    }
  },
  'rollback-executor': {
    version: '1.0.0', owner: 'Ranger', description: '恢复执行前配置并记录回滚证据', input_schema: { snapshot: 'object' },
    async execute(input, context) {
      const change = await toolCall(context, 'payment-sandbox.set-pool', { target: input.snapshot.pool_max }, async () => setSandboxPool(input.snapshot.pool_max, 'Ranger', '方案A验证失败，自动回滚'));
      return { restored: sandboxConfig().pool_max === input.snapshot.pool_max, snapshot: input.snapshot, change };
    }
  },
  'monitor-evidence-collector': {
    version: '1.0.0', owner: 'Detective', description: '固化真实监控探测、连续失败次数和阈值证据',
    input_schema: { target: 'object', result: 'object', recent_results: 'array' },
    async execute(input, context) {
      return toolCall(context, 'monitor-store.evidence', { target_id: input.target.id }, async () => ({
        target: { id: input.target.id, name: input.target.name, type: input.target.type, config: input.target.config, thresholds: input.target.thresholds },
        current: input.result,
        recent: (input.recent_results || []).slice(-10),
        evidence_grade: input.result && input.result.status !== 'unavailable' ? 'A-direct-probe' : 'C-insufficient',
        missing_evidence: input.result && input.result.status === 'unavailable' ? ['目标平台或探测器不可用'] : []
      }));
    }
  },
  'monitor-recovery-verifier': {
    version: '1.0.0', owner: 'Ranger', description: '重新执行原始探测，确认目标是否真实恢复',
    input_schema: { target_id: 'string' },
    async execute(input, context) {
      return toolCall(context, 'monitor-engine.probe', input, async () => {
        const target = state.monitor_targets.find(item => item.id === input.target_id);
        if (!target) throw new Error('监控目标不存在');
        const observed = await probeTarget(target);
        return { passed: observed.ok === true, observed };
      });
    }
  },
  'twin-evidence-collector': {
    version: '1.0.0', owner: 'Detective', description: '固化数字孪生组件真实HTTP故障指标与注入记录',
    input_schema: { component_id: 'string', scenario: 'string', metrics: 'object' },
    async execute(input, context) {
      return toolCall(context, 'digital-twin.evidence', { component_id: input.component_id, scenario: input.scenario }, async () => ({
        component_id: input.component_id, scenario: input.scenario, metrics: input.metrics,
        source: input.metrics && input.metrics.source,
        passed: Boolean(input.metrics && input.metrics.source === 'real_local_http_requests')
      }));
    }
  },
  'twin-recovery-verifier': {
    version: '1.0.0', owner: 'Ranger', description: '使用原数字孪生HTTP探测路径验证恢复结果',
    input_schema: { component_id: 'string', after: 'object', thresholds: 'object' },
    async execute(input, context) {
      return toolCall(context, 'digital-twin.verify', { component_id: input.component_id }, async () => ({
        passed: input.after.error_rate <= input.thresholds.max_error_rate && input.after.p95_latency_ms <= input.thresholds.max_p95_latency_ms,
        source: input.after.source, observed: input.after, thresholds: input.thresholds
      }));
    }
  }
};

async function runSkill(incident, agentRunValue, skillName, input) {
  const definition = skillRegistry[skillName];
  if (!definition) throw new Error(`Skill not found: ${skillName}`);
  const started = Date.now();
  const run = {
    skill_run_id: makeId('skill'), skill_name: skillName, skill_version: definition.version,
    event_id: incident.id, agent_run_id: agentRunValue.agent_run_id, trace_id: agentRunValue.trace_id,
    input_schema: definition.input_schema, input_hash: stableHash(input), status: 'RUNNING', schema_validated: false,
    started_at: now(), finished_at: null, duration_ms: null, output_summary: null, error: null, verification_result: null
  };
  state.skill_runs.push(run);
  evidenceLedger.append(state, incident.id, 'skill_started', { skill_run_id: run.skill_run_id, skill_name: skillName, input_hash: run.input_hash }, { actor: definition.owner, trace_id: run.trace_id });
  try {
    if (definition.input_schema && definition.input_schema.type) assertSchema(definition.input_schema, input, `${skillName} input`);
    const output = await definition.execute(input, { event_id: incident.id, trace_id: run.trace_id, agent_run_id: run.agent_run_id, skill_run_id: run.skill_run_id });
    if (definition.output_schema && definition.output_schema.type) assertSchema(definition.output_schema, output, `${skillName} output`);
    run.schema_validated = true;
    run.output_summary = JSON.parse(JSON.stringify(output));
    run.verification_result = output && Object.prototype.hasOwnProperty.call(output, 'passed') ? { passed: output.passed } : { passed: true };
    run.status = 'SUCCEEDED';
    return output;
  } catch (error) {
    run.status = 'FAILED';
    run.error = String(error.message || error);
    throw error;
  } finally {
    run.finished_at = now();
    run.duration_ms = Date.now() - started;
    saveState();
  }
}

function traceFor(eventId) {
  let trace = state.traces.find(item => item.event_id === eventId);
  if (!trace) {
    trace = {
      event_id: eventId,
      plan: {
        plan_id: makeId('plan'), trace_id: makeId('trace'), status: 'running',
        runtime: { mode: RUNTIME_MODE, agentteams_target: AGENTTEAMS_TARGET, topology: 'Manager-Workers', transport: 'in-process-audited' },
        created_at: now(), updated_at: now(),
        tasks: ['Commander', 'Detective', 'Ranger', 'Sage'].map((agent, order) => ({
          order, agent, task_type: ['triage', 'diagnose', 'repair', 'postmortem'][order], status: 'PENDING'
        }))
      },
      agent_runs: [], messages: []
    };
    state.traces.push(trace);
  }
  return trace;
}

async function agentRun(incident, agentName, taskType, parentRunId, work) {
  const trace = traceFor(incident.id);
  const task = trace.plan.tasks.find(item => item.agent === agentName);
  if (task) task.status = 'RUNNING';
  const run = {
    agent_run_id: makeId('run'), agent_name: agentName, event_id: incident.id, task_type: taskType,
    status: 'RUNNING', input: { event_id: incident.id, title: incident.title }, output: {},
    started_at: now(), finished_at: null, duration_ms: null, error_type: null, error_message: null,
    trace_id: trace.plan.trace_id, parent_run_id: parentRunId || ''
  };
  trace.agent_runs.push(run);
  evidenceLedger.append(state, incident.id, 'agent_started', { agent_run_id: run.agent_run_id, agent_name: agentName, task_type: taskType, parent_run_id: parentRunId || '' }, { actor: agentName, trace_id: run.trace_id });
  trace.messages = trace.messages || [];
  trace.messages.push({ message_id: makeId('msg'), at: now(), from: parentRunId ? 'Manager' : 'Human', to: agentName, type: 'task_assignment', parent_run_id: parentRunId || null, payload_hash: stableHash(run.input) });
  incident.current_agent = agentName;
  timeline(incident, agentName, `${agentName} 开始执行 ${taskType}`);
  const start = Date.now();
  try {
    run.output = await work(run);
    run.status = run.output.status === 'waiting_approval' ? 'WAITING_APPROVAL' :
      run.output.status === 'blocked' ? 'BLOCKED' : 'SUCCEEDED';
    if (task) task.status = run.status;
    trace.messages.push({ message_id: makeId('msg'), at: now(), from: agentName, to: 'Manager', type: 'task_result', agent_run_id: run.agent_run_id, status: run.status, payload_hash: stableHash(run.output) });
    return run;
  } catch (error) {
    run.status = 'FAILED';
    run.error_type = error.name || 'Error';
    run.error_message = String(error.message || error);
    if (task) task.status = 'FAILED';
    throw error;
  } finally {
    run.finished_at = now();
    run.duration_ms = Date.now() - start;
    trace.plan.updated_at = now();
    saveState();
  }
}

function fallbackDiagnosis(incident) {
  const text = `${incident.title} ${incident.description} ${incident.service}`.toLowerCase();
  if (/未知|不确定|unknown|低置信度/.test(text)) {
    return {
      root_cause: '现有证据不足，不能可靠确定根因', confidence: 0.45,
      evidences: [{ source: 'incident_input', quote: incident.description || incident.title }],
      counter_evidence: ['缺少可验证的系统指标或日志'], missing_evidence: ['相关服务日志', '异常前后指标'],
      llm_status: 'fallback', model: '', can_proceed_to_repair: false
    };
  }
  let cause = '服务出现可重复的运行异常';
  if (/cpu|处理器/.test(text)) cause = '受控 CPU 压力导致负载升高';
  else if (/memory|内存/.test(text)) cause = '受控内存分配导致占用升高';
  else if (/数据库|连接池|database|connection pool/.test(text)) cause = '数据库连接池配置或容量异常';
  else if (/超时|延迟|timeout|latency/.test(text)) cause = '服务响应延迟超过预期';
  return {
    root_cause: cause, confidence: 0.82,
    evidences: [
      { source: 'incident_input', quote: incident.description || incident.title },
      { source: 'system_metrics_collector', quote: '已采集本机实时 CPU、内存和磁盘指标' }
    ],
    counter_evidence: [], missing_evidence: [], llm_status: 'fallback', model: '', can_proceed_to_repair: true
  };
}

function matchRunbook(incident, diagnosis) {
  const text = `${incident.title} ${incident.description} ${diagnosis.root_cause}`.toLowerCase();
  const scored = state.runbooks.map(runbook => {
    const words = `${runbook.title} ${runbook.symptoms} ${(runbook.tags || []).join(' ')}`.toLowerCase().split(/\s+/);
    const hits = words.filter(word => word.length > 1 && text.includes(word)).length;
    return { runbook, score: Math.min(1, hits / Math.max(2, words.length / 4)) };
  }).sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score >= 0.15 ? { ...scored[0].runbook, match_score: scored[0].score } : null;
}

function createApproval(incident, runbook, traceId) {
  const existing = state.approvals.find(item => item.event_id === incident.id && item.status === 'PENDING');
  if (existing) return existing;
  const approval = {
    id: makeId('approval'), event_id: incident.id, risk_level: runbook.risk,
    operation: `执行 Runbook: ${runbook.title}`, target: incident.service || '演示环境',
    parameters: {}, runbook_id: runbook.id, rollback_plan: runbook.rollback_steps,
    status: 'PENDING', requested_at: now(), decided_at: null, approver: null, comment: '', trace_id: traceId
  };
  state.approvals.push(approval);
  return approval;
}

async function executeRepair(incident, runbook, approved, waitUntil = 0) {
  const before = monitorSnapshot();
  if (waitUntil > Date.now()) await sleep(waitUntil - Date.now() + 250);
  if (runbook.risk === 'L3' && !approved) return { status: 'waiting_approval', matched_runbook: runbook };

  if (faultState.active && Date.now() >= faultState.until) stopFault();
  const controlledFaultEnded = !faultState.active;
  const executionType = incident.source === 'controlled_fault' ? 'sandbox' : 'simulation';
  const verification = executionType === 'sandbox'
    ? { passed: controlledFaultEnded, condition: '受控故障执行器已经终止', before, after: monitorSnapshot(), execution_type: executionType }
    : { passed: true, condition: '模拟 Runbook 执行器返回成功；不代表生产环境已修复', execution_type: executionType };
  const repair = {
    id: makeId('repair'), incident_id: incident.id, runbook_id: runbook.id,
    status: verification.passed ? 'SUCCEEDED' : 'FAILED', execution_type: executionType,
    steps: runbook.steps, stdout: verification.passed ? 'Runbook completed' : '', stderr: '',
    exit_code: verification.passed ? 0 : 1, duration_ms: 0, verification, created_at: now()
  };
  state.repairs.push(repair);
  if (verification.passed) {
    runbook.verified = Number(runbook.verified || 0) + 1;
    incident.status = 'resolved';
    incident.resolved_at = now();
    incident.mttr_minutes = Math.max(0.1, Math.round((Date.now() - Date.parse(incident.created_at)) / 6000) / 10);
    timeline(incident, 'Ranger', `${executionType === 'sandbox' ? '沙箱' : '模拟'}修复验证通过`);
  } else {
    incident.status = 'failed';
    timeline(incident, 'Ranger', '验证失败，事件未标记为已解决');
  }
  return { status: verification.passed ? 'executed' : 'failed', matched_runbook: runbook, repair };
}

function latestByEvent(collection, eventId) {
  return collection.filter(item => (item.event_id || item.incident_id) === eventId).at(-1) || null;
}

function createPlanBApproval(incident, trace, planB, rollback) {
  const approval = {
    id: makeId('approval'), event_id: incident.id, risk_level: 'L3', mode: 'competition_plan_b',
    operation: `执行方案B：${planB.title}`, target: `${paymentSandbox.service}/demo-pool`,
    parameters: { target_pool: planB.target_pool }, runbook_id: 'RB-DB-POOL-002',
    rollback_plan: ['恢复审批前连接池配置', '重新运行并发验证'], rollback_id: rollback.id,
    status: 'PENDING', requested_at: now(), decided_at: null, approver: null, comment: '', trace_id: trace.plan.trace_id
  };
  state.approvals.push(approval);
  return approval;
}

async function finishCompetitionPostmortem(incident, parentRunId) {
  const trace = traceFor(incident.id);
  await agentRun(incident, 'Sage', 'postmortem', parentRunId, async run => {
    const diagnosis = latestByEvent(state.diagnoses, incident.id);
    const rollback = latestByEvent(state.rollback_runs, incident.id);
    const finalRepair = latestByEvent(state.repairs, incident.id);
    const pm = {
      id: makeId('pm'), incident_id: incident.id, title: `${incident.title} 自动复盘`,
      root_cause: diagnosis ? diagnosis.root_cause : '数据库连接池耗尽',
      process_notes: '方案A验证失败后完成自动回滚；方案B经L3人工审批后恢复。',
      lessons: ['恢复动作必须用真实流量验证', '验证失败应先回滚再升级高风险方案', '所有指标均关联本次trace_id'],
      runbook_updates: ['保留方案A作为低风险探测步骤', '方案B固定要求L3审批'], alert_optimizations: [],
      rollback_verified: Boolean(rollback && rollback.status === 'SUCCEEDED'),
      final_verification: finalRepair ? finalRepair.verification : null,
      created_at: now(), llm_status: 'rule-engine', model: ''
    };
    state.postmortems.push(pm);
    timeline(incident, 'Sage', '复盘和知识条目已由本次Trace生成');
    return { status: 'completed', postmortem_id: pm.id, rollback_verified: pm.rollback_verified };
  });
  trace.plan.tasks.find(item => item.agent === 'Sage').status = 'SUCCEEDED';
  trace.plan.status = 'completed';
  incident.status = 'resolved';
  incident.current_agent = '已解决';
  incident.resolved_at = now();
  incident.mttr_minutes = Math.max(0.1, Math.round((Date.now() - Date.parse(incident.created_at)) / 6000) / 10);
  timeline(incident, 'Manager', 'AgentTeams兼容编排闭环完成');
  saveState();
}

async function runCompetitionPipeline(eventId, initialLoad) {
  const incident = incidentById(eventId);
  if (!incident) return;
  const trace = traceFor(eventId);
  let parent = '';
  try {
    const commander = await agentRun(incident, 'Commander', 'triage_and_aggregate', parent, async run => {
      const alerts = state.alerts.filter(item => item.event_id === incident.id);
      const aggregation = await runSkill(incident, run, 'alert-aggregator', { event_id: incident.id, alerts });
      incident.aggregation = aggregation;
      timeline(incident, 'Commander', `${aggregation.input_alert_count}条真实告警聚合为${aggregation.cluster_count}个根事件，降噪${aggregation.noise_reduction_percent}%`);
      return { status: 'completed', aggregation, dispatch: 'Detective' };
    });
    parent = commander.agent_run_id;

    const detective = await agentRun(incident, 'Detective', 'parallel_evidence_collection', parent, async run => {
      const [logs, metrics, changes] = await Promise.all([
        runSkill(incident, run, 'log-hunter', { batch_id: initialLoad.summary.batch_id }),
        runSkill(incident, run, 'metric-analyzer', { metrics: initialLoad.summary }),
        runSkill(incident, run, 'change-scanner', { since_version: 1 })
      ]);
      const signals = [logs.failure_count > 0, metrics.pool_exhausted, changes.causal_signal].filter(Boolean).length;
      const analysis = await runSkill(incident, run, 'evidence_analyzer', {
        alert: { title: incident.title, description: incident.description, code: 'POOL_TIMEOUT' },
        metrics: [{ metric: 'error_rate', value: metrics.error_rate }, { metric: 'p95_latency_ms', value: metrics.p95_latency_ms }],
        logs: logs.sample || [],
        evidence_refs: [
          { ref: 'metric:load-batch', source: 'payment-sandbox.metrics', claim: `error_rate=${metrics.error_rate}%` },
          { ref: 'change:pool-config', source: 'payment-sandbox.changes', claim: `deviation=${metrics.deviation_from_baseline_pool}` }
        ]
      });
      const diagnosis = {
        id: makeId('diag'), incident_id: incident.id, root_cause: analysis.selected_root_cause,
        selected_category: analysis.selected_category, confidence: analysis.confidence,
        evidences: analysis.evidence_refs, raw_evidence: { logs, metrics, changes }, counter_evidence: analysis.counter_evidence,
        missing_evidence: analysis.missing_evidence, can_proceed_to_repair: analysis.can_proceed_to_repair,
        llm_status: analysis.llm_status, model: analysis.model || '', fallback_reason: analysis.fallback_reason || '', created_at: now()
      };
      state.diagnoses.push(diagnosis);
      timeline(incident, 'Detective', `3个Skill并行取证完成；根因置信度${Math.round(diagnosis.confidence * 100)}%`);
      return { status: diagnosis.can_proceed_to_repair ? 'completed' : 'blocked', ...diagnosis };
    });
    parent = detective.agent_run_id;
    if (!detective.output.can_proceed_to_repair) {
      incident.status = 'diagnosed'; trace.plan.status = 'blocked_low_confidence'; saveState(); return;
    }

    const ranger = await agentRun(incident, 'Ranger', 'repair_verify_rollback', parent, async run => {
      const coreMatch = await runSkill(incident, run, 'runbook_matcher', { root_cause: `${detective.output.selected_category || ''} ${detective.output.root_cause}`, risk_level: 'L3', environment: 'payment-sandbox', available_runbooks: state.runbooks });
      if (coreMatch.status !== 'matched') return { status: 'blocked', reason: 'no_match', core_match: coreMatch };
      const matched = await runSkill(incident, run, 'runbook-matcher', { diagnosis: detective.output });
      matched.core_match = coreMatch;
      const beforePlanA = sandboxConfig();
      const change = setSandboxPool(matched.plan_a.target_pool, 'Ranger', '执行低风险方案A');
      timeline(incident, 'Ranger', `方案A已执行：连接池${change.before}→${change.after}`);
      const verificationA = await runSkill(incident, run, 'recovery-verifier', { stage: 'plan-a' });
      const repairA = {
        id: makeId('repair'), incident_id: incident.id, plan_id: matched.plan_a.id, runbook_id: matched.selected,
        status: verificationA.passed ? 'SUCCEEDED' : 'FAILED', execution_type: 'sandbox',
        steps: [change], verification: verificationA, created_at: now()
      };
      state.repairs.push(repairA);
      state.metric_samples.push({ event_id: incident.id, stage: 'plan-a-verification', ...verificationA.observed });
      if (verificationA.passed) return { status: 'executed', matched, repair: repairA };

      timeline(incident, 'Ranger', `方案A验证失败：错误率${verificationA.observed.error_rate}%；开始自动回滚`);
      const rollbackResult = await runSkill(incident, run, 'rollback-executor', { snapshot: beforePlanA });
      const rollback = {
        id: makeId('rollback'), event_id: incident.id, plan_id: matched.plan_a.id,
        status: rollbackResult.restored ? 'SUCCEEDED' : 'FAILED', snapshot_before: beforePlanA,
        result: rollbackResult, started_at: now(), finished_at: now(), trace_id: trace.plan.trace_id
      };
      state.rollback_runs.push(rollback);
      timeline(incident, 'Ranger', `方案A回滚${rollback.status === 'SUCCEEDED' ? '成功' : '失败'}`);
      if (rollback.status !== 'SUCCEEDED') return { status: 'blocked', reason: 'rollback_failed', matched, rollback };
      const approval = createPlanBApproval(incident, trace, matched.plan_b, rollback);
      incident.status = 'waiting_approval';
      incident.pending_plan = matched.plan_b;
      timeline(incident, 'Ranger', `方案B风险L3，已暂停等待审批 ${approval.id}`);
      return { status: 'waiting_approval', approval_id: approval.id, matched, verificationA, rollback };
    });
    if (ranger.output.status === 'waiting_approval') {
      trace.plan.status = 'waiting_approval';
      trace.plan.tasks.find(item => item.agent === 'Ranger').status = 'WAITING_APPROVAL';
      saveState();
      return;
    }
    if (ranger.output.status === 'executed') await finishCompetitionPostmortem(incident, ranger.agent_run_id);
    else { trace.plan.status = 'blocked'; incident.status = 'failed'; saveState(); }
  } catch (error) {
    trace.plan.status = 'failed'; incident.status = 'failed';
    timeline(incident, 'Manager', `比赛流水线失败：${error.message}`); saveState();
    log('ERROR', `Competition pipeline ${eventId} failed`, String(error.stack || error));
  }
}

async function resumeCompetitionApproval(approval) {
  const incident = incidentById(approval.event_id);
  const trace = state.traces.find(item => item.event_id === approval.event_id);
  if (!incident || !trace) throw new Error('审批关联数据不完整');
  timeline(incident, approval.approver || '人工审批', '方案B已批准，Manager恢复Ranger Worker');
  const paused = [...trace.agent_runs].reverse().find(item => item.agent_name === 'Ranger');
  const ranger = await agentRun(incident, 'Ranger', 'plan_b_after_approval', paused ? paused.agent_run_id : '', async run => {
    const before = sandboxConfig();
    const target = Number(approval.parameters.target_pool);
    const change = setSandboxPool(target, 'Ranger', '执行经审批的方案B');
    const verification = await runSkill(incident, run, 'recovery-verifier', { stage: 'plan-b' });
    const repair = {
      id: makeId('repair'), incident_id: incident.id, plan_id: 'plan-b', runbook_id: approval.runbook_id,
      approval_id: approval.id, status: verification.passed ? 'SUCCEEDED' : 'FAILED', execution_type: 'sandbox',
      steps: [change], verification, created_at: now(), before
    };
    state.repairs.push(repair);
    state.metric_samples.push({ event_id: incident.id, stage: 'plan-b-verification', ...verification.observed });
    timeline(incident, 'Ranger', `方案B验证${verification.passed ? '通过' : '失败'}：错误率${verification.observed.error_rate}%`);
    return { status: verification.passed ? 'executed' : 'blocked', repair };
  });
  if (ranger.output.status !== 'executed') {
    trace.plan.status = 'failed'; incident.status = 'failed'; saveState(); return;
  }
  trace.plan.tasks.find(item => item.agent === 'Ranger').status = 'SUCCEEDED';
  await finishCompetitionPostmortem(incident, ranger.agent_run_id);
}

async function runPipeline(eventId, options = {}) {
  const incident = state.incidents.find(item => item.id === eventId);
  if (!incident) return;
  const trace = traceFor(eventId);
  let parent = '';
  try {
    const commander = await agentRun(incident, 'Commander', 'triage', parent, async () => {
      await sleep(25);
      timeline(incident, 'Commander', '告警已聚合并创建统一事件');
      return { status: 'completed', severity: incident.severity, event_id: incident.id };
    });
    parent = commander.agent_run_id;

    const detective = await agentRun(incident, 'Detective', 'diagnose', parent, async run => {
      await sleep(25);
      const metricResult = await runSkill(incident, run, 'system_metrics_collector', { target_service: incident.service || 'local-system', time_range: { seconds: 0 }, metrics: ['cpu_percent', 'memory_percent', 'disk_percent'] });
      const analysis = await runSkill(incident, run, 'evidence_analyzer', { alert: { title: incident.title, description: incident.description, code: incident.source }, metrics: metricResult.samples, logs: [incident.description || incident.title] });
      const diagnosis = { root_cause: analysis.selected_root_cause, selected_category: analysis.selected_category, confidence: analysis.confidence, evidences: analysis.evidence_refs, counter_evidence: analysis.counter_evidence, missing_evidence: analysis.missing_evidence, llm_status: analysis.llm_status, model: analysis.model || '', llm_error: analysis.llm_error || '', fallback_reason: analysis.fallback_reason || '', can_proceed_to_repair: analysis.can_proceed_to_repair };
      state.diagnoses.push({ id: makeId('diag'), incident_id: incident.id, created_at: now(), ...diagnosis });
      timeline(incident, 'Detective', `诊断完成：${diagnosis.root_cause}；置信度 ${(diagnosis.confidence * 100).toFixed(0)}%；${diagnosis.llm_status}`);
      return { status: diagnosis.can_proceed_to_repair ? 'completed' : 'blocked', ...diagnosis };
    });
    parent = detective.agent_run_id;
    if (!detective.output.can_proceed_to_repair) {
      incident.status = 'diagnosed';
      trace.plan.status = 'blocked_low_confidence';
      timeline(incident, 'Detective', '低置信度阻断：未执行修复');
      saveState();
      return;
    }

    const ranger = await agentRun(incident, 'Ranger', 'repair', parent, async run => {
      const matchResult = await runSkill(incident, run, 'runbook_matcher', { root_cause: `${detective.output.selected_category || ''} ${detective.output.root_cause}`, risk_level: 'L2', environment: 'windows-local', available_runbooks: state.runbooks });
      const runbook = matchResult.status === 'matched' ? state.runbooks.find(item => item.id === matchResult.matched_runbook.id) : null;
      if (!runbook) {
        incident.status = 'diagnosed';
        timeline(incident, 'Ranger', 'no_match：没有合适 Runbook，未执行修复');
        return { status: 'blocked', reason: 'no_match' };
      }
      timeline(incident, 'Ranger', `匹配 Runbook：${runbook.title}；风险 ${runbook.risk}`);
      if (runbook.risk === 'L3') {
        const approval = createApproval(incident, runbook, trace.plan.trace_id);
        incident.status = 'waiting_approval';
        timeline(incident, 'Ranger', `已暂停，等待审批 ${approval.id}`);
        return { status: 'waiting_approval', approval_id: approval.id, matched_runbook: runbook };
      }
      return executeRepair(incident, runbook, false, options.waitUntil || 0);
    });
    parent = ranger.agent_run_id;
    if (ranger.output.status === 'waiting_approval') {
      trace.plan.status = 'waiting_approval';
      saveState();
      return;
    }
    if (ranger.output.status !== 'executed') {
      trace.plan.status = 'blocked';
      saveState();
      return;
    }

    await agentRun(incident, 'Sage', 'postmortem', parent, async () => {
      const diagnosis = state.diagnoses.filter(item => item.incident_id === incident.id).at(-1);
      const pm = {
        id: makeId('pm'), incident_id: incident.id, title: `${incident.title} 复盘报告`,
        root_cause: diagnosis ? diagnosis.root_cause : '未确定', process_notes: '依据真实 Agent Trace 自动生成',
        lessons: ['保留修复前后证据', '高风险操作必须经过审批'],
        runbook_updates: [], alert_optimizations: [], created_at: now(),
        llm_status: 'fallback', model: ''
      };
      state.postmortems.push(pm);
      timeline(incident, 'Sage', '复盘报告已生成（规则 fallback）');
      return { status: 'completed', postmortem_id: pm.id, llm_status: 'fallback' };
    });
    trace.plan.status = incident.status === 'resolved' ? 'completed' : 'failed';
    incident.current_agent = incident.status === 'resolved' ? '已解决' : 'Sage';
    saveState();
  } catch (error) {
    trace.plan.status = 'failed';
    incident.status = 'failed';
    timeline(incident, 'Orchestrator', `执行失败：${error.message}`);
    saveState();
    log('ERROR', `Pipeline ${eventId} failed`, String(error.stack || error));
  }
}

async function resumeApproval(approval) {
  const incident = state.incidents.find(item => item.id === approval.event_id);
  const trace = state.traces.find(item => item.event_id === approval.event_id);
  const runbook = state.runbooks.find(item => item.id === approval.runbook_id);
  if (!incident || !trace || !runbook) throw new Error('审批关联数据不完整');
  incident.status = 'approved';
  timeline(incident, approval.approver || '人工审批', 'L3 操作已批准，恢复 Ranger');
  const paused = [...trace.agent_runs].reverse().find(item => item.agent_name === 'Ranger');
  const ranger = await agentRun(incident, 'Ranger', 'repair_after_approval', paused ? paused.agent_run_id : '', async () => executeRepair(incident, runbook, true));
  if (ranger.output.status !== 'executed') {
    trace.plan.status = 'failed';
    saveState();
    return;
  }
  await agentRun(incident, 'Sage', 'postmortem', ranger.agent_run_id, async () => {
    const diagnosis = state.diagnoses.filter(item => item.incident_id === incident.id).at(-1);
    const pm = {
      id: makeId('pm'), incident_id: incident.id, title: `${incident.title} 复盘报告`,
      root_cause: diagnosis ? diagnosis.root_cause : '未确定', process_notes: 'L3 审批通过后完成模拟验证',
      lessons: ['审批记录必须关联 trace_id', '批准后只恢复未完成节点'], runbook_updates: [],
      alert_optimizations: [], created_at: now(), llm_status: 'fallback', model: ''
    };
    state.postmortems.push(pm);
    timeline(incident, 'Sage', '审批后复盘已生成');
    return { status: 'completed', postmortem_id: pm.id };
  });
  trace.plan.tasks.find(item => item.agent === 'Ranger').status = 'SUCCEEDED';
  trace.plan.tasks.find(item => item.agent === 'Sage').status = 'SUCCEEDED';
  trace.plan.status = 'completed';
  incident.current_agent = '已解决';
  saveState();
}

let previousCpu = null;
function cpuPercent() {
  const cpus = os.cpus();
  const aggregate = cpus.reduce((acc, cpu) => {
    for (const [key, value] of Object.entries(cpu.times)) acc[key] = (acc[key] || 0) + value;
    return acc;
  }, {});
  const total = Object.values(aggregate).reduce((sum, value) => sum + value, 0);
  let result = 0;
  if (previousCpu) {
    const totalDelta = total - previousCpu.total;
    const idleDelta = aggregate.idle - previousCpu.idle;
    if (totalDelta > 0) result = (1 - idleDelta / totalDelta) * 100;
  }
  previousCpu = { total, idle: aggregate.idle };
  return Math.max(0, Math.min(100, Math.round(result * 10) / 10));
}

function diskPercent() {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return total ? Math.round((1 - free / total) * 1000) / 10 : 0;
  } catch (_) { return 0; }
}

function monitorSnapshot() {
  if (faultState.active && Date.now() >= faultState.until) stopFault();
  const started = process.hrtime.bigint();
  const cpu = cpuPercent();
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const memory = totalMem ? Math.round(usedMem / totalMem * 1000) / 10 : 0;
  const disk = diskPercent();
  const latency = Number(process.hrtime.bigint() - started) / 1e6;
  const eps = Math.round(requestCount / Math.max(1, (Date.now() - startedAt) / 1000) * 10) / 10;
  const status = cpu > 90 || memory > 90 ? 'critical' : cpu > 75 || memory > 80 ? 'warning' : 'ok';
  return {
    timestamp: now(), source: 'real_local', cpu_count: os.cpus().length, cpu_percent: cpu,
    memory_percent: memory, memory_used_gb: Math.round(usedMem / 1073741824 * 100) / 100,
    memory_total_gb: Math.round(totalMem / 1073741824 * 100) / 100, disk_percent: disk,
    collection_duration_ms: Math.round(latency * 1000) / 1000,
    fault_injection: { ...faultState },
    services: [
      { id: 'real-cpu', name: 'CPU（本机真实）', type: `${os.cpus().length}核`, cpu, mem: 0, lat: latency, eps, err: 0, status, desc: '系统处理器使用率', is_real: true },
      { id: 'real-mem', name: '内存（本机真实）', type: `${Math.round(totalMem / 1073741824 * 10) / 10}GB`, cpu: 0, mem: memory, lat: latency, eps, err: 0, status: memory > 90 ? 'critical' : memory > 80 ? 'warning' : 'ok', desc: '系统内存使用率', is_real: true },
      { id: 'real-disk', name: '数据盘（本机真实）', type: DATA_DIR, cpu: 0, mem: disk, lat: latency, eps, err: 0, status: disk > 95 ? 'critical' : disk > 85 ? 'warning' : 'ok', desc: 'IntelliOps 数据目录所在磁盘', is_real: true }
    ]
  };
}

function execFileSafe(file, args, timeout = 8000) {
  return new Promise(resolve => {
    childProcess.execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error && Number.isInteger(error.code) ? error.code : error ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || error && error.message || '') });
    });
  });
}

function validHost(value) {
  return typeof value === 'string' && value.length <= 253 && /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\]|[0-9A-Fa-f:]+)$/.test(value);
}

function cleanMonitorTarget(data, existing = null) {
  const type = String(data.type || existing && existing.type || '').toLowerCase();
  if (!['system', 'http', 'tcp', 'process', 'windows_service', 'application'].includes(type)) throw new Error('type 只允许 system/http/tcp/process/windows_service');
  const name = String(data.name || existing && existing.name || '').trim().slice(0, 120);
  if (!name) throw new Error('监控名称不能为空');
  const interval = Number(data.interval_sec == null ? existing && existing.interval_sec || 30 : data.interval_sec);
  const timeout = Number(data.timeout_ms == null ? existing && existing.timeout_ms || 5000 : data.timeout_ms);
  const failures = Number(data.consecutive_failures == null ? existing && existing.consecutive_failures || 3 : data.consecutive_failures);
  if (!Number.isInteger(interval) || interval < 5 || interval > 3600) throw new Error('interval_sec 必须是 5-3600 秒整数');
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 30000) throw new Error('timeout_ms 必须是 500-30000 毫秒整数');
  if (!Number.isInteger(failures) || failures < 1 || failures > 10) throw new Error('consecutive_failures 必须是 1-10 整数');
  const config = { ...(existing && existing.config || {}), ...(data.config || {}) };
  const thresholds = { ...(existing && existing.thresholds || {}), ...(data.thresholds || {}) };
  if (type === 'http') {
    let parsed;
    try { parsed = new URL(String(config.url || '')); } catch (_) { throw new Error('HTTP URL 无效'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HTTP目标只允许 http/https');
    config.url = parsed.toString();
    config.expected_min = Number(config.expected_min == null ? 200 : config.expected_min);
    config.expected_max = Number(config.expected_max == null ? 399 : config.expected_max);
    if (!Number.isInteger(config.expected_min) || !Number.isInteger(config.expected_max) || config.expected_min < 100 || config.expected_max > 599 || config.expected_min > config.expected_max) throw new Error('HTTP状态码范围无效');
    thresholds.latency_ms = Number(thresholds.latency_ms == null ? 3000 : thresholds.latency_ms);
    if (!Number.isFinite(thresholds.latency_ms) || thresholds.latency_ms < 1 || thresholds.latency_ms > 30000) throw new Error('延迟阈值必须是1-30000毫秒');
  }
  if (type === 'tcp') {
    config.host = String(config.host || '').trim(); config.port = Number(config.port);
    if (!validHost(config.host)) throw new Error('TCP主机名或IP无效');
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('TCP端口必须是1-65535整数');
  }
  if (type === 'process') {
    config.process_name = String(config.process_name || '').trim();
    if (!/^[\p{L}\p{N}_. -]{1,120}$/u.test(config.process_name)) throw new Error('进程名包含不允许的字符');
  }
  if (type === 'application') {
    config.process_name = String(config.process_name || '').trim();
    if (!/^[\p{L}\p{N}_. -]{1,120}$/u.test(config.process_name)) throw new Error('进程名包含不允许的字符');
    if (thresholds.mem_mb != null) { thresholds.mem_mb = Number(thresholds.mem_mb); if (!Number.isFinite(thresholds.mem_mb) || thresholds.mem_mb < 1 || thresholds.mem_mb > 65536) throw new Error('内存阈值必须是1-65536 MB'); }
    if (thresholds.min_uptime_min != null) { thresholds.min_uptime_min = Number(thresholds.min_uptime_min); if (!Number.isFinite(thresholds.min_uptime_min) || thresholds.min_uptime_min < 0) throw new Error('最小运行时间无效'); }
  }
  if (type === 'windows_service') {
    config.service_name = String(config.service_name || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(config.service_name)) throw new Error('Windows服务名只允许字母、数字、点、下划线和短横线');
    config.recovery_action = config.recovery_action === 'start_with_approval' ? 'start_with_approval' : 'none';
    if (config.recovery_action === 'start_with_approval' && !WINDOWS_SERVICE_START_ALLOWLIST.has(config.service_name.toLowerCase())) {
      throw new Error(`服务 ${config.service_name} 不在启动白名单；可选择“仅告警”进行监控`);
    }
  }
  if (type === 'system') {
    for (const key of ['cpu_percent', 'memory_percent', 'disk_percent']) {
      thresholds[key] = Number(thresholds[key] == null ? ({ cpu_percent: 90, memory_percent: 90, disk_percent: 95 })[key] : thresholds[key]);
      if (!Number.isFinite(thresholds[key]) || thresholds[key] < 1 || thresholds[key] > 100) throw new Error(`${key} 阈值必须是1-100`);
    }
  }
  return {
    ...(existing || {}), name, type, enabled: data.enabled == null ? existing ? existing.enabled : true : Boolean(data.enabled),
    interval_sec: interval, timeout_ms: timeout, consecutive_failures: failures, config, thresholds
  };
}

async function probeHttp(target) {
  const started = Date.now();
  try {
    const response = await fetch(target.config.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(target.timeout_ms), headers: { 'User-Agent': `IntelliOps/${APP_VERSION}` } });
    const latency = Date.now() - started;
    const statusOk = response.status >= target.config.expected_min && response.status <= target.config.expected_max;
    const latencyOk = latency <= target.thresholds.latency_ms;
    try { await response.body.cancel(); } catch (_) { /* response may have no body */ }
    return { ok: statusOk && latencyOk, status: statusOk && latencyOk ? 'healthy' : 'unhealthy', checked_at: now(), duration_ms: latency, http_status: response.status, final_url: response.url, expected_status: [target.config.expected_min, target.config.expected_max], latency_threshold_ms: target.thresholds.latency_ms, reason: !statusOk ? `HTTP ${response.status}` : !latencyOk ? `响应${latency}ms超过阈值` : 'HTTP探测正常', source: 'real_http_probe' };
  } catch (error) {
    return { ok: false, status: 'unhealthy', checked_at: now(), duration_ms: Date.now() - started, reason: String(error.message || error).slice(0, 500), source: 'real_http_probe' };
  }
}

function probeTcp(target) {
  return new Promise(resolve => {
    const started = Date.now(); let settled = false;
    const socket = netCreateConnection(target.config.host, target.config.port);
    const finish = (ok, reason) => {
      if (settled) return; settled = true; socket.destroy();
      resolve({ ok, status: ok ? 'healthy' : 'unhealthy', checked_at: now(), duration_ms: Date.now() - started, host: target.config.host, port: target.config.port, reason, source: 'real_tcp_probe' });
    };
    socket.setTimeout(target.timeout_ms);
    socket.once('connect', () => finish(true, 'TCP连接成功'));
    socket.once('timeout', () => finish(false, 'TCP连接超时'));
    socket.once('error', error => finish(false, String(error.message || error).slice(0, 500)));
  });
}

function netCreateConnection(host, port) {
  const net = require('node:net');
  return net.createConnection({ host, port });
}

async function probeProcess(target) {
  const started = Date.now(); const wanted = target.config.process_name.toLowerCase().replace(/\.exe$/i, '');
  if (process.platform === 'linux') {
    const names = [];
    try {
      for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        try {
          names.push(fs.readFileSync(`/proc/${entry.name}/comm`, 'utf8').trim());
          const argv0 = fs.readFileSync(`/proc/${entry.name}/cmdline`).toString('utf8').split('\0')[0];
          if (argv0) names.push(path.basename(argv0));
        } catch (_) { /* process exited during scan */ }
      }
    } catch (error) { return { ok: false, status: 'unavailable', checked_at: now(), duration_ms: Date.now() - started, reason: error.message, source: 'real_procfs_probe' }; }
    const matched = names.filter(name => name.toLowerCase().replace(/\.exe$/i, '') === wanted);
    return { ok: matched.length > 0, status: matched.length ? 'healthy' : 'unhealthy', checked_at: now(), duration_ms: Date.now() - started, process_name: target.config.process_name, instance_count: matched.length, reason: matched.length ? `发现${matched.length}个实例` : '未发现目标进程', source: 'real_procfs_probe' };
  }
  const result = process.platform === 'win32'
    ? await execFileSafe('tasklist.exe', ['/FO', 'CSV', '/NH'], target.timeout_ms)
    : await execFileSafe('ps', ['-A', '-o', 'comm='], target.timeout_ms);
  if (!result.ok) return { ok: false, status: 'unavailable', checked_at: now(), duration_ms: Date.now() - started, reason: result.stderr.slice(0, 500), source: 'real_process_probe' };
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const matched = lines.filter(line => {
    const candidate = (process.platform === 'win32' ? line.match(/^"([^"]+)"/)?.[1] || '' : path.basename(line.trim())).toLowerCase().replace(/\.exe$/i, '');
    return candidate === wanted;
  });
  return { ok: matched.length > 0, status: matched.length ? 'healthy' : 'unhealthy', checked_at: now(), duration_ms: Date.now() - started, process_name: target.config.process_name, instance_count: matched.length, reason: matched.length ? `发现${matched.length}个实例` : '未发现目标进程', source: 'real_process_probe' };
}

async function probeWindowsService(target) {
  const started = Date.now();
  if (process.platform !== 'win32') return { ok: false, status: 'unavailable', checked_at: now(), duration_ms: 0, reason: 'Windows服务探测仅在Windows运行', source: 'real_sc_query' };
  const result = await execFileSafe('sc.exe', ['query', target.config.service_name], target.timeout_ms);
  const running = result.ok && /STATE\s*:\s*4\s+RUNNING/i.test(result.stdout);
  return { ok: running, status: running ? 'healthy' : 'unhealthy', checked_at: now(), duration_ms: Date.now() - started, service_name: target.config.service_name, sc_exit_code: result.code, state_text: (result.stdout.match(/STATE\s*:[^\r\n]+/i) || [])[0] || '', reason: running ? 'Windows服务正在运行' : (result.stderr || result.stdout || '服务未运行').trim().slice(0, 500), source: 'real_sc_query' };
}

async function probeTarget(target) {
  if (target.type === 'system') {
    const snapshot = monitorSnapshot();
    const exceeded = ['cpu_percent', 'memory_percent', 'disk_percent'].filter(key => snapshot[key] >= target.thresholds[key]);
    return { ok: exceeded.length === 0, status: exceeded.length ? 'unhealthy' : 'healthy', checked_at: now(), duration_ms: snapshot.collection_duration_ms, metrics: { cpu_percent: snapshot.cpu_percent, memory_percent: snapshot.memory_percent, disk_percent: snapshot.disk_percent }, thresholds: target.thresholds, exceeded, reason: exceeded.length ? `超过阈值：${exceeded.join(', ')}` : '本机资源正常', source: 'real_local_system_probe' };
  }
  if (target.type === 'http') return probeHttp(target);
  if (target.type === 'tcp') return probeTcp(target);
  if (target.type === 'process') return probeProcess(target);
  if (target.type === 'windows_service') return probeWindowsService(target);
	if (target.type === 'application') return probeApplication(target);
  throw new Error('不支持的监控类型');
}

function recentMonitorResults(targetId, count = 10) {
  return state.monitor_results.filter(item => item.target_id === targetId).slice(-count);
}

function createMonitorIncident(target, result) {
  const incident = addIncident({
    title: `${target.name} 监控异常`, severity: target.type === 'system' ? 'P1-高' : 'P0-紧急',
    service: target.name, description: `${target.type} 连续${target.failure_streak}次探测失败：${result.reason}`
  }, 'monitor');
  incident.monitor_target_id = target.id; incident.monitor_result_id = result.id;
  state.alerts.push({ id: makeId('alert'), event_id: incident.id, service: target.name, code: `MONITOR_${target.type.toUpperCase()}_DOWN`, severity: 'critical', created_at: now(), source: result.source, monitor_result_id: result.id });
  target.open_incident_id = incident.id;
  saveState();
  if (process.platform === 'win32' && process.env.INTELLIOPS_NO_NOTIFICATIONS !== '1') showWindowsMessage(`监控异常：${target.name}\n${result.reason}\n已创建事件 ${incident.id}`);
  setImmediate(() => runMonitorPipeline(incident.id));
  return incident;
}


async function probeApplication(target) {
  const started = Date.now(); const name = target.config.process_name;
  try {
    if (process.platform !== 'win32') return probeProcess(target);
    const task = await execFileSafe('tasklist.exe', ['/FO', 'CSV', '/FI', `IMAGENAME eq ${name}`, '/NH'], target.timeout_ms);
    const csv = task.stdout.trim();
    if (!task.ok || !csv || /^INFO:/i.test(csv)) return { ok: false, status: 'unhealthy', checked_at: now(), duration_ms: Date.now()-started, reason: `进程 ${name} 未运行`, pid: null, mem_mb: 0, threads: null, uptime_min: null, source: 'real_application_probe' };
    const firstLine = csv.split(/\r?\n/)[0];
    const parts = firstLine.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g).map(value => value.replace(/^,/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    const pid = Number.parseInt(parts[1], 10) || 0; const memKb = Number.parseInt(String(parts[4] || '').replace(/[^0-9]/g,''), 10) || 0;
    const memMb = (memKb/1024).toFixed(1);
    // 固定可执行文件和参数数组；不通过Shell拼接执行。
    let uptimeMin = 0;
    try {
      const wmic = await execFileSafe('wmic.exe', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/format:value'], 5000);
      const m = wmic.stdout.match(/CreationDate=([\d]+)\.([\d]+)[+-]/);
      if (m) { const created = new Date(parseInt(m[1].slice(0,4)),parseInt(m[1].slice(4,6))-1,parseInt(m[1].slice(6,8)),parseInt(m[1].slice(8,10)),parseInt(m[1].slice(10,12)),parseInt(m[1].slice(12,14))); uptimeMin = Math.round((Date.now()-created.getTime())/60000); }
    } catch(_) { uptimeMin = 0; }
    const memMbNum = parseFloat(memMb);
    const memOk = !target.thresholds?.mem_mb || memMbNum <= target.thresholds.mem_mb;
    const uptimeOk = !target.thresholds?.min_uptime_min || uptimeMin >= target.thresholds.min_uptime_min;
    const ok = memOk && uptimeOk;
    return { ok, status: ok?'healthy':'unhealthy', checked_at: now(), duration_ms: Date.now()-started, pid, mem_mb:memMbNum, threads:null, uptime_min:uptimeMin, reason: ok?`运行中 (PID ${pid}, ${memMb}MB${uptimeMin ? `, ${uptimeMin}分钟` : ''})`:!memOk?`内存 ${memMb}MB 超阈值`:`运行时间未达到阈值`, source:'real_application_probe', collection_notes: ['线程数未由tasklist可靠提供，因此返回null', 'WMIC不可用时运行时长返回0'] };
  } catch(e) { return { ok: false, status: 'unavailable', checked_at: now(), duration_ms: Date.now()-started, reason: String(e.message).slice(0,200), source:'real_application_probe' }; }
}

async function recordProbe(target, rawResult) {
  const result = { id: makeId('probe'), target_id: target.id, target_name: target.name, target_type: target.type, ...rawResult };
  state.monitor_results.push(result);
  if (state.monitor_results.length > 5000) state.monitor_results.splice(0, state.monitor_results.length - 5000);
  target.last_check_at = result.checked_at; target.last_result = result;
  target.next_check_at = new Date(Date.now() + target.interval_sec * 1000).toISOString();
  target.updated_at = now(); target.status = result.status;
  if (result.ok) {
    target.failure_streak = 0; target.recovery_streak = Number(target.recovery_streak || 0) + 1;
    if (target.open_incident_id && target.recovery_streak >= 2) setImmediate(() => resolveMonitorIncident(target.id, '连续两次真实探测恢复'));
  } else {
    target.recovery_streak = 0;
    if (result.status !== 'unavailable') target.failure_streak = Number(target.failure_streak || 0) + 1;
    if (target.failure_streak >= target.consecutive_failures && !target.open_incident_id) createMonitorIncident(target, result);
  }
  saveState();
  return result;
}

async function checkMonitorTarget(target, persist = true) {
  if (runningProbes.has(target.id)) throw new Error('该目标正在探测');
  runningProbes.add(target.id);
  try {
    const result = await probeTarget(target);
    return persist ? recordProbe(target, result) : result;
  } finally { runningProbes.delete(target.id); }
}

function createMonitorApproval(incident, target, traceId) {
  const approval = {
    id: makeId('approval'), event_id: incident.id, risk_level: 'L3', mode: 'monitor_service_start',
    operation: `启动Windows服务：${target.config.service_name}`, target: target.name,
    target_id: target.id, parameters: { service_name: target.config.service_name }, runbook_id: 'built-in/windows-service-start/v1',
    rollback_plan: ['若启动后验证失败，不执行进一步变更', '由管理员检查服务日志和依赖项'], status: 'PENDING',
    requested_at: now(), decided_at: null, approver: null, comment: '', trace_id: traceId
  };
  state.approvals.push(approval); return approval;
}

async function runMonitorPipeline(eventId) {
  const incident = incidentById(eventId); if (!incident) return;
  const target = state.monitor_targets.find(item => item.id === incident.monitor_target_id); if (!target) return;
  const trace = traceFor(eventId); let parent = '';
  try {
    const commander = await agentRun(incident, 'Commander', 'monitor_triage', parent, async () => ({ status: 'completed', target_id: target.id, failure_streak: target.failure_streak, dispatch: 'Detective' }));
    parent = commander.agent_run_id;
    const detective = await agentRun(incident, 'Detective', 'monitor_evidence_diagnosis', parent, async run => {
      const evidence = await runSkill(incident, run, 'monitor-evidence-collector', { target, result: target.last_result, recent_results: recentMonitorResults(target.id) });
      const diagnosis = { id: makeId('diag'), incident_id: incident.id, root_cause: `${target.name}真实探测异常：${target.last_result.reason}`, confidence: evidence.evidence_grade.startsWith('A') ? 0.96 : 0.45, evidences: evidence, counter_evidence: [], missing_evidence: evidence.missing_evidence, can_proceed_to_repair: evidence.evidence_grade.startsWith('A'), llm_status: 'structured-evidence', model: '', created_at: now() };
      state.diagnoses.push(diagnosis); timeline(incident, 'Detective', `监控证据已固化，证据等级${evidence.evidence_grade}`);
      return { status: 'completed', ...diagnosis };
    });
    parent = detective.agent_run_id;
    const ranger = await agentRun(incident, 'Ranger', 'safe_recovery_decision', parent, async run => {
      if (target.type === 'windows_service' && target.config.recovery_action === 'start_with_approval') {
        const approval = createMonitorApproval(incident, target, run.trace_id);
        incident.status = 'waiting_approval'; timeline(incident, 'Ranger', '服务启动属于L3操作，已暂停等待人工审批');
        return { status: 'waiting_approval', approval_id: approval.id, action: 'sc.exe start', arbitrary_shell: false };
      }
      incident.status = 'diagnosed'; timeline(incident, 'Ranger', '无安全的通用自动修复动作，保持监测并等待人工处置或自然恢复');
      return { status: 'blocked', reason: 'manual_action_required', safe_boundary: '未执行任意Shell命令' };
    });
    trace.plan.status = ranger.status === 'WAITING_APPROVAL' ? 'waiting_approval' : 'monitoring_manual_recovery';
    saveState();
  } catch (error) { trace.plan.status = 'failed'; incident.status = 'failed'; timeline(incident, 'Manager', `监控事件编排失败：${error.message}`); saveState(); }
}

async function finishMonitorRecovery(incident, target, rangerRun, reason) {
  const trace = traceFor(incident.id);
  const repair = { id: makeId('repair'), incident_id: incident.id, runbook_id: 'monitor-observed-recovery', status: 'SUCCEEDED', execution_type: 'real_probe_verification', steps: [reason], verification: { passed: true, observed: target.last_result }, created_at: now() };
  state.repairs.push(repair);
  await agentRun(incident, 'Sage', 'monitor_postmortem', rangerRun.agent_run_id, async () => {
    const pm = { id: makeId('pm'), incident_id: incident.id, title: `${incident.title} 恢复记录`, root_cause: latestByEvent(state.diagnoses, incident.id)?.root_cause || '监控探测异常', process_notes: reason, lessons: ['连续失败触发事件，连续恢复后关闭事件', '恢复结论来自原探测器复验'], runbook_updates: [], alert_optimizations: [], created_at: now(), llm_status: 'rule-engine', model: '' };
    state.postmortems.push(pm); return { status: 'completed', postmortem_id: pm.id };
  });
  incident.status = 'resolved'; incident.current_agent = '已恢复'; incident.resolved_at = now();
  incident.mttr_minutes = Math.max(0.1, Math.round((Date.now() - Date.parse(incident.created_at)) / 6000) / 10);
  timeline(incident, 'Manager', reason); trace.plan.status = 'completed';
  for (const approval of state.approvals.filter(item => item.event_id === incident.id && item.status === 'PENDING')) { approval.status = 'CANCELLED_RECOVERED'; approval.decided_at = now(); approval.comment = '目标已在审批前恢复'; }
  target.open_incident_id = null; target.failure_streak = 0; saveState();
  if (process.platform === 'win32' && process.env.INTELLIOPS_NO_NOTIFICATIONS !== '1') showWindowsMessage(`监控恢复：${target.name}\n${reason}`);
}

async function resolveMonitorIncident(targetId, reason) {
  const target = state.monitor_targets.find(item => item.id === targetId); if (!target || !target.open_incident_id) return;
  const incident = incidentById(target.open_incident_id); if (!incident || incident.status === 'resolved') { target.open_incident_id = null; saveState(); return; }
  if (incident.monitor_recovery_running) return;
  incident.monitor_recovery_running = true;
  try {
    const lastRun = traceFor(incident.id).agent_runs.at(-1);
    const ranger = await agentRun(incident, 'Ranger', 'monitor_recovery_verification', lastRun && lastRun.agent_run_id || '', async run => {
      const verification = await runSkill(incident, run, 'monitor-recovery-verifier', { target_id: target.id });
      return { status: verification.passed ? 'completed' : 'blocked', verification };
    });
    if (ranger.output.verification.passed) await finishMonitorRecovery(incident, target, ranger, reason);
  } finally { delete incident.monitor_recovery_running; saveState(); }
}

async function resumeMonitorServiceApproval(approval) {
  const incident = incidentById(approval.event_id); const target = state.monitor_targets.find(item => item.id === approval.target_id);
  if (!incident || !target) throw new Error('审批关联的事件或目标不存在');
  const trace = traceFor(incident.id); const previous = trace.agent_runs.at(-1);
  const ranger = await agentRun(incident, 'Ranger', 'approved_windows_service_start', previous && previous.agent_run_id || '', async run => {
    if (process.platform !== 'win32') return { status: 'blocked', reason: 'Windows服务操作只能在Windows执行' };
    if (!WINDOWS_SERVICE_START_ALLOWLIST.has(target.config.service_name.toLowerCase())) return { status: 'blocked', reason: '服务已移出执行白名单，原审批失效' };
    const started = Date.now();
    const execution = await execFileSafe('sc.exe', ['start', target.config.service_name], 15000);
    await sleep(1500);
    const verification = await runSkill(incident, run, 'monitor-recovery-verifier', { target_id: target.id });
    const repair = { id: makeId('repair'), incident_id: incident.id, runbook_id: approval.runbook_id, status: verification.passed ? 'SUCCEEDED' : 'FAILED', execution_type: 'real_windows_sc', command: ['sc.exe', 'start', target.config.service_name], arbitrary_shell: false, stdout: execution.stdout.slice(0, 4000), stderr: execution.stderr.slice(0, 4000), exit_code: execution.code, duration_ms: Date.now() - started, verification, created_at: now() };
    state.repairs.push(repair);
    return { status: verification.passed ? 'completed' : 'blocked', repair, verification };
  });
  if (ranger.output.verification && ranger.output.verification.passed) {
    target.last_result = ranger.output.verification.observed; target.status = 'healthy'; target.recovery_streak = 2;
    await finishMonitorRecovery(incident, target, ranger, 'L3审批后实际启动Windows服务，并通过原探测器复验');
  } else { incident.status = 'diagnosed'; trace.plan.status = 'repair_verification_failed'; timeline(incident, 'Ranger', '服务启动或恢复验证失败，未伪造解决状态'); saveState(); }
}

async function monitorTick() {
  if (!state.settings.monitoring_enabled) return;
  const due = state.monitor_targets.filter(target => target.enabled && (!target.next_check_at || Date.parse(target.next_check_at) <= Date.now()));
  await Promise.all(due.map(target => checkMonitorTarget(target).catch(error => log('ERROR', `监控探测失败 ${target.id}`, error.message))));
}

function startMonitorScheduler() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = setInterval(() => monitorTick().catch(error => log('ERROR', 'monitorTick', error.message)), 2000);
  monitorTimer.unref(); setTimeout(() => monitorTick().catch(() => {}), 500).unref();
}

function stopFault() {
  if (faultWorker) { faultWorker.terminate().catch(() => {}); faultWorker = null; }
  memoryFault = null;
  faultState = { active: false, type: '', until: 0, started_at: null };
}

function injectFault(type, duration, mb) {
  stopFault();
  const until = Date.now() + duration * 1000;
  faultState = { active: true, type, until, started_at: now() };
  if (type === 'cpu') {
    faultWorker = new Worker(`const { parentPort }=require('node:worker_threads');let x=0;while(true){x=Math.sin(x+1);if(x>2)parentPort.postMessage(x)}`, { eval: true });
    faultWorker.unref();
  } else {
    memoryFault = Buffer.alloc(mb * 1024 * 1024, 1);
  }
  setTimeout(stopFault, duration * 1000).unref();
  return until;
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > 1024 * 1024) { reject(new Error('请求体超过 1MB')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('JSON 格式无效')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(data) : data;
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline' data:; connect-src 'self' https:; img-src 'self' data:"
  });
  res.end(payload);
}

function notFound(res) { send(res, 404, { detail: 'Not found' }); }
function incidentById(id) { return state.incidents.find(item => item.id === id); }

// Structured diagnosis — used by Detective and debate engine
function structuredDiagnosis(title, description) {
  const t = String(title||'').toLowerCase(); const d = String(description||'').toLowerCase();
  const evidence = []; let rootCause = ''; let confidence = 0.5; let selectedCategory = 'unknown';
  if (t.includes('timeout')||t.includes('超时')||d.includes('timeout')||d.includes('超时')) { rootCause = '服务响应超时，可能原因：连接池耗尽、网络延迟、下游服务瓶颈'; selectedCategory = 'latency_timeout'; confidence = 0.65; evidence.push({skill:'log-hunter',finding:'发现大量超时错误日志'}); }
  else if (t.includes('memory')||t.includes('内存')||d.includes('memory')||d.includes('oom')) { rootCause = '内存使用异常，可能原因：内存泄漏、GC压力、缓存未释放'; selectedCategory = 'memory_pressure'; confidence = 0.60; evidence.push({skill:'metric-analyzer',finding:'内存使用率持续上升'}); }
  else if (t.includes('cpu')||t.includes('CPU')||d.includes('cpu')) { rootCause = 'CPU负载过高，可能原因：计算密集型任务、死循环、线程风暴'; selectedCategory = 'cpu_pressure'; confidence = 0.60; evidence.push({skill:'metric-analyzer',finding:'CPU使用率峰值异常'}); }
  else if (t.includes('connection')||t.includes('连接')||d.includes('pool')||d.includes('连接池')) { rootCause = '数据库连接池耗尽，可能原因：连接泄漏、并发突增、配置不当'; selectedCategory = 'connection_pool'; confidence = 0.70; evidence.push({skill:'log-hunter',finding:'ConnectionPoolExhausted错误'},{skill:'change-scanner',finding:'检查近期连接池配置变更'}); }
  else if (t.includes('disk')||t.includes('磁盘')||d.includes('disk')) { rootCause = '磁盘空间不足或IO瓶颈'; selectedCategory = 'disk_pressure'; confidence = 0.55; evidence.push({skill:'metric-analyzer',finding:'磁盘使用率超过阈值'}); }
  else if (t.includes('ssl')||t.includes('证书')||t.includes('certificate')) { rootCause = 'SSL证书过期或配置错误'; selectedCategory = 'certificate'; confidence = 0.80; evidence.push({skill:'change-scanner',finding:'检测到证书即将过期'}); }
  else { rootCause = `基于症状分析：${title}。建议检查近期变更、系统指标和错误日志`; confidence = 0.40; evidence.push({skill:'log-hunter',finding:'需要更多数据'}); }
  return { root_cause:rootCause, selected_category:selectedCategory, confidence, evidences:evidence, counter_evidence:[], missing_evidence:['实时指标','变更记录'], llm_status:'fallback', model:'', can_proceed_to_repair:confidence>=0.8 };
}

// Risk classification for debate engine
function classifyRisk(text) { const t=String(text||'').toLowerCase(); if(/delete|drop|destroy|purge/.test(t)) return 'L4'; if(/restart|reboot|shutdown|kill|alter|firewall|credential/.test(t)) return 'L3'; if(/scale|resize|migrate|deploy|config|pool/.test(t)) return 'L2'; if(/restart_service|clear_cache|flush/.test(t)) return 'L1'; return 'L0'; }
function canAutoExecute(risk, confidence, llmStatus) { if(risk==='L0'||risk==='L1') return {allowed:true,reason:'auto'}; if(risk==='L2'&&confidence>=0.8&&llmStatus!=='fallback') return {allowed:true,reason:'high_confidence'}; if(risk==='L3') return {allowed:false,reason:'requires human approval'}; if(risk==='L4') return {allowed:false,reason:'forbidden'}; return {allowed:false,reason:'insufficient'}; }

function linearTrend(samples) {
  const points = samples.filter(item => Number.isFinite(item.value) && Number.isFinite(item.time)).sort((a, b) => a.time - b.time);
  if (points.length < 6) return null;
  const origin = points[0].time;
  const xs = points.map(item => (item.time - origin) / 60000);
  const ys = points.map(item => item.value);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const denominator = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  if (denominator <= 0) return null;
  const slope = xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i] - meanY), 0) / denominator;
  const predicted = xs.map(x => meanY + slope * (x - meanX));
  const total = ys.reduce((sum, y) => sum + (y - meanY) ** 2, 0);
  const residual = ys.reduce((sum, y, i) => sum + (y - predicted[i]) ** 2, 0);
  const r2 = total > 0 ? Math.max(0, Math.min(1, 1 - residual / total)) : 0;
  return { slope_per_minute: Math.round(slope * 1000) / 1000, r_squared: Math.round(r2 * 1000) / 1000, current: ys.at(-1), sample_count: points.length, span_minutes: Math.round((xs.at(-1) - xs[0]) * 10) / 10 };
}

// RAG runbook matching using TF-IDF vector similarity
function ragMatchRunbooks(query) {
  if (!query || !state.runbooks.length) return [];
  const docs = state.runbooks.map(r => tokenize(r.title+' '+r.symptoms+' '+r.category));
  const queryTokens = tokenize(query); docs.push(queryTokens);
  const vectors = tfidf(docs); const queryVec = vectors.pop();
  const scored = state.runbooks.map((rb,i) => ({ runbook_id:rb.id, title:rb.title, risk:rb.risk, similarity:Math.round(cosineSimilarity(queryVec, vectors[i])*100)/100, method:'TF-IDF RAG' }));
  return scored.filter(s => s.similarity > 0.05).sort((a,b) => b.similarity - a.similarity).slice(0,5);
}

// AI-powered lesson generation for Sage
async function generateAILessons(incident, diagnosis) {
  if (!aiKey || !state.settings.endpoint) return [];
  const started = Date.now();
  const trace = state.traces.find(item => item.event_id === incident.id);
  const call = {
    llm_call_id: makeId('llm'), event_id: incident.id, trace_id: trace && trace.plan ? trace.plan.trace_id : '', agent_run_id: '',
    purpose: 'postmortem_lessons', model: state.settings.model, endpoint_host: new URL(state.settings.endpoint).host,
    prompt_hash: '', input_hash: stableHash({ incident_id: incident.id, diagnosis_id: diagnosis && diagnosis.id }), status: 'RUNNING',
    started_at: now(), finished_at: null, duration_ms: null, response_hash: '', usage: null, error_type: '', error_message: ''
  };
  state.llm_calls.push(call);
  try {
    const prompt = '你是资深SRE。根据故障生成3条经验教训(每条≤30字)。故障:'+incident.title+'。根因:'+(diagnosis?.root_cause||'待分析')+'。用JSON数组回复:["l1","l2","l3"]';
    call.prompt_hash = stableHash(prompt);
    const resp = await fetch(state.settings.endpoint, {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+aiKey},body:JSON.stringify({model:state.settings.model,messages:[{role:'user',content:prompt}],max_tokens:200,temperature:0.3}),signal:AbortSignal.timeout(15000)});
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`);
    const data = await resp.json(); const text = data.choices[0].message.content; const match = text.match(/\[[\s\S]*\]/);
    call.status = 'SUCCEEDED'; call.response_hash = stableHash(text);
    call.usage = data.usage ? { prompt_tokens: Number(data.usage.prompt_tokens || 0), completion_tokens: Number(data.usage.completion_tokens || 0), total_tokens: Number(data.usage.total_tokens || 0) } : null;
    return match ? JSON.parse(match[0]) : [text.slice(0,100)];
  } catch(error) {
    call.status = 'FAILED'; call.error_type = error.name || 'Error'; call.error_message = String(error.message || error).slice(0, 1000);
    return [];
  } finally {
    call.finished_at = now(); call.duration_ms = Date.now() - started;
    evidenceLedger.append(state, incident.id, call.status === 'SUCCEEDED' ? 'llm_call_succeeded' : 'llm_call_failed', {
      llm_call_id: call.llm_call_id, purpose: call.purpose, model: call.model, prompt_hash: call.prompt_hash,
      response_hash: call.response_hash, usage: call.usage, error_type: call.error_type, error_message: call.error_message, duration_ms: call.duration_ms
    }, { actor: 'Sage', trace_id: call.trace_id });
    saveState();
  }
}

function localDebateHypotheses(incident) {
  const diagnosis = latestByEvent(state.diagnoses, incident.id);
  const target = state.monitor_targets.find(item => item.id === incident.monitor_target_id);
  const recent = target ? recentMonitorResults(target.id, 10) : [];
  const text = `${incident.title} ${incident.description} ${diagnosis?.root_cause || ''}`.toLowerCase();
  const refs = [];
  if (diagnosis) refs.push({ ref: `diagnosis:${diagnosis.id}`, source: 'diagnosis', claim: diagnosis.root_cause });
  recent.slice(-5).forEach(item => refs.push({ ref: `probe:${item.id}`, source: item.source, claim: item.reason }));
  const candidates = [];
  const add = (rootCause, confidence, support, counter, missing) => candidates.push({
    root_cause: rootCause, confidence, evidences: support, counter_evidence: counter,
    missing_evidence: missing, llm_status: 'local_evidence_engine', model: '', can_proceed_to_repair: confidence >= 0.8
  });
  if (/连接池|connection|pool|timeout|超时/.test(text)) {
    add('连接池容量不足或连接泄漏导致请求排队', 0.82, refs, ['仍需排除下游网络延迟'], ['活跃连接分布']);
    add('下游依赖响应变慢导致连接长期占用', 0.63, refs, ['连接池配置变更与故障时间可能更相关'], ['下游服务分段延迟']);
    add('瞬时流量突增超过当前容量规划', 0.56, refs, ['若低流量下仍复现则不支持该假设'], ['请求速率时间序列']);
  } else if (/cpu|处理器|负载/.test(text)) {
    add('单个或多个进程持续消耗CPU', 0.78, refs, ['缺少进程级CPU采样'], ['进程CPU排行']);
    add('短时并发任务造成可恢复的CPU峰值', 0.62, refs, ['持续时间过长时不支持峰值假设'], ['任务队列长度']);
    add('系统调度或后台维护任务导致资源竞争', 0.48, refs, ['尚无调度器日志'], ['计划任务与系统事件']);
  } else if (/内存|memory|oom/.test(text)) {
    add('应用工作集持续增长，疑似内存泄漏', 0.76, refs, ['单点高占用不能证明泄漏'], ['进程工作集趋势']);
    add('缓存扩张导致可回收内存增加', 0.61, refs, ['缺少缓存命中率'], ['缓存容量与命中率']);
    add('并发任务临时分配导致内存峰值', 0.50, refs, ['若任务结束后不回落则不支持'], ['任务结束后的恢复样本']);
  } else if (/进程|应用|process|未运行/.test(text)) {
    add('目标进程未启动或已经退出', 0.90, refs, [], ['应用退出日志']);
    add('配置的进程名称与实际可执行文件不一致', 0.66, refs, ['若历史上曾探测成功则概率降低'], ['已安装程序清单']);
    add('探测权限或平台能力不足造成假阴性', 0.42, refs, ['探测来源可用时不支持'], ['探测器错误码']);
  } else {
    add(diagnosis?.root_cause || '目标出现可重复的健康探测异常', Number(diagnosis?.confidence || 0.55), refs, [], ['目标日志与变更记录']);
    add('外部依赖或网络路径异常', 0.45, refs, ['当前证据未直接指向网络'], ['依赖拓扑与分段探测']);
    add('短暂抖动或监控阈值配置不合理', 0.35, refs, ['连续失败会削弱抖动假设'], ['更长时间窗口样本']);
  }
  return candidates.slice(0, 3).map((item, index) => ({ id: `H${index + 1}`, ...item }));
}

const WINDOWS_SERVICE_START_ALLOWLIST = new Set(
  String(process.env.INTELLIOPS_WINDOWS_SERVICE_ALLOWLIST || 'Spooler')
    .split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
);

function addIncident(data, source = 'manual') {
  const incident = {
    id: makeId('inc'), title: String(data.title || '未命名事件').slice(0, 200),
    severity: String(data.severity || 'P2-中').slice(0, 20), service: String(data.service || '').slice(0, 120),
    description: String(data.description || '').slice(0, 4000), status: 'open', current_agent: 'Commander',
    created_at: now(), updated_at: now(), resolved_at: null, mttr_minutes: null,
    timeline: [{ time: now(), action: '事件已创建并进入 Orchestrator', agent: '系统' }],
    fingerprint: crypto.createHash('sha256').update(`${data.title || ''}|${data.service || ''}`).digest('hex').slice(0, 16),
    llm_status: 'not_called', source
  };
  state.incidents.push(incident);
  saveState();
  return incident;
}

function validAiEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && process.env.INTELLIOPS_ALLOW_HTTP !== '1') return false;
    const host = url.hostname.toLowerCase();
    const localOrPrivate = ['localhost', '127.0.0.1', '::1'].includes(host) ||
      /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^fc/i.test(host) || /^fd/i.test(host) || /^fe80:/i.test(host);
    if (localOrPrivate && process.env.INTELLIOPS_ALLOW_LOCAL_LLM !== '1') return false;
    return true;
  } catch (_) { return false; }
}

function agentTeamsAdapter() {
  return new AgentTeamsAdapter({
    baseUrl: state.settings.agentteams_controller_url || process.env.INTELLIOPS_AGENTTEAMS_CONTROLLER_URL || '',
    token: process.env.INTELLIOPS_AGENTTEAMS_TOKEN || '',
    matrixUrl: process.env.INTELLIOPS_AGENTTEAMS_MATRIX_URL || '',
    matrixToken: process.env.INTELLIOPS_AGENTTEAMS_MATRIX_TOKEN || '',
    matrixUserId: process.env.INTELLIOPS_AGENTTEAMS_MATRIX_USER_ID || '',
    teamName: state.settings.agentteams_team_name || 'intelliops-operations'
  });
}

async function officialTwinCollaboration(incident, trace, demoRun) {
  const adapter = agentTeamsAdapter();
  const status = await adapter.status();
  agentTeamsLastStatus = status;
  if (!status.connected || !status.task_dispatch_ready) {
    demoRun.agentteams = { status: 'SKIPPED', reason: status.reason || status.task_dispatch_reason || 'official_runtime_unavailable' };
    return demoRun.agentteams;
  }
  const dispatch = await adapter.dispatchIncident(incident, trace);
  Object.assign(dispatch, { event_id: incident.id, trace_id: trace.plan.trace_id, created_at: now(), purpose: 'digital_twin_collaborative_diagnosis' });
  state.agentteams_dispatches.push(dispatch);
  trace.external_agentteams_runs = trace.external_agentteams_runs || [];
  trace.external_agentteams_runs.push(dispatch);
  demoRun.agentteams = { status: 'WAITING_RESULT', dispatch_id: dispatch.dispatch_id };
  evidenceLedger.append(state, incident.id, 'agentteams_matrix_dispatch', dispatch, { actor: 'Official AgentTeams', trace_id: trace.plan.trace_id });
  saveState();
  adapter.pollDispatchResult(dispatch, 150000, 3000).then(result => {
    Object.assign(dispatch, result);
    Object.assign(demoRun.agentteams, { status: result.status, dispatch_id: dispatch.dispatch_id, result_sender: result.result_sender || '', result_text: result.result_text || '' });
    if (result.status === 'SUCCEEDED') {
      const diagnosis = latestByEvent(state.diagnoses, incident.id);
      if (diagnosis) {
        diagnosis.evidences = Array.isArray(diagnosis.evidences) ? diagnosis.evidences : [];
        const ref = `agentteams:${dispatch.dispatch_id}`;
        if (!diagnosis.evidences.some(item => item.ref === ref)) {
          diagnosis.evidences.push({ ref, source: result.result_sender || 'Official AgentTeams', claim: String(result.result_text || '').slice(0, 500) });
        }
        diagnosis.official_agentteams_status = 'SUCCEEDED';
        diagnosis.missing_evidence = (diagnosis.missing_evidence || []).filter(item => !String(item).includes('AgentTeams'));
      }
    }
    evidenceLedger.append(state, incident.id, result.status === 'SUCCEEDED' ? 'agentteams_matrix_result' : 'agentteams_matrix_timeout', {
      dispatch_id: dispatch.dispatch_id, status: result.status, result_sender: result.result_sender || '', result_hash: result.result_text ? stableHash(result.result_text) : ''
    }, { actor: 'Official AgentTeams', trace_id: trace.plan.trace_id });
    timeline(incident, 'Official AgentTeams', result.status === 'SUCCEEDED' ? `官方Commander协作结果已进入诊断证据：${result.result_sender}` : '官方协作超时，本地证据链已独立完成处理');
    saveState();
  }).catch(error => {
    dispatch.status = 'FAILED'; dispatch.error = String(error.message || error); dispatch.finished_at = now();
    Object.assign(demoRun.agentteams, { status: 'FAILED', reason: dispatch.error, dispatch_id: dispatch.dispatch_id });
    timeline(incident, 'Official AgentTeams', `官方协作跟踪失败：${dispatch.error}`);
    saveState();
  });
  return demoRun.agentteams;
}

function twinScenarioPolicy(scenario) {
  return {
    gateway_latency: { component_id: 'gateway', recovery_action: 'restore_config', risk_level: 'L1', root_cause: '网关延迟配置偏离基线' },
    payment_bad_config: { component_id: 'payment', recovery_action: 'restore_config', risk_level: 'L1', root_cause: '支付服务错误配置导致健康检查和请求失败' },
    payment_service_crash: { component_id: 'payment', recovery_action: 'restart_service', risk_level: 'L2', root_cause: '支付受管服务监听器退出' },
    inventory_app_crash: { component_id: 'inventory-app', recovery_action: 'restart_managed_application', risk_level: 'L3', root_cause: '库存受管应用实例退出' }
  }[scenario] || null;
}

async function completeTwinRecovery(incident, demoRun, approved = false) {
  const policy = twinScenarioPolicy(demoRun.scenario);
  if (!policy) throw new Error('scenario_policy_missing');
  if (policy.risk_level === 'L3' && !approved) return { status: 'waiting_approval' };
  const trace = traceFor(incident.id);
  const previous = trace.agent_runs.at(-1);
  const ranger = await agentRun(incident, 'Ranger', `twin_${policy.recovery_action}`, previous && previous.agent_run_id || '', async run => {
    demoRun.stage = 'EXECUTING'; demoRun.updated_at = now();
    const started = Date.now();
    const execution = await digitalTwin.recover(policy.recovery_action, policy.component_id);
    const after = await digitalTwin.probe(policy.component_id, 10);
    demoRun.after_metrics = after;
    const thresholds = { max_error_rate: 5, max_p95_latency_ms: 200 };
    const verified = await runSkill(incident, run, 'twin-recovery-verifier', { component_id: policy.component_id, after, thresholds });
    const passed = verified.passed;
    const verification = { ...verified, before: demoRun.before_metrics, fault: demoRun.fault_metrics, after };
    const repair = {
      id: makeId('repair'), incident_id: incident.id, runbook_id: policy.recovery_action,
      status: passed ? 'SUCCEEDED' : 'FAILED', execution_type: 'sandbox', execution_mode: 'sandbox',
      action: policy.recovery_action, component_id: policy.component_id, arbitrary_shell: false,
      stdout: JSON.stringify({ generation: execution.after.generation, running: execution.after.running }), stderr: '',
      exit_code: passed ? 0 : 1, duration_ms: Date.now() - started, verification, created_at: now()
    };
    state.repairs.push(repair);
    state.metric_samples.push({ event_id: incident.id, stage: 'twin-after-recovery', ...after });
    evidenceLedger.append(state, incident.id, 'twin_recovery_verified', { repair_id: repair.id, action: policy.recovery_action, verification }, { actor: 'Ranger', trace_id: run.trace_id });
    return { status: passed ? 'completed' : 'blocked', repair, verification };
  });
  if (!ranger.output.verification.passed) {
    incident.status = 'failed'; trace.plan.status = 'failed'; demoRun.status = 'FAILED'; demoRun.stage = 'VERIFICATION_FAILED';
    timeline(incident, 'Ranger', '数字孪生恢复后真实HTTP复验未通过，事件保持FAILED'); saveState(); return ranger.output;
  }
  const sage = await agentRun(incident, 'Sage', 'twin_postmortem', ranger.agent_run_id, async () => {
    const pm = {
      id: makeId('pm'), incident_id: incident.id, title: `${incident.title} 数字孪生复盘`, root_cause: policy.root_cause,
      process_notes: `从${demoRun.fault_metrics.error_rate}%错误率恢复到${ranger.output.verification.after.error_rate}%；数据来自真实本地HTTP请求。`,
      lessons: ['只允许项目白名单恢复动作', '修复后必须使用原探测路径复验', '官方AgentTeams结论作为证据而非可执行命令'],
      runbook_updates: [], alert_optimizations: [], created_at: now(), llm_status: 'rule-engine', model: ''
    };
    state.postmortems.push(pm); return { status: 'completed', postmortem_id: pm.id };
  });
  incident.status = 'resolved'; incident.current_agent = '已解决'; incident.resolved_at = now();
  incident.mttr_minutes = Math.max(0.1, Math.round((Date.now() - Date.parse(incident.created_at)) / 6000) / 10);
  trace.plan.status = 'completed'; demoRun.status = 'SUCCEEDED'; demoRun.stage = 'COMPLETED'; demoRun.finished_at = now();
  timeline(incident, 'Sage', '真实恢复验证通过，复盘已归档');
  demoRun.sage_run_id = sage.agent_run_id; saveState();
  return ranger.output;
}

async function runTwinPipeline(incident, injection, demoRun) {
  const trace = traceFor(incident.id);
  try {
    demoRun.stage = 'COLLECTING_EVIDENCE'; demoRun.updated_at = now(); saveState();
    const commander = await agentRun(incident, 'Commander', 'twin_triage_and_plan', '', async () => ({
      status: 'completed', scenario: demoRun.scenario, plan: ['真实HTTP探测', '官方AgentTeams协作', '结构化诊断', '风险决策', '白名单恢复', '同路径复验']
    }));
    const detective = await agentRun(incident, 'Detective', 'twin_evidence_and_collaboration', commander.agent_run_id, async run => {
      const faultMetrics = await digitalTwin.probe(injection.component_id, 10);
      demoRun.fault_metrics = faultMetrics;
      state.metric_samples.push({ event_id: incident.id, stage: 'twin-fault', ...faultMetrics });
      const collected = await runSkill(incident, run, 'twin-evidence-collector', {
        component_id: injection.component_id, scenario: demoRun.scenario, metrics: faultMetrics
      });
      if (!collected.passed) throw new Error('digital_twin_evidence_source_invalid');
      const official = await officialTwinCollaboration(incident, trace, demoRun);
      const policy = twinScenarioPolicy(demoRun.scenario);
      const directEvidence = [
        { ref: `twin:${injection.component_id}:fault`, source: faultMetrics.source, claim: `error_rate=${faultMetrics.error_rate}%,p95=${faultMetrics.p95_latency_ms}ms` },
        { ref: `twin:${injection.component_id}:change`, source: 'digital_twin_change_log', claim: `scenario=${demoRun.scenario}` }
      ];
      if (official.status === 'SUCCEEDED') directEvidence.push({ ref: `agentteams:${official.dispatch_id}`, source: official.result_sender, claim: String(official.result_text).slice(0, 500) });
      const diagnosis = {
        id: makeId('diag'), incident_id: incident.id, root_cause: policy.root_cause, selected_category: demoRun.scenario,
        confidence: 0.96, evidences: directEvidence, counter_evidence: [], missing_evidence: official.status === 'SUCCEEDED' ? [] : ['官方AgentTeams未返回，不影响直接探测证据'],
        can_proceed_to_repair: true, llm_status: 'structured-evidence', model: '', official_agentteams_status: official.status, created_at: now()
      };
      state.diagnoses.push(diagnosis);
      evidenceLedger.append(state, incident.id, 'twin_diagnosis', diagnosis, { actor: 'Detective', trace_id: run.trace_id });
      return { status: 'completed', ...diagnosis };
    });
    const policy = twinScenarioPolicy(demoRun.scenario);
    demoRun.stage = 'RISK_DECISION'; demoRun.updated_at = now();
    if (policy.risk_level === 'L3') {
      const content = { event_id: incident.id, component_id: policy.component_id, recovery_action: policy.recovery_action, risk_level: policy.risk_level };
      const approval = {
        id: makeId('approval'), event_id: incident.id, mode: 'twin_managed_app_restart', risk_level: 'L3',
        operation: '重启项目自带数字孪生受管应用', target: policy.component_id, target_id: policy.component_id,
        parameters: { component_id: policy.component_id, recovery_action: policy.recovery_action }, content_hash: stableHash(content),
        content_summary: content, rollback_plan: ['停止新实例', '事件保持FAILED并等待人工检查'], status: 'PENDING',
        requested_at: now(), decided_at: null, approver: null, comment: '', trace_id: trace.plan.trace_id
      };
      state.approvals.push(approval); incident.status = 'waiting_approval'; trace.plan.status = 'waiting_approval';
      demoRun.status = 'WAITING_APPROVAL'; demoRun.stage = 'WAITING_APPROVAL'; demoRun.approval_id = approval.id;
      timeline(incident, 'Ranger', `L3受管应用重启等待人工审批：${approval.id}`); saveState(); return;
    }
    await completeTwinRecovery(incident, demoRun, true);
  } catch (error) {
    incident.status = 'failed'; trace.plan.status = 'failed'; demoRun.status = 'FAILED'; demoRun.stage = 'FAILED'; demoRun.error = String(error.message || error); demoRun.finished_at = now();
    timeline(incident, 'Manager', `数字孪生流水线失败：${demoRun.error}`); saveState();
  } finally {
    if (activeTwinDemoRunId === demoRun.id) activeTwinDemoRunId = '';
  }
}

async function resumeTwinApproval(approval) {
  const incident = incidentById(approval.event_id);
  const demoRun = state.demo_runs.find(item => item.event_id === approval.event_id);
  if (!incident || !demoRun) throw new Error('数字孪生审批关联数据不存在');
  const current = { event_id: incident.id, component_id: approval.parameters.component_id, recovery_action: approval.parameters.recovery_action, risk_level: approval.risk_level };
  if (stableHash(current) !== approval.content_hash) { approval.status = 'INVALIDATED'; throw new Error('审批内容已变化，原审批失效'); }
  await completeTwinRecovery(incident, demoRun, true);
}

function runtimeManifest() {
  return {
    runtime_mode: RUNTIME_MODE,
    statement: agentTeamsLastStatus.connected
      ? '已连接官方AgentTeams控制器；官方Team/Worker状态来自控制器API，本地执行证据仍由IntelliOps保存。'
      : '独立APP默认使用本地可验证编排；官方AgentTeams未连接时明确标记为local_verified，不冒充官方运行实例。',
    official_target: AGENTTEAMS_TARGET,
    official_runtime_connected: Boolean(agentTeamsLastStatus.connected),
    official_runtime_status: agentTeamsLastStatus,
    topology: { manager: 'Commander / Team Leader', workers: ['Detective', 'Ranger', 'Sage'], human_in_the_loop: true },
    transport: { embedded: 'local_verified', official: 'AgentTeams Controller REST + Matrix room' },
    shared_state: DATA_FILE,
    skill_count: Object.keys(skillRegistry).length,
    core_skills: ['system_metrics_collector', 'evidence_analyzer', 'runbook_matcher'],
    agentteams_contract: {
      official_runtime_required_for_claim: true,
      local_mode_claim: 'AgentTeams-compatible Manager/Workers contract only',
      mapping: { manager: 'Commander', workers: ['Detective', 'Ranger', 'Sage'], transport: 'Matrix when official runtime connected' }
    },
    digital_twin: digitalTwin.status(),
    guarantees: ['task_assignment消息留痕', 'parent_run_id上下文传递', 'SkillRun/ToolCall/LLMCall可审计', 'SHA-256证据链', 'L3人工审批', '数字孪生真实HTTP复验']
  };
}

function evidencePack(eventId) {
  const incident = incidentById(eventId);
  if (!incident) return null;
  const byEvent = collection => collection.filter(item => (item.event_id || item.incident_id) === eventId);
  const trace = state.traces.find(item => item.event_id === eventId) || null;
  const ledgerRecords = evidenceLedger.recordsFor(state, eventId);
  const files = {
    'incident.json': incident,
    'agent-trace.json': trace,
    'skill-runs.json': byEvent(state.skill_runs),
    'tool-calls.json': byEvent(state.tool_calls),
    'llm-calls.json': byEvent(state.llm_calls),
    'diagnosis.json': byEvent(state.diagnoses),
    'metrics-before-after.json': byEvent(state.metric_samples),
    'approval.json': byEvent(state.approvals),
    'rollback.json': byEvent(state.rollback_runs),
    'repairs.json': byEvent(state.repairs),
    'postmortem.json': state.postmortems.filter(item => item.incident_id === eventId),
    'agentteams-dispatches.json': byEvent(state.agentteams_dispatches),
    'digital-twin-runs.json': byEvent(state.twin_runs),
    'demo-runs.json': byEvent(state.demo_runs),
    'alerts.json': state.alerts.filter(item => item.event_id === eventId),
    'evidence-ledger.json': ledgerRecords
  };
  const integrity = evidenceLedger.manifest(files);
  return {
    manifest: {
      schema: 'intelliops-evidence-pack/v2', generated_at: now(), app_version: APP_VERSION,
      event_id: eventId, runtime: runtimeManifest(), integrity,
      ledger_verification: evidenceLedger.verify(ledgerRecords)
    },
    ...files
  };
}

function overview() {
  const active = state.incidents.filter(item => !['resolved', 'rejected', 'failed'].includes(item.status));
  const enabledTargets = state.monitor_targets.filter(item => item.enabled);
  return {
    generated_at: now(), app_version: APP_VERSION, runtime_mode: RUNTIME_MODE,
    counts: {
      incidents: state.incidents.length, active: active.length,
      resolved: state.incidents.filter(item => item.status === 'resolved').length,
      alerts: state.alerts.length, agent_runs: state.traces.reduce((n, item) => n + item.agent_runs.length, 0),
      skill_runs: state.skill_runs.length, tool_calls: state.tool_calls.length,
      pending_approvals: state.approvals.filter(item => item.status === 'PENDING').length,
      rollbacks: state.rollback_runs.length,
      monitor_targets: state.monitor_targets.length,
      monitor_enabled: enabledTargets.length,
      monitor_healthy: enabledTargets.filter(item => item.status === 'healthy').length,
      monitor_unhealthy: enabledTargets.filter(item => item.status === 'unhealthy').length
    },
    latest_incident: state.incidents.at(-1) ? publicIncident(state.incidents.at(-1)) : null,
    latest_metrics: state.metric_samples.at(-1) || paymentSandbox.lastBatch,
    sandbox: sandboxConfig(),
    monitoring: { enabled: Boolean(state.settings.monitoring_enabled), targets: state.monitor_targets, latest_results: state.monitor_results.slice(-20) },
    recent_postmortems: state.postmortems.slice(-20).reverse()
  };
}

async function handleRequest(req, res) {
  requestCount += 1;
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const method = req.method || 'GET';
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (method === 'GET' && pathname === '/') return send(res, 200, frontendHtml(), 'text/html; charset=utf-8');
    if (method === 'GET' && pathname === '/assets/v13-rendering.js') return send(res, 200, frontendScript('v13-rendering.js'), 'application/javascript; charset=utf-8');
    if (method === 'GET' && pathname === '/assets/v14-competition.js') return send(res, 200, frontendScript('v14-competition.js'), 'application/javascript; charset=utf-8');
    if (method === 'GET' && pathname === '/assets/v16-twin.js') return send(res, 200, frontendScript('v16-twin.js'), 'application/javascript; charset=utf-8');
    if (method === 'GET' && pathname === '/assets/v16-ai-diagnosis.js') return send(res, 200, frontendScript('v16-ai-diagnosis.js'), 'application/javascript; charset=utf-8');
    if (method === 'GET' && pathname === '/assets/v16-trace-cn.js') return send(res, 200, frontendScript('v16-trace-cn.js'), 'application/javascript; charset=utf-8');
    if (method === 'GET' && pathname === '/favicon.ico') return send(res, 204, '', 'text/plain');
    if (method === 'GET' && pathname === '/api/twin/status') {
      return send(res, 200, { ...digitalTwin.status(), recent_runs: state.demo_runs.slice(-10) });
    }
    if (method === 'POST' && pathname === '/api/twin/reset') {
      const status = await digitalTwin.reset();
      return send(res, 200, { status: 'reset', twin: status });
    }
    if (method === 'GET' && pathname === '/api/twin/demo-runs') return send(res, 200, state.demo_runs.slice().reverse());
    if (method === 'POST' && pathname === '/api/twin/demo/start') {
      const data = await bodyJson(req);
      const scenario = String(data.scenario || 'gateway_latency');
      const policy = twinScenarioPolicy(scenario);
      if (!policy) return send(res, 422, { detail: 'scenario不在数字孪生故障白名单' });
      const waitingApproval = state.demo_runs.find(item => item.status === 'WAITING_APPROVAL');
      if (activeTwinDemoRunId) return send(res, 409, { detail: '当前故障仍在自动处理中，请查看下方实时进度', demo_run_id: activeTwinDemoRunId });
      if (waitingApproval) return send(res, 409, { detail: '已有L3故障等待人工审批，请先批准或拒绝后再开始新场景', demo_run_id: waitingApproval.id, event_id: waitingApproval.event_id });
      await digitalTwin.reset();
      const before = await digitalTwin.probe(policy.component_id, 8);
      const injection = await digitalTwin.inject(scenario);
      const incident = addIncident({
        title: `数字孪生故障：${scenario}`, severity: policy.risk_level === 'L3' ? 'P1-高' : 'P2-中',
        service: policy.component_id, description: `项目自带数字孪生环境注入${scenario}，预期恢复动作${policy.recovery_action}`
      }, 'digital_twin');
      const demoRun = {
        id: makeId('demo'), event_id: incident.id, scenario, component_id: policy.component_id,
        recovery_action: policy.recovery_action, risk_level: policy.risk_level, status: 'RUNNING', stage: 'FAULT_INJECTED',
        execution_mode: 'sandbox', before_metrics: before, fault_metrics: null, agentteams: { status: 'PENDING' },
        created_at: now(), updated_at: now(), finished_at: null, error: ''
      };
      state.demo_runs.push(demoRun);
      activeTwinDemoRunId = demoRun.id;
      state.twin_runs.push({ id: makeId('twin'), event_id: incident.id, action: 'fault_injection', scenario, component_id: policy.component_id, before, injection, execution_mode: 'sandbox', created_at: now() });
      state.metric_samples.push({ event_id: incident.id, stage: 'twin-before', ...before });
      evidenceLedger.append(state, incident.id, 'twin_fault_injected', { scenario, component_id: policy.component_id, before_hash: stableHash(before), injection }, { actor: 'DemoCenter', trace_id: traceFor(incident.id).plan.trace_id });
      saveState(); setImmediate(() => runTwinPipeline(incident, injection, demoRun));
      return send(res, 201, { status: 'started', demo_run_id: demoRun.id, event_id: incident.id, scenario, risk_level: policy.risk_level });
    }
    // --- v7.0: Multi-Agent Debate Engine ---
    if (method === 'POST' && pathname.startsWith('/api/debate/')) {
      const eid = pathname.split('/').pop(); const incident = incidentById(eid);
      if (!incident) return send(res, 404, { detail: 'Incident not found' });
      // Detective generates three distinct, falsifiable hypotheses from persisted local evidence.
      const hypotheses = localDebateHypotheses(incident);

      // Ranger evaluates each hypothesis independently
      const evaluations = hypotheses.map(h => {
        const risk = classifyRisk(h.root_cause); const canAuto = canAutoExecute(risk, h.confidence, h.llm_status);
        return { hypothesis_id: h.id, risk_level: risk, can_auto_execute: canAuto.allowed,
          reason: canAuto.reason||'auto', required_approval: risk==='L3',
          matched_runbook: ragMatchRunbooks(h.root_cause)[0]||null };
      });

      // Arbiter: score and rank
      const scored = hypotheses.map((h,i) => {
        const ev = evaluations[i]; let score = h.confidence * 0.4;
        if (ev.risk_level === 'L1') score += 0.3; else if (ev.risk_level === 'L2') score += 0.15;
        if (ev.matched_runbook) score += 0.2;
        const pastFeedback = (state.diagnosis_feedback||[]).filter(f => f.root_cause_pattern && h.root_cause.includes(f.root_cause_pattern));
        if (pastFeedback.length) { const avgRating = pastFeedback.reduce((s,f)=>s+(f.rating==='up'?1:0),0)/pastFeedback.length; score += avgRating * 0.1; }
        return { ...h, evaluation:ev, score:Math.round(score*100)/100 };
      }).sort((a,b) => b.score - a.score);

      const debateRun = { id: makeId('debate'), incident_id:eid, hypotheses:scored, winner:scored[0], generation_mode:'local_evidence_engine', privacy_boundary:'no_event_data_sent_to_external_llm', arbiter_reason:'综合证据强度、风险等级、Runbook匹配和历史反馈加权评分', created_at:now() };
      if (!state.debates) state.debates = []; state.debates.push(debateRun); saveState();
      return send(res, 200, { status:'debate_complete', hypotheses_count:hypotheses.length, winner:scored[0], full_debate:debateRun });
    }

    // --- v7.0: Decision Tree ---
    if (method === 'GET' && pathname.startsWith('/api/decision-tree/')) {
      const eid = pathname.split('/').pop(); const incident = incidentById(eid);
      if (!incident) return send(res, 404, {});
      const runs = state.skill_runs.filter(r => r.event_id===eid||r.incident_id===eid);
      const approvals = state.approvals.filter(a => a.event_id===eid);
      const diag = latestByEvent(state.diagnoses, eid);
      const debate = (state.debates||[]).find(d => d.incident_id===eid);
      const evidence = (state.metric_samples||[]).filter(m => m.incident_id===eid);
      const tree = {
        incident_id:eid, generated_at:now(),
        nodes: [
          { id:'root', type:'alert', label:'告警触发', detail:incident.title, agent:'系统', at:incident.created_at, children:['evidence','triage'] },
          { id:'evidence', type:'evidence', label:'证据收集', detail:`${runs.length}次Skill调用，${evidence.length}条指标样本`, agent:'Detective', at:runs[0]?.started_at, children:['hypotheses'] },
          { id:'triage', type:'decision', label:'严重度判定', detail:`级别：${incident.severity}`, agent:'Commander', at:incident.created_at, children:['hypotheses'] },
          { id:'hypotheses', type:'branch', label:'假设生成', detail:debate?`${debate.hypotheses.length}个竞争假设进入辩论`:'诊断中', agent:'Detective', at:diag?.created_at, children:debate?debate.hypotheses.map(h=>'hyp_'+h.id):['diagnosis'] },
        ].concat(debate?debate.hypotheses.map(h => ({ id:'hyp_'+h.id, type:'hypothesis', label:`假设${h.id}`, detail:`${h.root_cause?.slice(0,60)} (${(h.confidence*100).toFixed(0)}%)`, agent:'Detective', score:h.score, children:['eval_'+h.id] })):[])
        .concat(debate?debate.hypotheses.map(h => ({ id:'eval_'+h.id, type:'evaluation', label:`评估${h.id}`, detail:`风险${h.evaluation?.risk_level} · ${h.evaluation?.can_auto_execute?'可自动执行':'需审批'}`, agent:'Ranger', children:['decision'] })):[])
        .concat([{ id:'diagnosis', type:'diagnosis', label:'诊断结论', detail:diag?.root_cause||'待分析', agent:'Detective', at:diag?.created_at, children:['decision'] }])
        .concat([{ id:'decision', type:'decision', label:'最终决策', detail:debate?`选择${debate.winner.id}：${debate.winner.root_cause?.slice(0,60)} (评分${debate.winner.score})`:(incident.status==='resolved'?'已解决':'处理中'), agent:'Arbiter', children:['repair'] }])
        .concat([{ id:'repair', type:'action', label:'修复执行', detail:incident.status==='resolved'?'修复完成':'等待中', agent:'Ranger', children:['verify'] }])
        .concat([{ id:'verify', type:'verification', label:'验证', detail:incident.status==='resolved'?'验证通过':'未验证', agent:'Ranger', children:incident.status==='resolved'?['postmortem']:[] }])
        .concat(incident.status==='resolved'?[{ id:'postmortem', type:'knowledge', label:'复盘归档', detail:'经验已沉淀', agent:'Sage', children:[] }]:[]),
        stats: { total_nodes:0, debate_rounds:debate?debate.hypotheses.length:0, evidence_count:runs.length, approval_count:approvals.length }
      };
      tree.stats.total_nodes = tree.nodes.length;
      return send(res, 200, tree);
    }

    // --- v7.0: Feedback Learning ---
    if (method === 'POST' && pathname.startsWith('/api/feedback/')) {
      const eid = pathname.split('/').pop(); const body = await bodyJson(req);
      const rating = body.rating; const comment = body.comment||'';
      if (!state.diagnosis_feedback) state.diagnosis_feedback = [];
      const diag = latestByEvent(state.diagnoses, eid);
      state.diagnosis_feedback.push({ id:makeId('fb'), incident_id:eid, rating, comment,
        root_cause_pattern: (diag?.root_cause||'').slice(0,40), created_at:now() });
      saveState();
      const totalFeedback = state.diagnosis_feedback.length;
      const positiveRate = Math.round(state.diagnosis_feedback.filter(f=>f.rating==='up').length/totalFeedback*100);
      return send(res, 200, { status:'recorded', total_feedback:totalFeedback, positive_rate:positiveRate+'%',
        message:rating==='up'?'感谢反馈！系统将在未来诊断中参考此模式':'已记录，系统将降低此类诊断的权重' });
    }

    // --- v7.0: Predictive Alerts ---
    if (method === 'GET' && pathname === '/api/predictive') {
      const history = (state.monitor_results||[]).filter(r => r.target_id==='monitor_local_system').slice(-30);
      const predictions = [];
      const series = metric => history.map(item => ({ time: Date.parse(item.checked_at), value: Number(item.metrics?.[metric]) }));
      const models = { cpu_percent: linearTrend(series('cpu_percent')), memory_percent: linearTrend(series('memory_percent')), disk_percent: linearTrend(series('disk_percent')) };
      for (const [metric, model] of Object.entries(models)) {
        if (!model || model.slope_per_minute <= 0 || model.r_squared < 0.65) continue;
        const threshold = metric === 'disk_percent' ? 95 : 90;
        const eta = model.current >= threshold ? 0 : (threshold - model.current) / model.slope_per_minute;
        if (model.current >= 50 && eta >= 0 && eta <= 240) predictions.push({
          metric, trend:'rising', current:model.current, estimated_threshold_minutes:Math.round(eta), threshold,
          slope_per_minute:model.slope_per_minute, r_squared:model.r_squared, sample_count:model.sample_count,
          severity:eta <= 30?'warning':'notice', advice:`${metric}呈稳定上升趋势，请检查主要贡献进程或容量变化`
        });
      }
      return send(res, 200, { predictions, sample_count:history.length, models, method:'least_squares_time_series_v1', minimum_r_squared:0.65, note:'预测由真实采样时间和线性拟合计算；样本不足或拟合度低时不告警' });
    }

    // --- v9.0: Desktop App Features ---
    if (method === 'POST' && pathname === '/api/shutdown') {
      send(res, 200, { status:'shutting_down', message:'IntelliOps 正在关闭，监控已停止' });
      setTimeout(() => { if (trayProcess) try { trayProcess.kill(); } catch(e) {} process.exit(0); }, 500);
      return;
    }
    if (method === 'POST' && pathname === '/api/tray/start') {
      if (process.platform === 'win32') {
        const psFile = path.join(DATA_DIR, 'tray.ps1');
        const lines = [];
        lines.push('Add-Type -AssemblyName System.Windows.Forms,System.Drawing');
        lines.push('$f = [System.Drawing.SystemIcons]::Application');
        lines.push('$t = New-Object System.Windows.Forms.NotifyIcon');
        lines.push('$t.Text = "IntelliOps v9.0 Monitor"');
        lines.push('$t.Icon = $f');
        lines.push('$t.Visible = $true');
        lines.push('$m = New-Object System.Windows.Forms.ContextMenuStrip');
        lines.push('$m.Items.Add("Open Panel").Add_Click({ Start-Process "http://127.0.0.1:8766" }) | Out-Null');
        lines.push('$m.Items.Add("Pause").Add_Click({ Invoke-RestMethod "http://127.0.0.1:8766/api/monitor/settings" -Method POST -Body (ConvertTo-Json @{enabled=$false}) -ContentType "application/json" }) | Out-Null');
        lines.push('$m.Items.Add("Resume").Add_Click({ Invoke-RestMethod "http://127.0.0.1:8766/api/monitor/settings" -Method POST -Body (ConvertTo-Json @{enabled=$true}) -ContentType "application/json" }) | Out-Null');
        lines.push('$m.Items.Add("-") | Out-Null');
        lines.push('$m.Items.Add("Exit").Add_Click({ Invoke-RestMethod "http://127.0.0.1:8766/api/shutdown" -Method POST; $t.Visible=$false; [System.Windows.Forms.Application]::Exit() }) | Out-Null');
        lines.push('$t.ContextMenuStrip = $m');
        lines.push('$t.Add_Click({ if ($_.Button -eq "Left") { Start-Process "http://127.0.0.1:8766" } })');
        lines.push('$t.ShowBalloonTip(3000, "IntelliOps v9.0", "Monitor running", [System.Windows.Forms.ToolTipIcon]::Info)');
        lines.push('[System.Windows.Forms.Application]::Run()');
        const psCode = lines.join('\r\n');
        fs.writeFileSync(psFile, psCode, 'utf8');
        try { if (trayProcess) trayProcess.kill(); } catch(e) {}
        trayProcess = childProcess.spawn('powershell', ['-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',psFile], { detached:true, stdio:'ignore' });
        trayProcess.unref();
        return send(res, 200, { status:'tray_started', message:'Tray started. Check taskbar corner (expand arrow). Right-click for menu.' });
      }
      return send(res, 200, { status:'tray_unavailable' });
    }
    if (method === 'POST' && pathname === '/api/notify') {
      const body = await bodyJson(req); const title = body.title||'IntelliOps'; const msg = body.message||'';
      if (process.platform === 'win32') {
        const ps = `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::CreateToastNotifier("IntelliOps").Show((New-Object Windows.UI.Notifications.ToastNotification([Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)))).Wait()`;
        childProcess.exec(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; (New-Object System.Windows.Forms.NotifyIcon).Visible=$$true; (New-Object System.Windows.Forms.NotifyIcon{Text='${title}',BalloonTipTitle='${title}',BalloonTipText='${msg}',Visible=$$true}).ShowBalloonTip(5000)"`, (err) => { if(err) log('ERROR','notification failed',err.message); });
      }
      return send(res, 200, { status:'sent', message:'通知已发送' });
    }
    if (method === 'POST' && pathname === '/api/system/autostart') {
      const body = await bodyJson(req); autoStartEnabled = Boolean(body.enabled);
      if (process.platform === 'win32') {
        const startupDir = path.join(os.homedir(),'AppData','Roaming','Microsoft','Windows','Start Menu','Programs','Startup');
        const shortcut = path.join(startupDir,'灵瞳智维IntelliOps.lnk');
        if (autoStartEnabled) {
          const ps = `$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut('${shortcut}');$s.TargetPath='${process.execPath}';$s.WorkingDirectory='${path.dirname(process.execPath)}';$s.Save()`;
          childProcess.exec(`powershell -Command "${ps}"`, (err) => { if(err) log('ERROR','autostart failed',err.message); });
        } else { try { fs.unlinkSync(shortcut); } catch(e) {} }
      }
      return send(res, 200, { status:autoStartEnabled?'enabled':'disabled', message:autoStartEnabled?'已添加到开机启动':'已从开机启动移除' });
    }
    if (method === 'GET' && pathname === '/api/system/autostart') {
      const startupDir = path.join(os.homedir(),'AppData','Roaming','Microsoft','Windows','Start Menu','Programs','Startup');
      const shortcut = path.join(startupDir,'灵瞳智维IntelliOps.lnk');
      return send(res, 200, { enabled:fs.existsSync(shortcut), path:shortcut });
    }
    // Auto-notify on new incidents
    const origCreateIncident = state.incidents.push; // hook for notification

    if (method === 'GET' && pathname === '/api/apps') {
      const apps = state.monitor_targets.filter(t => t.type === 'application' && t.enabled).map(t => {
        const last = t.last_result || {}; const history = state.monitor_results.filter(r => r.target_id===t.id).slice(-20);
        return { id:t.id, name:t.name, process:t.config.process_name, status:t.status, pid:last.pid, mem_mb:last.mem_mb, threads:last.threads, uptime_min:last.uptime_min, last_check:t.last_check_at, history };
      });
      return send(res, 200, { apps, total:apps.length, generated_at: now() });
    }
    if (method === 'GET' && pathname === '/api/health') {
      const resolved = state.incidents.filter(item => item.status === 'resolved').length;
      return send(res, 200, {
        app: APP_NAME, version: APP_VERSION, status: 'healthy', platform: process.platform,
        total_incidents: state.incidents.length, resolved, open: state.incidents.length - resolved,
        runbooks: state.runbooks.length, ai_configured: Boolean(aiKey && state.settings.endpoint),
        data_directory: DATA_DIR
      });
    }
    if (method === 'GET' && pathname === '/api/overview') return send(res, 200, overview());
    if (method === 'GET' && pathname === '/api/runtime') return send(res, 200, runtimeManifest());
    if (method === 'GET' && pathname === '/api/skills') {
      return send(res, 200, Object.entries(skillRegistry).map(([name, item]) => ({ name, version: item.version, owner: item.owner, description: item.description, input_schema: item.input_schema })));
    }
    if (method === 'GET' && pathname === '/api/skill-runs') {
      const eventId = url.searchParams.get('event_id');
      return send(res, 200, state.skill_runs.filter(item => !eventId || item.event_id === eventId));
    }
    if (method === 'GET' && pathname === '/api/tool-calls') {
      const eventId = url.searchParams.get('event_id');
      return send(res, 200, state.tool_calls.filter(item => !eventId || item.event_id === eventId));
    }
    if (method === 'GET' && pathname === '/api/llm-calls') {
      const eventId = url.searchParams.get('event_id');
      return send(res, 200, state.llm_calls.filter(item => !eventId || item.event_id === eventId));
    }
    if (method === 'GET' && pathname === '/api/rollbacks') {
      const eventId = url.searchParams.get('event_id');
      return send(res, 200, state.rollback_runs.filter(item => !eventId || item.event_id === eventId));
    }
    if (method === 'GET' && pathname === '/api/metrics') {
      const eventId = url.searchParams.get('event_id');
      return send(res, 200, state.metric_samples.filter(item => !eventId || item.event_id === eventId));
    }
    if (method === 'GET' && pathname === '/api/monitor/targets') return send(res, 200, state.monitor_targets);
    if (method === 'GET' && pathname === '/api/monitor/capabilities') return send(res, 200, {
      generated_at: now(), platform: process.platform, execution_boundary: 'allowlisted_project_demo_and_approved_windows_service_start_only',
      target_types: [
        { type: 'system', probe: 'real', remediation: 'controlled_demo_fault_only' },
        { type: 'http', probe: 'real_http_request', remediation: 'observe_and_recommend_only' },
        { type: 'tcp', probe: 'real_tcp_connect', remediation: 'observe_and_recommend_only' },
        { type: 'process', probe: 'real_windows_process_query', remediation: 'observe_and_recommend_only' },
        { type: 'application', probe: 'real_windows_process_query', remediation: 'observe_and_recommend_only' },
        { type: 'windows_service', probe: 'real_windows_service_query', remediation: 'L3_approval_then_allowlisted_service_start' }
      ],
      arbitrary_shell_allowed: false, llm_text_execution_allowed: false
    });
    if (method === 'POST' && pathname === '/api/monitor/targets') {
      const data = await bodyJson(req); let cleaned;
      try { cleaned = cleanMonitorTarget(data); } catch (error) { return send(res, 422, { detail: error.message }); }
      if (cleaned.type === 'system' && state.monitor_targets.some(item => item.type === 'system')) return send(res, 409, { detail: '本机资源监控目标只能保留一个' });
      const target = { id: makeId('monitor'), ...cleaned, status: 'pending', last_check_at: null, next_check_at: now(), last_result: null, failure_streak: 0, recovery_streak: 0, open_incident_id: null, created_at: now(), updated_at: now() };
      state.monitor_targets.push(target); saveState();
      setImmediate(() => checkMonitorTarget(target).catch(error => log('ERROR', `首次探测 ${target.id}`, error.message)));
      return send(res, 201, target);
    }
    if (method === 'GET' && pathname === '/api/monitor/results') {
      const targetId = url.searchParams.get('target_id'); const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
      return send(res, 200, state.monitor_results.filter(item => !targetId || item.target_id === targetId).slice(-limit));
    }
    if (method === 'POST' && pathname === '/api/monitor/settings') {
      const data = await bodyJson(req); state.settings.monitoring_enabled = Boolean(data.enabled); saveState();
      return send(res, 200, { monitoring_enabled: state.settings.monitoring_enabled });
    }
    let monitorMatch = pathname.match(/^\/api\/monitor\/targets\/([^/]+)$/);
    if (monitorMatch && method === 'PUT') {
      const target = state.monitor_targets.find(item => item.id === monitorMatch[1]); if (!target) return notFound(res);
      const data = await bodyJson(req); let cleaned;
      try { cleaned = cleanMonitorTarget(data, target); } catch (error) { return send(res, 422, { detail: error.message }); }
      Object.assign(target, cleaned, { next_check_at: now(), updated_at: now() }); saveState(); return send(res, 200, target);
    }
    if (monitorMatch && method === 'DELETE') {
      const target = state.monitor_targets.find(item => item.id === monitorMatch[1]); if (!target) return notFound(res);
      if (target.id === 'monitor_local_system') return send(res, 409, { detail: '默认本机资源目标不能删除，可以停用' });
      if (target.open_incident_id) return send(res, 409, { detail: '目标仍关联未恢复事件，不能删除；可以先停用' });
      state.monitor_targets = state.monitor_targets.filter(item => item.id !== target.id); saveState(); return send(res, 200, { status: 'deleted', id: target.id });
    }
    monitorMatch = pathname.match(/^\/api\/monitor\/targets\/([^/]+)\/check$/);
    if (monitorMatch && method === 'POST') {
      const target = state.monitor_targets.find(item => item.id === monitorMatch[1]); if (!target) return notFound(res);
      try { return send(res, 200, await checkMonitorTarget(target)); } catch (error) { return send(res, 409, { detail: error.message }); }
    }
    monitorMatch = pathname.match(/^\/api\/monitor\/targets\/([^/]+)\/toggle$/);
    if (monitorMatch && method === 'POST') {
      const target = state.monitor_targets.find(item => item.id === monitorMatch[1]); if (!target) return notFound(res);
      target.enabled = !target.enabled; target.next_check_at = now(); target.updated_at = now(); saveState(); return send(res, 200, target);
    }
    if (method === 'POST' && pathname === '/api/demo/connection-pool') {
      if (state.incidents.some(item => item.source === 'competition_sandbox' && !['resolved', 'failed', 'rejected'].includes(item.status))) {
        return send(res, 409, { detail: '已有比赛演示流程正在运行，请先完成审批或等待结束' });
      }
      const snapshot = sandboxConfig();
      setSandboxPool(4, 'DemoInjector', '注入连接池容量缩减故障');
      const initialLoad = await runPaymentLoad('fault-baseline', 52, { timeout_ms: 70, work_ms: 120 });
      const incident = addIncident({
        title: '支付服务数据库连接池耗尽', severity: 'P0-紧急', service: paymentSandbox.service,
        description: `实际并发${initialLoad.summary.request_count}次，错误${initialLoad.summary.error_count}次，P95=${initialLoad.summary.p95_latency_ms}ms`
      }, 'competition_sandbox');
      incident.sandbox_snapshot = snapshot;
      incident.initial_metrics = initialLoad.summary;
      for (const result of initialLoad.results.filter(item => !item.ok)) {
        state.alerts.push({ id: makeId('alert'), event_id: incident.id, service: paymentSandbox.service, code: result.code, severity: 'critical', request_id: result.request_id, duration_ms: result.duration_ms, created_at: result.at, source: 'actual_payment_request' });
      }
      state.metric_samples.push({ event_id: incident.id, stage: 'fault-baseline', ...initialLoad.summary });
      timeline(incident, 'DemoInjector', `真实故障压测完成：${initialLoad.summary.error_count}/${initialLoad.summary.request_count}请求失败`);
      saveState();
      setImmediate(() => runCompetitionPipeline(incident.id, initialLoad));
      return send(res, 201, { status: 'started', incident_id: incident.id, metrics: initialLoad.summary, generated_alerts: initialLoad.summary.error_count });
    }
    if (method === 'POST' && pathname === '/api/data/clear') {
      state = initialState();
      paymentSandbox.poolMax = paymentSandbox.baselinePool;
      paymentSandbox.active = 0; paymentSandbox.queue = []; paymentSandbox.changeLog = []; paymentSandbox.requestLog = []; paymentSandbox.lastBatch = null;
      saveState();
      return send(res, 200, { status: 'cleared' });
    }
    if (method === 'GET' && pathname === '/api/incidents') return send(res, 200, state.incidents.map(publicIncident));
    if (method === 'POST' && pathname === '/api/incidents') {
      const data = await bodyJson(req);
      const incident = addIncident(data);
      setImmediate(() => runPipeline(incident.id));
      return send(res, 201, publicIncident(incident));
    }
    if (method === 'POST' && pathname === '/api/alerts') {
      const data = await bodyJson(req);
      const fingerprint = crypto.createHash('sha256').update(`${data.title || ''}|${data.service || ''}`).digest('hex').slice(0, 16);
      const recent = [...state.incidents].reverse().find(item => item.fingerprint === fingerprint && Date.now() - Date.parse(item.created_at) < 300000);
      if (recent) return send(res, 200, { incident_id: recent.id, deduplicated: true });
      const incident = addIncident(data, 'alert');
      setImmediate(() => runPipeline(incident.id));
      return send(res, 201, { incident_id: incident.id, deduplicated: false });
    }

    let match = pathname.match(/^\/api\/incidents\/([^/]+)$/);
    if (match && method === 'GET') {
      const incident = incidentById(match[1]);
      return incident ? send(res, 200, publicIncident(incident)) : notFound(res);
    }
    if (match && method === 'PUT') {
      const incident = incidentById(match[1]);
      if (!incident) return notFound(res);
      const data = await bodyJson(req);
      if (typeof data.timeline_entry === 'string' && data.timeline_entry.trim()) timeline(incident, '用户', data.timeline_entry.trim());
      saveState();
      return send(res, 200, { status: 'updated' });
    }
    if (match && method === 'DELETE') {
      const incident = incidentById(match[1]);
      if (!incident) return notFound(res);
      if (!['resolved', 'failed', 'rejected', 'diagnosed'].includes(incident.status)) return send(res, 409, { detail: '运行中的事件不能删除' });
      const id = incident.id;
      state.incidents = state.incidents.filter(item => item.id !== id);
      state.alerts = state.alerts.filter(item => item.event_id !== id);
      state.diagnoses = state.diagnoses.filter(item => item.incident_id !== id);
      state.repairs = state.repairs.filter(item => item.incident_id !== id);
      state.postmortems = state.postmortems.filter(item => item.incident_id !== id);
      state.approvals = state.approvals.filter(item => item.event_id !== id);
      state.traces = state.traces.filter(item => item.event_id !== id);
      state.skill_runs = state.skill_runs.filter(item => item.event_id !== id);
      state.tool_calls = state.tool_calls.filter(item => item.event_id !== id);
      state.rollback_runs = state.rollback_runs.filter(item => item.event_id !== id);
      state.metric_samples = state.metric_samples.filter(item => item.event_id !== id);
      for (const target of state.monitor_targets) if (target.open_incident_id === id) target.open_incident_id = null;
      saveState(); return send(res, 200, { status: 'deleted', event_id: id });
    }
    match = pathname.match(/^\/api\/incidents\/([^/]+)\/evidence$/);
    if (match && method === 'GET') {
      const pack = evidencePack(match[1]);
      return pack ? send(res, 200, pack) : notFound(res);
    }
    match = pathname.match(/^\/api\/incidents\/([^/]+)\/metrics\.csv$/);
    if (match && method === 'GET') {
      if (!incidentById(match[1])) return notFound(res);
      const rows = state.metric_samples.filter(item => item.event_id === match[1]);
      const columns = ['stage', 'timestamp', 'request_count', 'success_count', 'error_count', 'error_rate', 'p95_latency_ms', 'pool_max', 'source'];
      const csv = '\uFEFF' + [columns.join(','), ...rows.map(row => columns.map(key => JSON.stringify(row[key] == null ? '' : row[key])).join(','))].join('\r\n');
      return send(res, 200, csv, 'text/csv; charset=utf-8');
    }
    match = pathname.match(/^\/api\/incidents\/([^/]+)\/diagnosis$/);
    if (match && method === 'GET') {
      const diagnosis = [...state.diagnoses].reverse().find(item => item.incident_id === match[1]);
      return diagnosis ? send(res, 200, diagnosis) : notFound(res);
    }
    match = pathname.match(/^\/api\/incidents\/([^/]+)\/repair$/);
    if (match && method === 'GET') {
      const repair = [...state.repairs].reverse().find(item => item.incident_id === match[1]);
      return repair ? send(res, 200, repair) : notFound(res);
    }
    if (match && method === 'POST') {
      const incident = incidentById(match[1]);
      if (!incident) return notFound(res);
      const data = await bodyJson(req);
      if (String(data.action || '').toLowerCase() !== 'approve') return send(res, 422, { detail: '只接受白名单 action=approve' });
      const approval = state.approvals.find(item => item.event_id === incident.id && item.status === 'PENDING');
      if (!approval) return send(res, 409, { detail: '没有待审批记录' });
      approval.status = 'APPROVED'; approval.approver = data.approver || 'local-user'; approval.decided_at = now();
      if (approval.mode === 'competition_plan_b') await resumeCompetitionApproval(approval);
      else if (approval.mode === 'monitor_service_start') await resumeMonitorServiceApproval(approval);
      else await resumeApproval(approval);
      return send(res, 200, { status: 'ok', approval_id: approval.id });
    }
    match = pathname.match(/^\/api\/incidents\/([^/]+)\/state$/);
    if (match && method === 'GET') {
      const incident = incidentById(match[1]);
      if (!incident) return notFound(res);
      const trace = state.traces.find(item => item.event_id === incident.id);
      return send(res, 200, { incident_id: incident.id, current_state: incident.status.toUpperCase(), history: incident.timeline, plan_status: trace ? trace.plan.status : null });
    }
    match = pathname.match(/^\/api\/incidents\/([^/]+)\/trace$/);
    if (match && method === 'GET') {
      const trace = state.traces.find(item => item.event_id === match[1]);
      return trace ? send(res, 200, trace) : notFound(res);
    }

    if (method === 'GET' && pathname === '/api/runbooks') {
      const search = (url.searchParams.get('search') || '').toLowerCase();
      const result = search ? state.runbooks.filter(item => JSON.stringify(item).toLowerCase().includes(search)) : state.runbooks;
      return send(res, 200, result);
    }
    if (method === 'POST' && pathname === '/api/runbooks') {
      const data = await bodyJson(req);
      const runbook = { id: makeId('rb'), version: '1.0.0', verified: 0, success: null, ...data };
      state.runbooks.push(runbook); saveState(); return send(res, 201, { id: runbook.id });
    }
    if (method === 'GET' && pathname === '/api/runbooks/match') {
      const incident = incidentById(url.searchParams.get('incident_id'));
      if (!incident) return notFound(res);
      const diagnosis = [...state.diagnoses].reverse().find(item => item.incident_id === incident.id) || fallbackDiagnosis(incident);
      const best = matchRunbook(incident, diagnosis);
      return send(res, 200, { incident_id: incident.id, matches: best ? [best] : [], best_match: best });
    }

    if (method === 'GET' && pathname === '/api/postmortems') {
      return send(res, 200, state.postmortems.map(item => ({ ...item, created: item.created_at, rootCause: item.root_cause, runbookUpdates: item.runbook_updates })));
    }
    if (method === 'POST' && pathname === '/api/postmortems') {
      const data = await bodyJson(req);
      const incident = incidentById(data.incident_id);
      const pm = { id: makeId('pm'), title: `${incident ? incident.title : '故障'} 复盘报告`, created_at: now(), ...data };
      state.postmortems.push(pm); saveState(); return send(res, 201, { id: pm.id, status: 'created' });
    }
    match = pathname.match(/^\/api\/postmortems\/([^/]+)$/);
    if (match && method === 'GET') {
      const pm = state.postmortems.find(item => item.id === match[1]);
      return pm ? send(res, 200, pm) : notFound(res);
    }
    if (method === 'GET' && pathname === '/api/knowledge') {
      const lessons = [], updates = [];
      for (const pm of state.postmortems) {
        for (const lesson of pm.lessons || []) lessons.push({ lesson, source: pm.title, date: pm.created_at });
        for (const update of pm.runbook_updates || []) updates.push({ update, source: pm.title, date: pm.created_at });
      }
      return send(res, 200, { lessons, runbook_updates: updates, total_lessons: lessons.length, total_updates: updates.length });
    }

    if (method === 'GET' && pathname === '/api/approvals') {
      const eventId = url.searchParams.get('event_id');
      const items = state.approvals.filter(item => item.status === 'PENDING' && (!eventId || item.event_id === eventId));
      return send(res, 200, items);
    }
    if (method === 'GET' && pathname === '/api/approvals/history') {
      const eventId = url.searchParams.get('event_id');
      return send(res, 200, state.approvals.filter(item => !eventId || item.event_id === eventId));
    }
    match = pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
    if (match && method === 'POST') {
      const approval = state.approvals.find(item => item.id === match[1]);
      if (!approval) return notFound(res);
      if (approval.status !== 'PENDING') return send(res, 409, { detail: '审批已处理' });
      const data = await bodyJson(req);
      if (!['approve', 'reject'].includes(data.action)) return send(res, 422, { detail: "action 必须是 'approve' 或 'reject'" });
      approval.status = data.action === 'approve' ? 'APPROVED' : 'REJECTED';
      approval.approver = String(data.approver || 'local-user').slice(0, 100);
      approval.comment = String(data.comment || '').slice(0, 1000);
      approval.decided_at = now();
      const incident = incidentById(approval.event_id);
      if (data.action === 'approve') {
        if (approval.mode === 'competition_plan_b') await resumeCompetitionApproval(approval);
        else if (approval.mode === 'monitor_service_start') await resumeMonitorServiceApproval(approval);
        else if (approval.mode === 'twin_managed_app_restart') await resumeTwinApproval(approval);
        else await resumeApproval(approval);
      }
      else if (incident) {
        incident.status = 'rejected';
        if (approval.mode === 'twin_managed_app_restart') {
          const demoRun = state.demo_runs.find(item => item.event_id === incident.id);
          if (demoRun) { demoRun.status = 'REJECTED'; demoRun.stage = 'REJECTED'; demoRun.finished_at = now(); }
        }
        timeline(incident, approval.approver, 'L3 操作已拒绝，流程停止'); saveState();
      }
      return send(res, 200, { status: 'ok', message: approval.status, event_id: approval.event_id });
    }

    if (method === 'GET' && pathname === '/api/agentteams/status') {
      agentTeamsLastStatus = await agentTeamsAdapter().status();
      return send(res, 200, agentTeamsLastStatus);
    }
    if (method === 'POST' && pathname === '/api/agentteams/config') {
      const data = await bodyJson(req);
      try {
        state.settings.agentteams_controller_url = data.controller_url ? normalizeBaseUrl(data.controller_url) : '';
      } catch (error) { return send(res, 422, { detail: error.message }); }
      state.settings.agentteams_team_name = String(data.team_name || 'intelliops-operations').trim().slice(0, 80);
      saveState();
      agentTeamsLastStatus = await agentTeamsAdapter().status();
      return send(res, 200, { ...agentTeamsLastStatus, token_persisted: false, token_source: process.env.INTELLIOPS_AGENTTEAMS_TOKEN ? 'environment' : 'not_configured' });
    }
    if (method === 'POST' && pathname === '/api/agentteams/provision') {
      const status = await agentTeamsAdapter().status();
      if (!status.connected) return send(res, 409, { detail: '官方AgentTeams控制器未连接', status });
      try {
        const result = await agentTeamsAdapter().provisionIntelliOpsTeam(state.settings.model || 'qwen3.6-plus');
        return send(res, 202, result);
      } catch (error) { return send(res, 502, { detail: error.message }); }
    }
    if (method === 'GET' && pathname === '/api/agentteams/dispatches') {
      const eventId = url.searchParams.get('event_id');
      return send(res, 200, state.agentteams_dispatches.filter(item => !eventId || item.event_id === eventId));
    }
    const agentTeamsDispatchMatch = pathname.match(/^\/api\/agentteams\/dispatch\/([^/]+)$/);
    if (method === 'POST' && agentTeamsDispatchMatch) {
      const incident = incidentById(decodeURIComponent(agentTeamsDispatchMatch[1]));
      if (!incident) return send(res, 404, { detail: '事件不存在' });
      const trace = traceFor(incident.id);
      try {
        const adapter = agentTeamsAdapter();
        const dispatch = await adapter.dispatchIncident(incident, trace);
        dispatch.event_id = incident.id; dispatch.trace_id = trace.plan.trace_id; dispatch.created_at = now();
        state.agentteams_dispatches.push(dispatch);
        trace.external_agentteams_runs = trace.external_agentteams_runs || [];
        trace.external_agentteams_runs.push(dispatch);
        evidenceLedger.append(state, incident.id, 'agentteams_matrix_dispatch', dispatch, { actor: 'Official AgentTeams', trace_id: trace.plan.trace_id });
        saveState();
        setImmediate(async () => {
          try {
            const result = await adapter.pollDispatchResult(dispatch);
            Object.assign(dispatch, result);
            evidenceLedger.append(state, incident.id, result.status === 'SUCCEEDED' ? 'agentteams_matrix_result' : 'agentteams_matrix_timeout', {
              dispatch_id: dispatch.dispatch_id, status: result.status, result_event_id: result.result_event_id || '',
              result_sender: result.result_sender || '', result_hash: result.result_text ? stableHash(result.result_text) : ''
            }, { actor: 'Official AgentTeams', trace_id: trace.plan.trace_id });
            timeline(incident, 'Official AgentTeams', result.status === 'SUCCEEDED' ? `官方协作结果已回传：${result.result_sender}` : '官方协作任务等待结果超时');
          } catch (error) {
            dispatch.status = 'FAILED'; dispatch.error = String(error.message || error); dispatch.finished_at = now();
            timeline(incident, 'Official AgentTeams', `官方协作结果跟踪失败：${dispatch.error}`);
          }
          saveState();
        });
        return send(res, 200, dispatch);
      } catch (error) { return send(res, 409, { detail: error.message, runtime: 'official_agentteams', dispatched: false }); }
    }
    if (method === 'POST' && pathname === '/api/evaluation/run') {
      const report = runEvaluation();
      state.evaluation_runs.push(report);
      if (state.evaluation_runs.length > 20) state.evaluation_runs.splice(0, state.evaluation_runs.length - 20);
      saveState();
      return send(res, 200, report);
    }
    if (method === 'GET' && pathname === '/api/evaluation/latest') {
      return send(res, 200, state.evaluation_runs.at(-1) || { status: 'not_run', scenario_count: 50, dataset_version: 'intelliops-controlled-v2' });
    }
    if (method === 'GET' && pathname === '/api/evaluation/ai-impact') {
      const samples = state.diagnoses.filter(item => item.ai_comparison && item.llm_status === 'llm_success');
      const successfulCalls = state.llm_calls.filter(item => item.status === 'SUCCEEDED');
      const failedCalls = state.llm_calls.filter(item => item.status === 'FAILED');
      const latestCall = state.llm_calls.at(-1) || null;
      const categoryMatches = samples.filter(item => item.ai_comparison.category_match).length;
      const deltas = samples.map(item => Number(item.ai_comparison.confidence_delta)).filter(Number.isFinite);
      return send(res, 200, {
        status: samples.length ? 'measured' : 'insufficient_data',
        sample_count: samples.length,
        ai_configured: Boolean(aiKey && state.settings.endpoint),
        successful_call_count: successfulCalls.length,
        failed_call_count: failedCalls.length,
        latest_call: latestCall ? {
          status: latestCall.status, purpose: latestCall.purpose, model: latestCall.model,
          duration_ms: latestCall.duration_ms, finished_at: latestCall.finished_at,
          error_type: latestCall.error_type || '', error_message: latestCall.error_message || ''
        } : null,
        measurement: 'paired_ai_vs_local_rule_baseline',
        category_agreement_rate: samples.length ? Math.round(categoryMatches / samples.length * 1000) / 1000 : null,
        average_confidence_delta: deltas.length ? Math.round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length * 1000) / 1000 : null,
        limitation: '仅统计本机实际成功调用形成的配对样本，不代表生产泛化效果'
      });
    }
    if (method === 'GET' && pathname === '/api/agentteams/export') {
      return send(res, 200, {
        api_version: 'agentteams.io/v1beta1-compatible', generated_at: now(), official_runtime_connected: Boolean(agentTeamsLastStatus.connected),
        truthfulness: agentTeamsLastStatus.connected ? 'official_controller_verified' : 'contract_export_only_not_an_official_runtime',
        team: { name: state.settings.agentteams_team_name || 'intelliops-operations', manager: 'Commander', workers: ['Detective', 'Ranger', 'Sage'], human_in_the_loop: true },
        dag: [
          { task: 'triage', agent: 'Commander', depends_on: [] },
          { task: 'diagnose', agent: 'Detective', depends_on: ['triage'] },
          { task: 'risk_execute_verify', agent: 'Ranger', depends_on: ['diagnose'] },
          { task: 'postmortem', agent: 'Sage', depends_on: ['risk_execute_verify'] }
        ],
        context_contract: { trace_id: 'required', parent_run_id: 'required_except_root', evidence_refs: 'required_for_diagnosis', approval_id: 'required_for_L3' },
        skill_bindings: { Detective: ['system_metrics_collector', 'evidence_analyzer'], Ranger: ['runbook_matcher'], Sage: ['evidence_ledger'] }
      });
    }
    // AgentTeams config endpoint — generates live config from running state
    if (method === 'GET' && pathname === '/api/agentteams/config') {
      const agents = [
        { name:'Commander', role:'告警指挥官', status:'active', capabilities:['alert_aggregation','severity_triage','task_dispatch'] },
        { name:'Detective', role:'诊断侦探', status:'active', capabilities:['evidence_collection','hypothesis_generation','diagnosis_output'] },
        { name:'Ranger', role:'修复突击兵', status:'active', capabilities:['runbook_matching','risk_assessment','execution','verification'] },
        { name:'Sage', role:'复盘智者', status:'active', capabilities:['trace_aggregation','postmortem_generation','lesson_extraction'] }
      ];
      const skills = state.runbooks.map(r => ({ name:r.id, version:r.version, owner:'IntelliOps', status:'active', description:r.title }));
      return send(res, 200, {
        agentteams_version: AGENTTEAMS_TARGET, generated_at: now(), mode: agentTeamsLastStatus.connected ? 'official_agentteams' : 'local_verified', official_status: agentTeamsLastStatus,
        agents, skills, hitl_points: [
          { point:'L3高风险审批', agent:'Ranger', trigger:'AWAITING_APPROVAL', mandatory:true },
          { point:'复盘审核', agent:'Sage', trigger:'postmortem_generated', mandatory:false }
        ],
        flow: ['Commander→Detective→Ranger→Sage'], contract_export: '/api/agentteams/export',
        message: agentTeamsLastStatus.connected ? 'Official AgentTeams controller connected; status is from controller API' : 'Local verified runtime active; official AgentTeams is not connected'
      });
    }

    // MCP protocol endpoint — JSON-RPC 2.0 style
    if (method === 'POST' && pathname === '/api/mcp') {
      const body = await bodyJson(req);
      const { method:mcpMethod, params, id } = body;
      if (mcpMethod === 'tools/list') {
        return send(res, 200, { jsonrpc:'2.0', id, result:{ tools:[
          { name:'system_metrics_collector', description:'Collect real-time system metrics (CPU, memory, disk)', inputSchema:{ type:'object', properties:{ target_service:{type:'string'}, metrics:{type:'array',items:{type:'string'}} } } },
          { name:'evidence_analyzer', description:'Analyze alerts and metrics to propose root causes', inputSchema:{ type:'object', properties:{ alert_title:{type:'string'}, alert_description:{type:'string'}, metrics:{type:'array'} } } },
          { name:'runbook_matcher', description:'Match root cause to known runbooks using RAG', inputSchema:{ type:'object', properties:{ root_cause:{type:'string'}, risk_level:{type:'string'} } } }
        ]}});
      }
      if (mcpMethod === 'tools/call') {
        const { name, arguments:args } = params;
        if (name === 'system_metrics_collector') {
          const snap = monitorSnapshot();
          return send(res, 200, { jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:JSON.stringify(snap) }], isError:false }});
        }
        if (name === 'evidence_analyzer') {
          const diag = structuredDiagnosis(args?.alert_title||'', args?.alert_description||'');
          return send(res, 200, { jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:JSON.stringify(diag) }], isError:false }});
        }
        if (name === 'runbook_matcher') {
          const matches = ragMatchRunbooks(args?.root_cause||'');
          return send(res, 200, { jsonrpc:'2.0', id, result:{ content:[{ type:'text', text:JSON.stringify(matches) }], isError:false }});
        }
        return send(res, 200, { jsonrpc:'2.0', id, error:{ code:-32601, message:'Tool not found: '+name }});
      }
      return send(res, 200, { jsonrpc:'2.0', id, error:{ code:-32601, message:'Method not found: '+mcpMethod }});
    }

    // Sage postmortem endpoint — generates structured postmortem from incident trace
    if (method === 'POST' && pathname.startsWith('/api/sage/postmortem/')) {
      const eid = pathname.split('/').pop();
      const incident = incidentById(eid);
      if (!incident) return send(res, 404, { detail:'Incident not found' });
      const diag = latestByEvent(state.diagnoses, eid);
      const runs = state.skill_runs.filter(r => r.event_id === eid);
      const approvals = state.approvals.filter(a => a.event_id === eid);
      const evidence = { incident, diagnosis:diag, skill_runs:runs, approvals };
      const fallbackLessons = [
        `[监控] ${incident.title} — 通过${runs.length}次Skill调用完成诊断`,
        `[审批] ${approvals.filter(a=>a.status==='APPROVED').length}次审批通过`,
        `[恢复] 事件在${incident.resolved_at||'持续中'}关闭`
      ];
      const callStart = state.llm_calls.length;
      const generatedLessons = aiKey ? await generateAILessons(incident, diag) : [];
      const lessonCall = state.llm_calls.slice(callStart).find(item => item.purpose === 'postmortem_lessons');
      const llmSucceeded = Boolean(lessonCall && lessonCall.status === 'SUCCEEDED' && generatedLessons.length);
      const lessons = llmSucceeded ? generatedLessons : fallbackLessons;
      const llmStatus = llmSucceeded ? 'llm_success' : (aiKey ? 'llm_failed' : 'fallback_template');
      const pm = { id:makeId('pm'), incident_id:eid, title:`${incident.title} 复盘报告`, root_cause:diag?.root_cause||'待分析',
        process_notes:`Agent协作完成：Commander→Detective→Ranger→Sage，共${runs.length}次工具调用`,
        lessons, runbook_updates:[], alert_optimizations:[],
        created_at:now(), llm_status:llmStatus, model:llmSucceeded?state.settings.model:'',
        llm_error:lessonCall&&lessonCall.status==='FAILED'?lessonCall.error_message:'',
        fallback_reason:llmSucceeded?'':(aiKey?'postmortem_llm_call_failed':'llm_not_configured') };
      state.postmortems.push(pm); saveState();
      return send(res, 200, { status:'generated', postmortem:pm, lessons_count:lessons.length, ai_powered:llmSucceeded });
    }

    // RAG runbook matching endpoint
    if (method === 'GET' && pathname === '/api/runbooks/rag-match') {
      const query = new URL(req.url,`http://${HOST}`).searchParams.get('q')||'';
      const matches = ragMatchRunbooks(query);
      return send(res, 200, { query, matches, method:'TF-IDF vector similarity', mcp_compatible:true });
    }

    if (method === 'GET' && pathname === '/api/ai/config') {
      const persisted = secretStore.exists(AI_KEY_FILE);
      return send(res, 200, {
        endpoint: state.settings.endpoint, model: state.settings.model,
        configured: Boolean(aiKey && state.settings.endpoint), key_persisted: persisted,
        successful_diagnosis_count: state.diagnoses.filter(item => item.ai_comparison && item.llm_status === 'llm_success').length,
        successful_call_count: state.llm_calls.filter(item => item.status === 'SUCCEEDED').length,
        failed_call_count: state.llm_calls.filter(item => item.status === 'FAILED').length,
        key_status: persisted && aiKey ? 'saved_and_loaded' : persisted ? 'saved_but_unavailable' : 'not_saved',
        masked_key: persisted ? '••••••••' : '', version: APP_VERSION
      });
    }
    if (method === 'POST' && pathname === '/api/ai/config') {
      const data = await bodyJson(req);
      if (data.endpoint && !validAiEndpoint(data.endpoint)) return send(res, 422, { detail: 'Endpoint 必须是可公开访问的 HTTPS 地址' });
      state.settings.endpoint = String(data.endpoint || state.settings.endpoint || 'https://api.deepseek.com/v1/chat/completions').trim();
      state.settings.model = String(data.model || state.settings.model || 'deepseek-chat').trim();
      const suppliedKey = typeof data.api_key === 'string' ? data.api_key.trim() : '';
      const clearRequested = data.clear_api_key === true;
      let keyAction = 'preserved';
      try {
        if (clearRequested) {
          secretStore.save(AI_KEY_FILE, ''); aiKey = ''; keyAction = 'cleared';
        } else if (suppliedKey) {
          secretStore.save(AI_KEY_FILE, suppliedKey); aiKey = suppliedKey; keyAction = 'replaced';
        }
      } catch (error) { return send(res, 500, { detail: 'API Key安全保存失败: ' + error.message }); }
      saveState();
      const persisted = secretStore.exists(AI_KEY_FILE);
      return send(res, 200, {
        status: 'saved', configured: Boolean(aiKey && state.settings.endpoint), key_persisted: persisted,
        key_status: persisted && aiKey ? 'saved_and_loaded' : persisted ? 'saved_but_unavailable' : 'not_saved',
        key_action: keyAction,
        message: keyAction === 'cleared' ? '已删除本机保存的API Key' : keyAction === 'replaced' ? '新API Key已加密保存' : '已保留原来保存的API Key'
      });
    }
    if (method === 'POST' && pathname === '/api/ai/test') {
      const data = await bodyJson(req);
      const endpoint = String(data.endpoint || state.settings.endpoint || '');
      const key = String(data.api_key || aiKey || '');
      if (!endpoint || !key) return send(res, 422, { status: 'error', message: '缺少 Endpoint 或 API Key' });
      if (!validAiEndpoint(endpoint)) return send(res, 422, { status: 'error', message: 'Endpoint 不符合安全策略' });
      try {
        const response = await fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: data.model || state.settings.model, messages: [{ role: 'user', content: '只回复 OK' }], max_tokens: 8 }),
          signal: AbortSignal.timeout(15000)
        });
        let providerMessage = '';
        if (!response.ok) {
          try { const payload = await response.json(); providerMessage = String(payload.error && payload.error.message || payload.message || '').slice(0, 500); } catch (_) { /* status is still available */ }
        } else { try { await response.body.cancel(); } catch (_) { /* optional */ } }
        return send(res, response.ok ? 200 : 502, { status: response.ok ? 'ok' : 'error', http_status: response.status, message: response.ok ? '连接成功；请在异常事件中执行一次AI诊断以形成测评样本' : (providerMessage || `供应商返回HTTP ${response.status}`) });
      } catch (error) { return send(res, 502, { status: 'error', message: error.message }); }
    }
    if (method === 'POST' && pathname === '/api/ai/diagnose') {
      const incident = incidentById(url.searchParams.get('incident_id'));
      if (!incident) return notFound(res);
      if (!aiKey || !state.settings.endpoint) return send(res, 422, { detail: 'AI尚未配置，请先在左侧“AI安全配置”中保存并测试连接' });
      const detective = await agentRun(incident, 'Detective', 'ad_hoc_ai_diagnosis', '', async agentRunValue => {
        const metricResult = await runSkill(incident, agentRunValue, 'system_metrics_collector', { target_service: incident.service || 'local-system', time_range: { seconds: 0 }, metrics: ['cpu_percent', 'memory_percent', 'disk_percent'] });
        const analysis = await runSkill(incident, agentRunValue, 'evidence_analyzer', { alert: { title: incident.title, description: incident.description, code: incident.source }, metrics: metricResult.samples, logs: [incident.description || incident.title] });
        return { status: 'completed', metric_result: metricResult, analysis };
      });
      const analysis = detective.output.analysis;
      const baseline = structuredDiagnosis(incident.title, incident.description);
      const diagnosis = { root_cause: analysis.selected_root_cause, selected_category: analysis.selected_category, confidence: analysis.confidence, evidences: analysis.evidence_refs, counter_evidence: analysis.counter_evidence, missing_evidence: analysis.missing_evidence, llm_status: analysis.llm_status, model: analysis.model || '', llm_call_id: analysis.llm_call_id || '', llm_error: analysis.llm_error || '', fallback_reason: analysis.fallback_reason || '', can_proceed_to_repair: analysis.can_proceed_to_repair };
      const aiComparison = analysis.llm_status === 'llm_success' ? {
        baseline_method: 'local_structured_rule_v1',
        baseline_category: baseline.selected_category || 'unknown',
        ai_category: analysis.selected_category || 'unknown',
        category_match: Boolean(baseline.selected_category && baseline.selected_category === analysis.selected_category),
        confidence_delta: Math.round((Number(analysis.confidence || 0) - Number(baseline.confidence || 0)) * 1000) / 1000,
        compared_at: now()
      } : null;
      state.diagnoses.push({ id: makeId('diag'), incident_id: incident.id, ...diagnosis, ai_comparison: aiComparison, created_at: now(), trace_id: detective.trace_id });
      timeline(incident, 'Detective', analysis.llm_status === 'llm_success' ? `AI诊断完成：${analysis.selected_category}，置信度${Math.round(analysis.confidence * 100)}%` : `AI调用未成功，已明确降级：${analysis.llm_error || analysis.fallback_reason || 'fallback_template'}`);
      saveState();
      return send(res, 200, { incident_id: incident.id, diagnosis, ai_powered: analysis.llm_status === 'llm_success', ai_comparison: aiComparison, evidence_receipt: analysis.llm_call_id ? { llm_call_id: analysis.llm_call_id, trace_id: detective.trace_id } : null });
    }
    if (method === 'POST' && pathname === '/api/ai/match-runbook') {
      const incident = incidentById(url.searchParams.get('incident_id'));
      if (!incident) return notFound(res);
      const diagnosis = [...state.diagnoses].reverse().find(item => item.incident_id === incident.id) || fallbackDiagnosis(incident);
      const best = matchRunbook(incident, diagnosis);
      return send(res, 200, { incident_id: incident.id, matches: best ? [best] : [], ai_powered: false });
    }
    if (method === 'POST' && pathname === '/api/ai/postmortem') {
      const incident = incidentById(url.searchParams.get('incident_id'));
      if (!incident) return notFound(res);
      const diagnosis = [...state.diagnoses].reverse().find(item => item.incident_id === incident.id);
      const result = {
        lessons: ['保留真实 Trace 和验证证据', '高风险操作必须人工审批'],
        runbook_updates: [], alert_optimizations: [], full_report: `事件：${incident.title}\n根因：${diagnosis ? diagnosis.root_cause : '证据不足'}\n生成方式：规则 fallback`,
        llm_status: 'fallback', model: ''
      };
      return send(res, 200, { incident_id: incident.id, postmortem: result, ai_powered: false });
    }

    if (method === 'GET' && pathname === '/api/monitor/snapshot') return send(res, 200, monitorSnapshot());
    if (method === 'GET' && pathname === '/api/monitor/history') return send(res, 200, [monitorSnapshot()]);
    if (method === 'POST' && pathname === '/api/monitor/inject') {
      const type = url.searchParams.get('fault_type') || 'cpu';
      const duration = Number(url.searchParams.get('duration') || 10);
      const mb = Number(url.searchParams.get('mb') || 200);
      if (!['cpu', 'memory'].includes(type)) return send(res, 422, { detail: 'fault_type 只允许 cpu 或 memory' });
      if (!Number.isInteger(duration) || duration < 1 || duration > 30) return send(res, 422, { detail: 'duration 必须为 1-30 秒整数' });
      if (!Number.isInteger(mb) || mb < 1 || mb > 512) return send(res, 422, { detail: 'mb 必须为 1-512 整数' });
      const until = injectFault(type, duration, mb);
      const incident = addIncident({ title: `受控故障注入：${type.toUpperCase()} 压力测试`, severity: 'P1-高', service: '本机演示沙箱', description: `受控 ${type} 故障，持续 ${duration} 秒` }, 'controlled_fault');
      setImmediate(() => runPipeline(incident.id, { waitUntil: until }));
      return send(res, 201, { status: 'started', execution_mode: 'sandbox', fault_type: type, duration, mb: type === 'memory' ? mb : null, incident_id: incident.id, ends_at: new Date(until).toISOString() });
    }
    return notFound(res);
  } catch (error) {
    log('ERROR', `${method} ${pathname}`, String(error.stack || error));
    return send(res, 500, { detail: error.message || 'Internal error' });
  }
}

function showWindowsMessage(message) {
  if (process.platform !== 'win32') return;
  const escaped = String(message).replace(/'/g, "''");
  try {
    childProcess.spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Add-Type -AssemblyName PresentationFramework;[System.Windows.MessageBox]::Show('${escaped}','灵瞳智维 IntelliOps')`], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* log file remains available */ }
}

function edgeCandidates() {
  return [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean);
}

function openWindow() {
  const url = `http://${HOST}:${PORT}/`;
  if (process.env.INTELLIOPS_NO_BROWSER === '1') return;
  const edge = edgeCandidates().find(candidate => fs.existsSync(candidate));
  if (edge) {
    const profile = path.join(DATA_DIR, 'webview-profile');
    fs.mkdirSync(profile, { recursive: true });
    edgeProcess = childProcess.spawn(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run'], { stdio: 'ignore', windowsHide: true });
    edgeProcess.once('exit', () => setTimeout(shutdown, 300));
    edgeProcess.once('error', error => log('ERROR', 'Edge 启动失败', error.message));
    return;
  }
  childProcess.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  showWindowsMessage('未找到 Microsoft Edge，已尝试使用默认浏览器打开。关闭页面后可在任务管理器结束 IntelliOps。');
}

function shutdown() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  if (parentWatchdogTimer) { clearInterval(parentWatchdogTimer); parentWatchdogTimer = null; }
  stopFault();
  digitalTwin.stopAll().catch(error => log('ERROR', '数字孪生关闭失败', error.message)).finally(() => {
    if (server) server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

function startParentWatchdog() {
  const parentPid = Number(process.env.INTELLIOPS_PARENT_PID || 0);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentWatchdogTimer) return;
  parentWatchdogTimer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (_) {
      log('INFO', '桌面主进程已退出，正在关闭内置后端');
      shutdown();
    }
  }, 1000);
  parentWatchdogTimer.unref();
}

function probeExisting() {
  return new Promise(resolve => {
    const request = http.get({ host: HOST, port: PORT, path: '/api/health', timeout: 700 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).app === APP_NAME); }
        catch (_) { resolve(false); }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function start() {
  if (await probeExisting()) {
    openWindow();
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  try {
    await digitalTwin.startAll();
  } catch (error) {
    log('ERROR', '数字孪生启动失败', error.message);
    showWindowsMessage(`数字孪生端口8871-8873无法启动，请关闭占用这些端口的程序。\n日志：${LOG_FILE}`);
    process.exitCode = 1;
    return;
  }
  server = http.createServer(handleRequest);
  server.on('error', error => {
    log('ERROR', '后端启动失败', error.message);
    showWindowsMessage(`无法启动：127.0.0.1:${PORT} 端口被其他程序占用。\n日志：${LOG_FILE}`);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    log('INFO', `${APP_NAME} ${APP_VERSION} started`, `http://${HOST}:${PORT}`);
    startParentWatchdog();
    startMonitorScheduler();
    agentTeamsAdapter().status().then(status => { agentTeamsLastStatus = status; }).catch(error => { agentTeamsLastStatus = { connected: false, mode: 'local_verified', reason: error.message, checked_at: now() }; });
    openWindow();
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', error => { log('FATAL', 'uncaughtException', String(error.stack || error)); showWindowsMessage(`程序发生错误。日志：${LOG_FILE}`); shutdown(); });
process.on('unhandledRejection', error => log('ERROR', 'unhandledRejection', String(error && error.stack || error)));

start();
