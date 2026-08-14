(function () {
  'use strict';

  window.evaluationView = function () {
    document.getElementById('pageSub').textContent = '50条非重复受控案例，包含35条留出/盲测样本；结果不代表生产泛化率';
    document.getElementById('content').innerHTML = '<div class="empty spinner">读取评测报告…</div>';
    Promise.all([req('/evaluation/latest'), req('/evaluation/ai-impact')]).then(function (values) {
      var r = values[0], impact = values[1];
      if (page !== 'evaluation') return;
      if (r.status === 'not_run') {
        document.getElementById('content').innerHTML = '<div class="notice">尚未运行评测。评测包含参考集、留出集和未知类别，不会把受控数据冒充生产准确率。</div><div class="card empty section"><button class="primary" onclick="runEvaluationNow()">运行50条评测</button></div>';
        return;
      }
      var m = r.metrics || {}, h = (r.split_metrics && r.split_metrics.holdout) || {}, audit = r.dataset_audit || {};
      document.getElementById('content').innerHTML =
        '<div class="notice"><b>真实性说明</b>：受控离线回归集；精确重复样本 ' + esc(audit.exact_duplicate_count || 0) + ' 条，不代表未知生产故障泛化能力。</div>' +
        '<div class="grid section">' + card('总场景', r.scenario_count, 'cyan', r.dataset_version) + card('留出集诊断', ((h.diagnosis_accuracy || 0) * 100).toFixed(1) + '%', 'green', (audit.holdout_count || 0) + '条') + card('拒答准确率', ((m.abstention_accuracy || 0) * 100).toFixed(1) + '%', 'purple', '未知/证据不足') + card('危险自动执行', m.unsafe_automatic_execution_count || 0, 'orange', '目标为0') + '</div>' +
        '<div class="grid section">' + card('整体诊断率', ((m.diagnosis_accuracy || 0) * 100).toFixed(1) + '%', 'cyan', '逐案例计算') + card('Runbook率', ((m.runbook_accuracy || 0) * 100).toFixed(1) + '%', 'green', '包含no_match') + card('安全决策率', ((m.safety_decision_accuracy || 0) * 100).toFixed(1) + '%', 'purple', '风险与降级策略') + card('P95耗时', (m.p95_case_duration_ms || 0) + ' ms', 'orange', '本机离线评测') + '</div>' +
        '<div class="card section"><h3>AI 实际贡献度量</h3>' + (impact.status === 'measured' ? '<div class="grid">' + card('配对样本', impact.sample_count, 'cyan', '真实成功调用') + card('类别一致率', (impact.category_agreement_rate * 100).toFixed(1) + '%', 'purple', 'AI 对比本地规则') + card('平均置信度差', impact.average_confidence_delta, 'orange', 'AI减基线') + '</div>' : '<div class="empty">尚无成功的 AI 配对样本，暂不声称 AI 带来提升。</div>') + '<p class="sub">' + esc(impact.limitation) + '</p></div>' +
        '<div class="actions section"><button class="primary" onclick="runEvaluationNow()">重新运行</button></div>';
    }).catch(function (error) { document.getElementById('content').innerHTML = '<div class="notice error">评测报告加载失败：' + esc(error.message) + '</div>'; });
  };

  window.runEvaluationNow = async function () {
    document.getElementById('content').innerHTML = '<div class="empty spinner">正在逐条运行50个非重复场景…</div>';
    try { await req('/evaluation/run', { method: 'POST' }); evaluationView(); }
    catch (error) { document.getElementById('content').innerHTML = '<div class="notice error">' + esc(error.message) + '</div>'; }
  };

  window.trace = async function () {
    var requestedId = selected;
    document.getElementById('pageSub').textContent = '本地Agent、Skill、工具、LLM、审批、证据链和官方AgentTeams任务统一追踪';
    var incident = (cache.incidents || []).find(function (item) { return item.id === selected; });
    if (!incident) { document.getElementById('content').innerHTML = '<div class="empty">暂无可查看事件</div>'; return; }
    document.getElementById('content').innerHTML = '<div class="actions">' + chooser() + '<button onclick="downloadEvidence()">导出证据包</button></div><div id="traceBody" class="section"><div class="empty spinner">读取Trace与运行证据…</div></div>';
    try {
      var e = await req('/incidents/' + encodeURIComponent(requestedId) + '/evidence');
      if (page !== 'trace' || selected !== requestedId) return;
      var t = e['agent-trace.json'], runs = t ? t.agent_runs : [], skills = e['skill-runs.json'] || [], tools = e['tool-calls.json'] || [], llm = e['llm-calls.json'] || [], external = e['agentteams-dispatches.json'] || [];
      var integrity = e.manifest && e.manifest.ledger_verification || {};
      var html = '<div class="grid">' + card('Trace状态', t ? t.plan.status : '—', 'cyan', t ? t.plan.trace_id : '') + card('本地Agent Runs', runs.length, 'purple', '可审计状态机') + card('Skill / Tool', skills.length + ' / ' + tools.length, 'green', 'Schema与输入哈希') + card('官方任务', external.length, 'orange', external.at(-1) ? external.at(-1).status : '未派发') + '</div>';
      html += '<div class="grid2 section"><div class="card"><h3>Agent任务链</h3><div class="timeline">' + runs.map(function (r) { return '<div class="tl"><b>' + esc(r.agent_name) + '</b> ' + badge(r.status) + '<div>' + esc(r.task_type) + ' · ' + esc(r.duration_ms) + 'ms</div><div class="mono muted">run=' + esc(r.agent_run_id) + '<br>parent=' + esc(r.parent_run_id || 'Human') + '</div></div>'; }).join('') + '</div></div>';
      html += '<div class="card"><h3>官方AgentTeams协作</h3>' + (external.length ? external.map(function (d) { return '<div class="tl"><b>' + esc(d.team_name) + '</b> ' + badge(d.status) + '<div>' + esc(d.transport) + ' · ' + fmt(d.sent_at) + '</div><div class="mono muted">event=' + esc(d.matrix_event_id || '') + '</div>' + (d.result_text ? '<p>' + esc(d.result_text).slice(0, 1200) + '</p>' : '<p class="sub">官方Team正在异步处理或尚未返回。</p>') + '</div>'; }).join('') : '<div class="empty">本事件尚未派发到官方Team</div>') + '</div></div>';
      html += '<div class="grid2 section"><div class="card"><h3>AI调用回执</h3>' + (llm.length ? llm.map(function (c) { return '<p><b>' + esc(c.purpose) + '</b> ' + badge(c.status) + '<br><span class="sub">' + esc(c.model) + ' · ' + esc(c.duration_ms) + 'ms · Token ' + esc(c.usage ? c.usage.total_tokens : '供应商未返回') + '</span></p>'; }).join('') : '<div class="empty">未调用外部LLM，规则结果不会标记成AI成功</div>') + '</div><div class="card"><h3>证据链</h3><p>' + badge(integrity.valid ? 'SUCCEEDED' : 'FAILED') + '</p><p>校验记录：' + esc(integrity.checked || 0) + '</p></div></div>';
      html += '<div class="card section"><h3>Skill结构验证</h3><table class="table"><thead><tr><th>Skill</th><th>状态</th><th>Schema</th><th>耗时</th><th>输入哈希</th></tr></thead><tbody>' + skills.map(function (s) { return '<tr><td>' + esc(s.skill_name) + '@' + esc(s.skill_version) + '</td><td>' + badge(s.status) + '</td><td>' + badge(s.schema_validated ? 'SUCCEEDED' : 'FAILED') + '</td><td>' + esc(s.duration_ms) + 'ms</td><td class="mono">' + esc((s.input_hash || '').slice(0, 16)) + '…</td></tr>'; }).join('') + '</tbody></table></div>';
      safeElement('traceBody').innerHTML = html;
    } catch (error) { safeElement('traceBody').innerHTML = '<div class="notice error">' + esc(error.message) + '</div>'; }
  };

  window.agentteamsView = async function () {
    document.getElementById('pageSub').textContent = '官方AgentTeams v1.2.2：Controller、Team、Worker和Matrix异步任务均来自真实运行时';
    document.getElementById('content').innerHTML = '<div class="empty spinner">检查官方运行时…</div>';
    try {
      var values = await Promise.all([req('/agentteams/status'), req('/agentteams/config'), req('/agentteams/dispatches')]);
      if (page !== 'agentteams') return;
      var s = values[0], c = values[1], dispatches = values[2] || [];
      document.getElementById('content').innerHTML = '<div class="notice ' + (s.connected ? 'success' : '') + '"><b>' + (s.connected ? '已连接官方运行时' : '未连接官方运行时') + '</b><br>' + (s.connected ? 'Controller、Team和Worker状态来自官方API；任务通过临时Matrix会话异步派发。' : '当前使用本地可验证编排，不冒充官方运行实例。') + '</div>' +
        '<div class="grid section">' + card('运行模式', s.mode, s.connected ? 'green' : 'orange', s.evidence_level || s.reason) + card('Workers', s.cluster && s.cluster.totalWorkers || 0, 'green', '官方统计') + card('Teams', s.cluster && s.cluster.totalTeams || 0, 'purple', '官方统计') + card('派发通道', s.task_dispatch_ready ? 'READY' : 'NOT READY', s.task_dispatch_ready ? 'green' : 'orange', s.task_dispatch_reason || '临时会话') + '</div>' +
        '<div class="actions section">' + (selected ? '<button class="primary" onclick="dispatchAgentTeams()">派发当前事件到官方Team</button>' : '') + '</div>' +
        '<div class="card section"><h3>最近官方任务</h3>' + (dispatches.length ? dispatches.slice().reverse().slice(0, 10).map(function (d) { return '<div class="tl"><b>' + esc(d.event_id) + '</b> ' + badge(d.status) + '<div>' + esc(d.team_name) + ' · ' + fmt(d.sent_at) + '</div>' + (d.result_text ? '<p>' + esc(d.result_text).slice(0, 800) + '</p>' : '<p class="sub">异步处理中，可离开页面后再回来查看。</p>') + '</div>'; }).join('') : '<div class="empty">尚无官方任务</div>') + '</div><details class="card section"><summary>运行态契约</summary><pre>' + esc(JSON.stringify(c, null, 2)) + '</pre></details>';
    } catch (error) { document.getElementById('content').innerHTML = '<div class="notice error">AgentTeams状态读取失败：' + esc(error.message) + '</div>'; }
  };

  window.dispatchAgentTeams = async function () {
    if (!selected) return toast('请先选择事件');
    try { var result = await req('/agentteams/dispatch/' + encodeURIComponent(selected), { method: 'POST' }); toast('已异步派发：' + result.status); agentteamsView(); }
    catch (error) { toast(error.message); }
  };

  window.predictView = async function () {
    document.getElementById('pageSub').textContent = '真实时间序列预测：显示斜率、拟合度、样本跨度和预计到阈值时间';
    document.getElementById('content').innerHTML = '<div class="empty spinner">分析真实采样趋势…</div>';
    try {
      var d = await req('/predictive');
      if (page !== 'predict') return;
      var html = '<div class="notice"><b>预测方法</b>：' + esc(d.method) + '；最低拟合度 R²=' + esc(d.minimum_r_squared) + '。样本不足或趋势不稳定时主动拒绝预测。</div>';
      if (d.predictions.length) {
        html += '<div class="grid section">' + d.predictions.map(function (p) { return '<div class="card node run"><b>' + esc(p.metric) + '</b><p>当前 ' + esc(p.current) + '% · 每分钟 ' + esc(p.slope_per_minute) + ' 个百分点</p><p>R²=' + esc(p.r_squared) + ' · ' + esc(p.sample_count) + '个样本 · 预计' + esc(p.estimated_threshold_minutes) + '分钟到' + esc(p.threshold) + '%</p><p class="sub">' + esc(p.advice) + '</p></div>'; }).join('') + '</div>';
      } else {
        html += '<div class="card empty section"><p>当前没有可信的预测性告警</p><p class="sub">这可能表示趋势稳定，也可能表示样本数量或拟合度不足；系统不会强行给出结论。</p></div>';
      }
      html += '<details class="card section"><summary>查看各指标模型</summary><pre>' + esc(JSON.stringify(d.models, null, 2)) + '</pre></details>';
      document.getElementById('content').innerHTML = html;
    } catch (error) { document.getElementById('content').innerHTML = '<div class="notice error">' + esc(error.message) + '</div>'; }
  };

  var originalDebateView = window.debateView;
  window.debateView = function () {
    originalDebateView();
    document.getElementById('pageSub').textContent = '三个可证伪假设在本机生成和仲裁；默认不向外部LLM发送事件数据';
  };

  var oldRuntimeView = window.runtimeView;
  window.runtimeView = function () {
    oldRuntimeView();
    var label = document.querySelector('.side .sub');
    if (label) label.textContent = 'IntelliOps Desktop v15.0';
  };

  window.__INTELLIOPS_COMPETITION_V15__ = true;
  var versionLabel = document.querySelector('.side .sub');
  if (versionLabel) versionLabel.textContent = 'IntelliOps Desktop v15.0';
  document.querySelectorAll('.runtime').forEach(function (node) {
    if (node.textContent.indexOf('AI 配置') >= 0) node.firstElementChild.textContent = 'AI 安全配置';
    if (node.textContent.indexOf('桌面模式') >= 0) node.firstElementChild.textContent = '桌面控制';
  });

  window.testNotify = async function () {
    try {
      await req('/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'IntelliOps v15.0', message: '测试通知：本机监控服务运行正常' }) });
      toast('通知已发送');
    } catch (error) { toast(error.message); }
  };
}());
