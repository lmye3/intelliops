(function () {
  'use strict';

  if (!pages.some(function (item) { return item[0] === 'twin'; })) pages.splice(1, 0, ['twin', '五分钟演示中心']);
  var previousRender = window.render;
  var previousTrace = window.trace;
  var twinTimer = null;
  var twinBusy = false;
  var twinAction = null;

  function twinActionHtml() {
    if (!twinAction) return '<div id="twinAction"></div>';
    var kind = twinAction.kind === 'error' ? 'error' : (twinAction.kind === 'success' ? 'success' : '');
    return '<div id="twinAction" class="notice ' + kind + '"><b>' + esc(twinAction.title) + '</b><br>' + esc(twinAction.message) +
      (twinAction.kind === 'error' ? '<div class="actions section"><button onclick="refreshTwinView()">重新连接后端</button></div>' : '') + '</div>';
  }

  function paintTwinAction() {
    var element = document.getElementById('twinAction');
    if (element) element.outerHTML = twinActionHtml();
  }

  async function twinRequest(route, options) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var merged = Object.assign({}, options || {}, { signal: controller.signal });
      return await req(route, merged);
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('后端20秒内没有响应，请关闭后重新打开IntelliOps');
      if (/Failed to fetch|NetworkError|Load failed/i.test(String(error && error.message || error))) throw new Error('内置后端未运行，请关闭当前窗口并重新打开IntelliOps');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function stageText(stage) {
    return ({ FAULT_INJECTED: '故障已注入', COLLECTING_EVIDENCE: '真实取证与官方协作', RISK_DECISION: '风险决策', WAITING_APPROVAL: '等待人工审批', EXECUTING: '执行白名单恢复', VERIFICATION_FAILED: '恢复验证失败', COMPLETED: '闭环完成', FAILED: '流程失败' })[stage] || stage || '尚未开始';
  }

  function componentCard(item) {
    return '<div class="card target ' + (item.running && item.config.healthy ? 'healthy' : 'unhealthy') + '">' +
      '<div class="statusline"><b>' + esc(item.name) + '</b>' + badge(item.running ? (item.config.healthy ? 'healthy' : 'unhealthy') : 'stopped') + '</div>' +
      '<p class="mono">127.0.0.1:' + esc(item.port) + ' · ' + esc(item.kind) + ' · generation ' + esc(item.generation) + '</p>' +
      '<p>延迟配置 ' + esc(item.config.latency_ms) + 'ms · 错误率配置 ' + esc(Math.round(item.config.error_rate * 100)) + '% · 实际请求 ' + esc(item.request_count) + '</p></div>';
  }

  function metrics(label, value) {
    if (!value) return '<div class="node"><b>' + label + '</b><p class="sub">等待真实采样</p></div>';
    return '<div class="node"><b>' + label + '</b><p>错误率 ' + esc(value.error_rate) + '% · P95 ' + esc(value.p95_latency_ms) + 'ms</p><p class="sub">' + esc(value.request_count) + '个真实HTTP请求 · ' + esc(value.source) + '</p></div>';
  }

  window.twinView = async function () {
    document.getElementById('pageTitle').textContent = '五分钟演示中心';
    document.getElementById('pageSub').textContent = '真实本地HTTP数字孪生：注入、协作诊断、风险审批、白名单恢复、同路径复验';
    document.getElementById('content').innerHTML = '<div class="empty spinner">读取数字孪生运行状态…</div>';
    await refreshTwinView();
    clearInterval(twinTimer);
    twinTimer = setInterval(function () { if (page === 'twin') refreshTwinView(true); }, 2000);
  };

  window.refreshTwinView = async function (silent) {
    try {
      var data = await req('/twin/status');
      if (page !== 'twin') return;
      var run = data.recent_runs && data.recent_runs.at(-1);
      var html = '<div class="notice success"><b>真实性边界</b>：三个组件均监听真实127.0.0.1端口，指标来自实际HTTP请求；恢复仅作用于项目自带孪生环境，不执行任意Shell。</div>';
      html += '<div class="grid section">' + data.components.map(componentCard).join('') + '</div>';
      html += twinActionHtml();
      html += '<div class="card section"><h3>选择可重复故障</h3><div class="actions">' +
        '<button class="primary" data-twin-scenario="gateway_latency" ' + (twinBusy ? 'disabled' : '') + '>1. 网关高延迟（L1自动恢复）</button>' +
        '<button data-twin-scenario="payment_bad_config" ' + (twinBusy ? 'disabled' : '') + '>2. 支付错误配置（L1自动恢复）</button>' +
        '<button data-twin-scenario="payment_service_crash" ' + (twinBusy ? 'disabled' : '') + '>3. 支付服务退出（L2受控重启）</button>' +
        '<button data-twin-scenario="inventory_app_crash" ' + (twinBusy ? 'disabled' : '') + '>4. 库存应用退出（L3人工审批）</button>' +
        '<button onclick="resetTwin()" ' + (twinBusy ? 'disabled' : '') + '>恢复全部基线</button></div></div>';
      if (run) {
        html += '<div class="card section"><div class="statusline"><h3 style="margin:0">当前闭环</h3>' + badge(run.status) + '</div><p><b>' + esc(run.scenario) + '</b> · ' + esc(stageText(run.stage)) + ' · 风险 ' + esc(run.risk_level) + '</p>' +
          '<div class="flow">' + metrics('修复前基线', run.before_metrics) + metrics('故障状态', run.fault_metrics) + metrics('修复后验证', run.status === 'SUCCEEDED' && run.finished_at ? ((run.after_metrics || null)) : null) +
          '<div class="node"><b>官方AgentTeams</b><p>' + badge(run.agentteams && run.agentteams.status || 'PENDING') + '</p><p class="sub">' + esc(run.agentteams && (run.agentteams.result_sender || run.agentteams.reason) || '等待协作') + '</p></div></div>' +
          (run.status === 'WAITING_APPROVAL' ? '<div class="notice section"><b>L3暂停点</b>：受管应用重启必须由真人确认。<div class="actions section"><button class="primary" onclick="approveTwin(\'' + esc(run.approval_id) + '\')">批准并继续</button><button class="danger" onclick="rejectTwin(\'' + esc(run.approval_id) + '\')">拒绝</button></div></div>' : '') +
          '<div class="actions section"><button onclick="selected=\'' + esc(run.event_id) + '\';go(\'trace\')">查看完整Trace与证据包</button></div></div>';
      } else html += '<div class="card empty section">请选择一个故障场景开始五分钟演示</div>';
      document.getElementById('content').innerHTML = html;
      document.querySelectorAll('[data-twin-scenario]').forEach(function (button) {
        button.addEventListener('click', function () { window.startTwinDemo(button.getAttribute('data-twin-scenario')); });
      });
    } catch (error) {
      twinAction = { kind: 'error', title: '后端未启动', message: error.message };
      if (page === 'twin') document.getElementById('content').innerHTML = twinActionHtml();
    }
  };

  window.startTwinDemo = async function (scenario) {
    if (twinBusy) return;
    twinBusy = true;
    twinAction = { kind: 'progress', title: '正在注入故障', message: '正在采集正常基线并注入受限故障，请稍候…' };
    paintTwinAction();
    try {
      var result = await twinRequest('/twin/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: scenario }) });
      selected = result.event_id;
      twinAction = { kind: 'success', title: '故障已注入', message: '事件 ' + result.event_id + ' 已创建，Agent正在按真实状态推进。' };
      toast('真实故障已注入，Agent协作开始');
      await refresh(true, true);
    } catch (error) {
      twinAction = { kind: 'error', title: '故障注入失败', message: error.message };
    } finally {
      twinBusy = false;
      await refreshTwinView(true);
    }
  };
  window.resetTwin = async function () { try { await req('/twin/reset', { method: 'POST' }); toast('数字孪生已恢复基线'); await refreshTwinView(); } catch (error) { toast(error.message); } };
  window.approveTwin = async function (id) { try { await req('/approvals/' + encodeURIComponent(id) + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', approver: '现场评委/本机管理员', comment: '已核对目标、动作、风险和回滚边界' }) }); toast('审批通过，正在真实恢复并复验'); await refreshTwinView(); } catch (error) { toast(error.message); } };
  window.rejectTwin = async function (id) { try { await req('/approvals/' + encodeURIComponent(id) + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject', approver: '现场评委/本机管理员', comment: '拒绝本次L3操作' }) }); toast('已拒绝，系统不会执行恢复'); await refreshTwinView(); } catch (error) { toast(error.message); } };

  window.trace = async function () {
    await previousTrace();
    if (page !== 'trace' || !selected) return;
    try {
      var evidence = await req('/incidents/' + encodeURIComponent(selected) + '/evidence');
      var demos = evidence['demo-runs.json'] || [];
      if (!demos.length || page !== 'trace') return;
      var run = demos.at(-1), body = document.getElementById('traceBody');
      if (!body) return;
      body.insertAdjacentHTML('beforeend', '<div class="card section"><h3>数字孪生恢复证明</h3><div class="flow">' +
        metrics('修复前基线', run.before_metrics) + metrics('故障状态', run.fault_metrics) + metrics('修复后验证', run.after_metrics) +
        '<div class="node"><b>执行边界</b><p>' + badge(run.execution_mode) + '</p><p class="sub">' + esc(run.recovery_action) + ' · 风险' + esc(run.risk_level) + ' · 禁止任意Shell</p></div></div></div>');
    } catch (_) {}
  };

  window.render = function () {
    if (page === 'twin') { nav(); return twinView(); }
    clearInterval(twinTimer); twinTimer = null; return previousRender();
  };
  var oldGo = window.go;
  window.go = function (nextPage) {
    if (nextPage === 'twin') { page = nextPage; nav(); return window.render(); }
    clearInterval(twinTimer); twinTimer = null; return oldGo(nextPage);
  };
  document.querySelector('.side .sub').textContent = 'IntelliOps Desktop v16.1';
  window.__INTELLIOPS_TWIN_V16__ = true;
  nav();
  if (new URLSearchParams(location.search).get('page') === 'twin') {
    page = 'twin';
    window.render();
  }
}());
