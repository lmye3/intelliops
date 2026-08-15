(function () {
  'use strict';

  const legacy = {
    render: window.render,
    demo: window.demo,
    trace: window.trace
  };
  const renderingState = {
    refreshing: false,
    refreshPromise: null,
    queued: false,
    viewEpoch: 0,
    liveSignature: '',
    actions: new Set(),
    lastConnectionToast: 0
  };

  function byId(id) { return document.getElementById(id); }
  window.safeElement = function (id) { return byId(id) || { isConnected: false, innerHTML: '', textContent: '', value: '' }; };
  function value(id) { const node = byId(id); return node ? node.value.trim() : ''; }
  function numberValue(id) { const result = Number(value(id)); return Number.isFinite(result) ? result : 0; }
  function currentButton() {
    try { return window.event && window.event.currentTarget instanceof HTMLElement ? window.event.currentTarget : null; }
    catch (_) { return null; }
  }

  async function apiRequest(route, options) {
    const response = await fetch(API + route, options || {});
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch (_) { data = { detail: raw.slice(0, 300) }; }
    }
    if (!response.ok) throw new Error(data.detail || data.message || ('HTTP ' + response.status));
    return data;
  }
  window.req = apiRequest;

  async function runOnce(key, task) {
    if (renderingState.actions.has(key)) return;
    renderingState.actions.add(key);
    const button = currentButton();
    if (button) { button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = '处理中…'; }
    try { return await task(); }
    finally {
      renderingState.actions.delete(key);
      if (button && button.isConnected) { button.disabled = false; button.textContent = button.dataset.originalText || '完成'; }
      if (typeof updateActiveView === 'function') updateActiveView();
    }
  }

  function monitorCard(target) {
    return '<div class="card target ' + esc(target.status) + '" data-target-id="' + esc(target.id) + '">' +
      '<div class="statusline"><b>' + esc(target.name) + '</b>' + badge(target.status) + (target.enabled ? '' : '<span class="tag">已停用</span>') + '</div>' +
      '<p class="mono">' + esc(target.type) + ' · ' + esc(targetAddress(target)) + '</p>' +
      '<p>' + esc(targetReason(target)) + '</p>' +
      '<p class="sub">每' + esc(target.interval_sec) + '秒 · 连续' + esc(target.consecutive_failures) + '次失败触发 · 上次 ' + fmt(target.last_check_at) + '</p>' +
      '<div class="actions"><button onclick="checkTarget(\'' + esc(target.id) + '\')">立即探测</button>' +
      '<button onclick="toggleTarget(\'' + esc(target.id) + '\')">' + (target.enabled ? '停用' : '启用') + '</button>' +
      (target.id === 'monitor_local_system' ? '' : '<button class="danger" onclick="deleteTarget(\'' + esc(target.id) + '\')">删除</button>') + '</div></div>';
  }

  function monitorRows() {
    return (cache.results || []).slice().reverse().slice(0, 30).map(function (result) {
      return '<tr><td>' + fmt(result.checked_at) + '</td><td>' + esc(result.target_name) + '</td><td>' + badge(result.status) +
        '<div class="sub">' + esc(result.reason) + '</div></td><td>' + esc(result.duration_ms) + 'ms</td><td class="mono">' + esc(result.source) + '</td></tr>';
    }).join('');
  }

  window.monitoringView = function () {
    const targets = cache.targets || [];
    const enabled = Boolean(cache.overview && cache.overview.monitoring.enabled);
    byId('pageSub').textContent = '持续探测、连续失败去抖、真实恢复确认；表单输入不会被自动刷新清空';
    byId('content').innerHTML =
      '<div id="monitorEngine" class="actions"><button class="' + (enabled ? 'danger' : 'primary') + '" onclick="toggleEngine(' + (!enabled) + ')">' + (enabled ? '暂停全部监控' : '恢复全部监控') + '</button></div>' +
      '<div id="monitorCards" class="grid2 section" aria-live="polite">' + targets.map(monitorCard).join('') + '</div>' +
      '<div class="card section"><h3>新增真实监控目标</h3><div class="formgrid">' +
      '<label>名称<input id="mName" autocomplete="off" placeholder="支付API健康检查"></label>' +
      '<label>类型<select id="mType" onchange="monitorFields()"><option value="http">HTTP接口</option><option value="tcp">TCP端口</option><option value="process">关键进程</option><option value="application">应用深度监控</option><option value="windows_service">Windows服务</option></select></label>' +
      '<label>探测间隔(秒)<input id="mInterval" type="number" min="5" value="30"></label>' +
      '<label>超时(ms)<input id="mTimeout" type="number" min="500" value="5000"></label>' +
      '<label>连续失败次数<input id="mFailures" type="number" min="1" value="3"></label><div></div>' +
      '<div id="dynamicFields" class="wide formgrid"></div></div>' +
      '<div class="actions section"><button class="primary" onclick="addTarget()">保存并首次探测</button></div></div>' +
      '<div class="card section"><h3>最近真实探测</h3><table class="table"><thead><tr><th>时间</th><th>目标</th><th>结果</th><th>耗时</th><th>证据来源</th></tr></thead><tbody id="monitorTable" aria-live="polite">' + monitorRows() + '</tbody></table></div>';
    monitorFields();
  };

  window.updateMonitoringResults = function () {
    const cards = byId('monitorCards');
    const table = byId('monitorTable');
    const engine = byId('monitorEngine');
    if (cards) cards.innerHTML = (cache.targets || []).map(monitorCard).join('');
    if (table) table.innerHTML = monitorRows();
    if (engine) {
      const enabled = Boolean(cache.overview && cache.overview.monitoring.enabled);
      engine.innerHTML = '<button class="' + (enabled ? 'danger' : 'primary') + '" onclick="toggleEngine(' + (!enabled) + ')">' + (enabled ? '暂停全部监控' : '恢复全部监控') + '</button>';
    }
  };

  window.toggleEngine = function (enabled) {
    return runOnce('engine', async function () {
      try {
        await req('/monitor/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: Boolean(enabled) }) });
        await refresh(true, true);
        toast(enabled ? '持续监控已恢复' : '持续监控已暂停');
      } catch (error) { toast(error.message); }
    });
  };

  window.addTarget = function () {
    return runOnce('add-target', async function () {
      try {
        const type = value('mType');
        const name = value('mName');
        const address = value('mAddress');
        if (!name) throw new Error('请填写监控名称');
        if (type !== 'system' && !address) throw new Error('请填写目标地址、进程名或服务名');
        const config = {}, thresholds = {};
        if (type === 'http') { config.url = address; thresholds.latency_ms = numberValue('mLatency'); }
        if (type === 'tcp') { config.host = address; config.port = numberValue('mPort'); }
        if (type === 'process') config.process_name = address;
        if (type === 'application') { config.process_name = address; thresholds.mem_mb = numberValue('mMemLimit'); thresholds.min_uptime_min = numberValue('mMinUptime'); }
        if (type === 'windows_service') { config.service_name = address; config.recovery_action = value('mRecovery'); }
        await req('/monitor/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          name: name, type: type, interval_sec: numberValue('mInterval'), timeout_ms: numberValue('mTimeout'),
          consecutive_failures: numberValue('mFailures'), config: config, thresholds: thresholds
        }) });
        await refresh(true, true);
        if (page === 'monitoring') monitoringView();
        toast('监控目标已保存并开始首次探测');
      } catch (error) { toast(error.message); }
    });
  };

  window.checkTarget = function (id) {
    return runOnce('check-' + id, async function () {
      try {
        const result = await req('/monitor/targets/' + encodeURIComponent(id) + '/check', { method: 'POST' });
        await refresh(true, true);
        toast((result.ok ? '探测正常：' : '探测异常：') + result.reason);
      } catch (error) { toast(error.message); }
    });
  };

  window.toggleTarget = function (id) {
    return runOnce('toggle-' + id, async function () {
      try { await req('/monitor/targets/' + encodeURIComponent(id) + '/toggle', { method: 'POST' }); await refresh(true, true); }
      catch (error) { toast(error.message); }
    });
  };

  window.deleteTarget = function (id) {
    if (!confirm('删除该监控目标？历史探测记录仍保留。')) return;
    return runOnce('delete-' + id, async function () {
      try { await req('/monitor/targets/' + encodeURIComponent(id), { method: 'DELETE' }); await refresh(true, true); toast('监控目标已删除'); }
      catch (error) { toast(error.message); }
    });
  };

  async function approvalAction(id, action) {
    return runOnce('approval-' + id, async function () {
      try {
        await req('/approvals/' + encodeURIComponent(id) + '/approve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action, approver: '本机管理员', comment: action === 'approve' ? '已核对目标、影响范围和回滚边界' : '风险不可接受' })
        });
        await refresh(true, true);
        toast(action === 'approve' ? '审批通过，流程正在执行并复验' : '操作已拒绝');
      } catch (error) { toast(error.message); }
    });
  }
  window.approve = function (id) { return approvalAction(id, 'approve'); };
  window.reject = function (id) { return approvalAction(id, 'reject'); };

  window.startDemo = function () {
    return runOnce('start-demo', async function () {
      try {
        const result = await req('/demo/connection-pool', { method: 'POST' });
        selected = result.incident_id;
        page = 'demo';
        renderingState.viewEpoch += 1;
        renderingState.liveSignature = '';
        await refresh(true, true);
        if (page === 'demo') legacy.demo();
        toast('真实并发故障已注入，状态将自动更新');
      } catch (error) { toast(error.message); }
    });
  };

  function liveSignature() {
    const incident = (cache.incidents || []).find(function (item) { return item.id === selected; });
    const runState = (cache.runs || []).filter(function (item) { return item.event_id === selected; }).map(function (item) { return item.id + ':' + item.status; }).join('|');
    const approvalState = (cache.approvals || []).filter(function (item) { return item.event_id === selected; }).map(function (item) { return item.id + ':' + item.status; }).join('|');
    return [page, selected, incident && incident.status, incident && incident.current_agent, incident && incident.updated_at, runState, approvalState].join('::');
  }

  function preserveScroll(task) {
    const main = document.querySelector('.main');
    const top = main ? main.scrollTop : 0;
    task();
    if (main) main.scrollTop = top;
  }

  function updateActiveView() {
    if (renderingState.actions.size && ['monitoring', 'demo', 'approvals'].includes(page)) return;
    if (page === 'monitoring') { updateMonitoringResults(); return; }
    const signature = liveSignature();
    if (page === 'demo') {
      if (signature !== renderingState.liveSignature) { renderingState.liveSignature = signature; legacy.demo(); }
      return;
    }
    if (page === 'trace') {
      if (signature !== renderingState.liveSignature) { renderingState.liveSignature = signature; window.trace(); }
      return;
    }
    if (['dashboard', 'incidents', 'approvals', 'runtime', 'skills', 'sageruns'].includes(page)) {
      preserveScroll(legacy.render);
    }
  }

  async function performRefresh(silent) {
    const values = await Promise.all([
      req('/overview'), req('/incidents'), req('/approvals/history'), req('/runtime'), req('/skills'),
      req('/skill-runs'), req('/monitor/targets'), req('/monitor/results?limit=100'), req('/monitor/snapshot')
    ]);
    cache = { overview: values[0], incidents: values[1], approvals: values[2], runtime: values[3], skills: values[4], runs: values[5], targets: values[6], results: values[7], snapshot: values[8] };
    if (!selected && cache.incidents.length) selected = cache.incidents[cache.incidents.length - 1].id;
    const runtimeText = byId('runtimeText');
    if (runtimeText) runtimeText.textContent = (cache.overview.monitoring.enabled ? '持续监控 · ' : '监控已暂停 · ') + cache.targets.filter(function (item) { return item.enabled; }).length + '个目标';
    updateActiveView();
    if (!silent) toast('数据已刷新');
  }

  window.refresh = async function (silent, force) {
    if (document.hidden && silent && !force) return;
    if (renderingState.refreshing) {
      if (force) {
        try { await renderingState.refreshPromise; } catch (_) {}
        return refresh(silent, true);
      }
      renderingState.queued = true;
      return renderingState.refreshPromise;
    }
    renderingState.refreshing = true;
    renderingState.refreshPromise = performRefresh(Boolean(silent)).catch(function (error) {
      const content = byId('content');
      if (!cache || !cache.overview) {
        if (content) content.innerHTML = '<div class="notice error">后端未启动或连接失败：' + esc(error.message) + '<br><button onclick="refresh(false,true)">重试</button></div>';
      } else {
        const runtimeText = byId('runtimeText');
        if (runtimeText) runtimeText.textContent = '后端暂时不可用 · 正在重试';
        if (!silent && Date.now() - renderingState.lastConnectionToast > 5000) { toast('刷新失败：' + error.message); renderingState.lastConnectionToast = Date.now(); }
      }
      return null;
    }).finally(function () {
      renderingState.refreshing = false;
      renderingState.refreshPromise = null;
      if (renderingState.queued) { renderingState.queued = false; setTimeout(function () { refresh(true); }, 0); }
    });
    return renderingState.refreshPromise;
  };

  window.render = function () {
    renderingState.viewEpoch += 1;
    renderingState.liveSignature = '';
    return legacy.render();
  };
  window.go = function (nextPage) {
    if (!pages.some(function (item) { return item[0] === nextPage; })) return;
    page = nextPage;
    renderingState.viewEpoch += 1;
    renderingState.liveSignature = '';
    nav();
    legacy.render();
  };

  const style = document.createElement('style');
  style.textContent = 'button:disabled{opacity:.55;cursor:wait;pointer-events:none}.card[data-target-id]{contain:layout style}.spinner{min-height:42px}';
  document.head.appendChild(style);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(true, true).catch(function () {}); });
  if (!pages.some(function (item) { return item[0] === page; })) page = 'dashboard';
  window.render();
  refresh(true, true).catch(function () {});
  window.__INTELLIOPS_RENDERING_V13__ = { state: renderingState, monitorCard: monitorCard, monitorRows: monitorRows };
}());
(function () {
  'use strict';

  function aiFieldValue(id) {
    const node = document.getElementById(id);
    return node ? node.value.trim() : '';
  }

  function setAiStatus(config) {
    const bar = document.getElementById('aiStatusBar');
    if (!bar) return;
    bar.textContent = config && config.key_status === 'saved_and_loaded'
      ? 'Key已加密保存 · ' + (config.model || '模型已配置')
      : config && config.key_status === 'saved_but_unavailable'
        ? 'Key文件存在但当前用户无法解密'
        : '点击配置API Key';
  }

  window.showAISettings = async function () {
    try {
      const existing = document.getElementById('aiPanel');
      if (existing) existing.remove();
      const config = await req('/ai/config');
      setAiStatus(config);
      const saved = config.key_status === 'saved_and_loaded';
      const unavailable = config.key_status === 'saved_but_unavailable';
      const statusHtml = saved
        ? '<div class="notice success"><b>API Key已安全保存并成功加载</b><br>为保护密钥，程序不会再次显示明文。下方输入框留空会继续使用原Key。</div>'
        : unavailable
          ? '<div class="notice error"><b>检测到加密Key，但当前Windows用户无法解密</b><br>请重新输入Key进行替换。</div>'
          : '<div class="notice"><b>尚未保存API Key</b><br>请输入兼容接口的Key。</div>';
      const html = '<div style="position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:999" onclick="if(event.target===this)this.remove()">' +
        '<div style="background:#33136b;border:1px solid #5a2fa5;border-radius:12px;padding:24px;max-width:520px;width:92%">' +
        '<h3 style="margin:0 0 16px;color:#21d4fd">AI 安全配置（v15.0）</h3>' + statusHtml +
        '<div style="display:grid;gap:10px;margin-top:14px">' +
        '<label style="color:#8ea1be;font-size:12px">Endpoint<input id="aiEndpoint" value="' + esc(config.endpoint || 'https://api.deepseek.com/v1/chat/completions') + '" style="width:100%;background:#260f52;border:1px solid #5d37b8;color:#fff;padding:9px;border-radius:7px"></label>' +
        '<label style="color:#8ea1be;font-size:12px">新API Key（仅首次设置或更换时填写）<input id="aiKey" type="password" autocomplete="new-password" placeholder="' + (saved ? '•••••••• 已保存；留空保持不变' : '请输入API Key') + '" style="width:100%;background:#260f52;border:1px solid #5d37b8;color:#fff;padding:9px;border-radius:7px"></label>' +
        '<div id="aiKeyHint" class="sub">' + (saved ? '当前Key：••••••••（Windows DPAPI加密存储）' : 'Key不会写入程序目录或普通配置文件') + '</div>' +
        '<label style="color:#8ea1be;font-size:12px">Model<input id="aiModel" value="' + esc(config.model || '') + '" style="width:100%;background:#260f52;border:1px solid #5d37b8;color:#fff;padding:9px;border-radius:7px"></label></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="primary" onclick="saveAI()">保存设置</button><button onclick="testAI()">测试连接</button>' +
        '<button id="clearAiKeyButton" class="danger" style="' + (config.key_persisted ? '' : 'display:none') + '" onclick="clearAIKey()">删除已保存Key</button>' +
        '<button onclick="document.getElementById(\'aiPanel\').remove()">关闭</button></div>' +
        '<div id="aiResult" style="margin-top:12px;font-size:13px"></div></div></div>';
      const panel = document.createElement('div');
      panel.id = 'aiPanel';
      panel.innerHTML = html;
      document.body.appendChild(panel);
    } catch (error) { toast(error.message); }
  };

  window.saveAI = async function () {
    const result = document.getElementById('aiResult');
    if (result) result.innerHTML = '<span class="spinner">正在安全保存…</span>';
    try {
      const response = await req('/ai/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: aiFieldValue('aiEndpoint'), api_key: aiFieldValue('aiKey'), model: aiFieldValue('aiModel') })
      });
      const keyInput = document.getElementById('aiKey');
      if (keyInput) { keyInput.value = ''; keyInput.placeholder = response.key_persisted ? '•••••••• 已保存；留空保持不变' : '请输入API Key'; }
      const hint = document.getElementById('aiKeyHint');
      if (hint) hint.textContent = response.key_persisted ? '当前Key：••••••••（Windows DPAPI加密存储）' : '尚未保存Key';
      const clearButton = document.getElementById('clearAiKeyButton');
      if (clearButton) clearButton.style.display = response.key_persisted ? '' : 'none';
      if (result) result.innerHTML = '<span style="color:#3ddc97">✓ ' + esc(response.message) + '，重启后仍然有效</span>';
      setAiStatus(response);
      toast(response.key_action === 'preserved' ? '原API Key已保留' : '新API Key已加密保存');
    } catch (error) { if (result) result.innerHTML = '<span style="color:#ff647c">✕ ' + esc(error.message) + '</span>'; }
  };

  window.testAI = async function () {
    const result = document.getElementById('aiResult');
    if (result) result.innerHTML = '<span class="spinner">正在测试；Key留空时使用已保存Key…</span>';
    try {
      const response = await req('/ai/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: aiFieldValue('aiEndpoint'), api_key: aiFieldValue('aiKey'), model: aiFieldValue('aiModel') })
      });
      if (result) result.innerHTML = '<span style="color:#3ddc97">✓ 连接成功（HTTP ' + esc(response.http_status || 200) + '）</span>';
    } catch (error) { if (result) result.innerHTML = '<span style="color:#ff647c">✕ ' + esc(error.message) + '</span>'; }
  };

  window.clearAIKey = async function () {
    if (!confirm('确定删除本机加密保存的API Key？删除后AI调用将不可用，直到重新配置。')) return;
    const result = document.getElementById('aiResult');
    try {
      const response = await req('/ai/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: aiFieldValue('aiEndpoint'), model: aiFieldValue('aiModel'), clear_api_key: true })
      });
      if (result) result.innerHTML = '<span style="color:#ffb84d">已删除本机保存的API Key</span>';
      const hint = document.getElementById('aiKeyHint');
      if (hint) hint.textContent = '尚未保存Key';
      const keyInput = document.getElementById('aiKey');
      if (keyInput) keyInput.placeholder = '请输入API Key';
      const clearButton = document.getElementById('clearAiKeyButton');
      if (clearButton) clearButton.style.display = 'none';
      setAiStatus(response);
      toast('已删除保存的API Key');
    } catch (error) { if (result) result.innerHTML = '<span style="color:#ff647c">✕ ' + esc(error.message) + '</span>'; }
  };
}());
