(function () {
  'use strict';

  var diagnosing = false;
  var diagnosisResult = null;

  function sourceName(source) {
    return source === 'monitor' ? '真实监控' : source === 'competition_sandbox' ? '隔离演练' : source === 'digital_twin' ? '数字孪生' : source;
  }

  function diagnosisPanel() {
    if (diagnosing) return '<div class="notice section spinner"><b>Detective 正在执行AI诊断</b><br>正在采集指标、调用模型并验证结构化输出，请勿重复点击。</div>';
    if (!diagnosisResult) return '<div id="incidentAiPanel" class="card empty section">选择事件后点击“AI诊断”，结果会在这里显示并写入Trace与测评样本。</div>';
    var d = diagnosisResult.diagnosis || {};
    if (!diagnosisResult.ai_powered) return '<div id="incidentAiPanel" class="notice error section"><b>AI调用未成功，未计入成功样本</b><br>' + esc(d.llm_error || d.fallback_reason || '已使用模板降级') + '<br><span class="sub">降级结果不会冒充AI诊断。</span></div>';
    return '<div id="incidentAiPanel" class="card section"><div class="statusline"><h3 style="margin:0">AI诊断结果</h3>' + badge('SUCCEEDED') + '</div>' +
      '<div class="grid section">' + card('根因类别', d.selected_category || 'unknown', 'cyan', d.model || '') + card('置信度', Math.round(Number(d.confidence || 0) * 100) + '%', 'green', '模型原始置信度') + card('证据引用', (d.evidences || []).length, 'purple', '仅引用本次输入证据') + card('自动修复资格', d.can_proceed_to_repair ? '满足诊断门槛' : '不满足', 'orange', '仍受风险与审批策略约束') + '</div>' +
      '<p><b>根因：</b>' + esc(d.root_cause) + '</p><p class="sub">LLM回执：' + esc(d.llm_call_id || '—') + '；该结果已持久化并计入评测中心配对样本。</p></div>';
  }

  window.selectIncidentForAI = function (id) {
    selected = id;
    diagnosisResult = null;
    window.incs();
  };

  window.runIncidentAIDiagnosis = async function (id) {
    if (diagnosing) return;
    selected = id;
    diagnosing = true;
    diagnosisResult = null;
    window.incs();
    try {
      diagnosisResult = await req('/ai/diagnose?incident_id=' + encodeURIComponent(id), { method: 'POST' });
      toast(diagnosisResult.ai_powered ? 'AI诊断成功，测评样本已更新' : 'AI未成功，已明确降级');
      await refresh(true);
    } catch (error) {
      diagnosisResult = { ai_powered: false, diagnosis: { llm_error: error.message } };
    } finally {
      diagnosing = false;
      if (page === 'incidents') window.incs();
    }
  };

  window.incs = function () {
    var incidents = cache.incidents || [];
    if (!selected && incidents.length) selected = incidents.at(-1).id;
    var current = incidents.find(function (item) { return item.id === selected; });
    document.getElementById('pageSub').textContent = '选择事件后可执行真实AI诊断；成功、失败和模板降级会明确区分';
    var rows = incidents.slice().reverse().map(function (item) {
      var on = item.id === selected;
      return '<tr' + (on ? ' style="background:#431f93"' : '') + '><td>' + fmt(item.created_at) + '</td><td><b>' + esc(item.title) + '</b><div class="mono muted">' + esc(item.id) + '</div></td><td>' + esc(item.service) + '</td><td>' + esc(sourceName(item.source)) + '</td><td>' + badge(item.status) + '</td><td><button onclick="selectIncidentForAI(\'' + esc(item.id) + '\')">选择</button> <button class="primary" onclick="runIncidentAIDiagnosis(\'' + esc(item.id) + '\')" ' + (diagnosing ? 'disabled' : '') + '>AI诊断</button> <button onclick="selected=\'' + esc(item.id) + '\';go(\'trace\')">证据</button></td></tr>';
    }).join('');
    document.getElementById('content').innerHTML = '<div class="notice"><b>正确使用顺序</b>：先选择一条有明确标题和描述的事件，再点击该行“AI诊断”。仅保存或测试Key不会产生诊断样本。</div>' +
      '<div class="card section"><table class="table"><thead><tr><th>时间</th><th>事件</th><th>目标/服务</th><th>来源</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' + (incidents.length ? '' : '<div class="empty">暂无异常事件，请先在五分钟演示中心注入一个故障。</div>') + '</div>' +
      (current ? '<div class="card section"><h3>当前已选事件</h3><p><b>' + esc(current.title) + '</b> · ' + badge(current.status) + '</p><p>' + esc(current.description || '该事件没有详细描述') + '</p><p class="mono muted">' + esc(current.id) + '</p></div>' : '') + diagnosisPanel();
  };

  window.evaluationView = async function () {
    document.getElementById('pageSub').textContent = '离线回归评测与真实AI配对样本分别统计，不把“已配置”冒充“已诊断”';
    document.getElementById('content').innerHTML = '<div class="empty spinner">读取评测报告与AI运行记录…</div>';
    try {
      var values = await Promise.all([req('/evaluation/latest'), req('/evaluation/ai-impact'), req('/ai/config')]);
      if (page !== 'evaluation') return;
      var report = values[0], impact = values[1], config = values[2];
      var aiState = !config.configured ? '<div class="notice error"><b>AI尚未配置</b><br>请点击左侧“AI安全配置”。</div>' :
        impact.sample_count ? '<div class="notice success"><b>AI已配置，并已有真实成功诊断样本</b><br>成功诊断 ' + esc(impact.sample_count) + ' 条；成功模型调用 ' + esc(impact.successful_call_count) + ' 次。</div>' :
        '<div class="notice"><b>AI已配置且连接可用，但尚无成功事件诊断样本</b><br>“测试连接”只验证Key，不计入效果评测。请前往异常事件点击“AI诊断”。<div class="actions section"><button class="primary" onclick="go(\'incidents\')">前往异常事件</button></div></div>';
      var impactHtml = impact.status === 'measured' ? '<div class="grid section">' + card('配对样本', impact.sample_count, 'cyan', '真实成功诊断') + card('类别一致率', (impact.category_agreement_rate * 100).toFixed(1) + '%', 'purple', 'AI对比本地规则') + card('平均置信度差', impact.average_confidence_delta, 'orange', 'AI减基线') + card('失败调用', impact.failed_call_count, impact.failed_call_count ? 'red' : 'green', '不计入成功样本') + '</div>' : '<div class="card empty section">尚未形成AI配对样本，不声称AI带来提升。</div>';
      var evaluationHtml = report.status === 'not_run' ? '<div class="card empty section"><p>尚未运行50条离线回归评测。</p><button class="primary" onclick="runEvaluationNow()">运行50条评测</button></div>' : (function () { var m = report.metrics || {}, h = report.split_metrics && report.split_metrics.holdout || {}; return '<div class="grid section">' + card('总场景', report.scenario_count, 'cyan', report.dataset_version) + card('留出集诊断', ((h.diagnosis_accuracy || 0) * 100).toFixed(1) + '%', 'green', '受控离线数据') + card('拒答准确率', ((m.abstention_accuracy || 0) * 100).toFixed(1) + '%', 'purple', '未知/证据不足') + card('危险自动执行', m.unsafe_automatic_execution_count || 0, 'orange', '目标为0') + '</div><div class="actions section"><button onclick="runEvaluationNow()">重新运行离线评测</button></div>'; }());
      document.getElementById('content').innerHTML = aiState + impactHtml + evaluationHtml + '<p class="sub section">AI贡献只统计本机实际成功调用形成的配对样本；离线50条评测不调用外部模型，两者不会混算。</p>';
    } catch (error) { document.getElementById('content').innerHTML = '<div class="notice error">评测数据加载失败：' + esc(error.message) + '</div>'; }
  };

  window.runEvaluationNow = async function () {
    document.getElementById('content').innerHTML = '<div class="empty spinner">正在运行50条受控离线案例…</div>';
    try { await req('/evaluation/run', { method: 'POST' }); await window.evaluationView(); }
    catch (error) { document.getElementById('content').innerHTML = '<div class="notice error">' + esc(error.message) + '</div>'; }
  };

  // This controller is loaded last. Intercept these two pages explicitly so
  // legacy render closures and the initial async refresh cannot repaint an old
  // implementation after the v16 view has already been selected.
  var previousRender = window.render;
  window.render = function () {
    if (page === 'incidents') { nav(); return window.incs(); }
    if (page === 'evaluation') { nav(); return window.evaluationView(); }
    return previousRender();
  };
  var previousGo = window.go;
  window.go = function (nextPage) {
    if (nextPage === 'incidents' || nextPage === 'evaluation') {
      page = nextPage; nav(); return window.render();
    }
    return previousGo(nextPage);
  };
  if (page === 'incidents' || page === 'evaluation') setTimeout(function () { window.render(); }, 0);

  // Direct links such as ?page=debate render before the first API refresh has
  // populated cache. Re-render exactly once after hydration so selectors and
  // data-backed pages never remain blank until the user leaves and returns.
  if (!cache.overview) {
    var hydrationTimer = setInterval(function () {
      if (!cache.overview) return;
      clearInterval(hydrationTimer);
      if (!selected && cache.incidents && cache.incidents.length) selected = cache.incidents.at(-1).id;
      window.render();
    }, 50);
    setTimeout(function () { clearInterval(hydrationTimer); }, 5000);
  }
}());
