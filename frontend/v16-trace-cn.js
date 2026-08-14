(function () {
  'use strict';

  var originalTrace = window.trace;
  if (typeof originalTrace !== 'function') return;

  var exact = {
    'Agent Runs': '智能体运行次数',
    'Skill Runs': '技能运行次数',
    'Tool Calls': '工具调用次数',
    '本地Agent Runs': '本地智能体运行',
    'Skill / Tool': '技能／工具调用',
    'Schema与输入哈希': '结构校验与输入哈希',
    'Manager–Workers': '管理器—执行单元',
    'Agent任务链': '智能体任务链',
    'Skill结构验证': '技能结构验证',
    'Skill': '技能',
    'Schema': '结构校验',
    'Owner': '负责人',
    'Human': '人工触发',
    'PENDING': '待执行',
    'RUNNING': '执行中',
    'SUCCEEDED': '已成功',
    'FAILED': '已失败',
    'WAITING_APPROVAL': '等待人工审批',
    'SKIPPED': '已跳过',
    'APPROVED': '已批准',
    'REJECTED': '已拒绝',
    'COMPLETED': '已完成',
    'RESOLVED': '已解决',
    'waiting_approval': '等待人工审批',
    'completed': '已完成',
    'resolved': '已解决',
    'simulation': '模拟执行',
    'sandbox': '安全沙箱执行',
    'production': '生产执行',
    'local_verified': '本地可信编排',
    'official_agentteams': '官方 AgentTeams 协作'
  };

  var agents = {
    'Commander': 'Commander（指挥官）',
    'Detective': 'Detective（诊断侦探）',
    'Ranger': 'Ranger（安全执行官）',
    'Sage': 'Sage（复盘智者）',
    'Manager': 'Manager（协作管理器）',
    'Human': '人工触发'
  };

  var tasks = {
    'twin_triage_and_plan': '数字孪生分诊与任务规划',
    'twin_evidence_and_collaboration': '数字孪生取证与协作诊断',
    'twin_restore_config': '恢复数字孪生基线配置',
    'twin_restart_service': '重启受管服务',
    'twin_restart_managed_application': '重启受管应用',
    'twin_postmortem': '生成数字孪生复盘',
    'triage_and_plan': '事件分诊与任务规划',
    'collect_and_diagnose': '证据采集与诊断',
    'risk_check_and_execute': '风险检查与受控执行',
    'verify_and_postmortem': '恢复验证与复盘',
    'triage': '事件分诊',
    'diagnose': '事件诊断',
    'repair': '受控修复',
    'verify': '恢复验证',
    'postmortem': '事件复盘'
  };

  var messageTypes = {
    'task_plan': '任务计划',
    'evidence_request': '证据采集请求',
    'evidence_result': '证据采集结果',
    'diagnosis_candidate': '诊断候选',
    'risk_decision': '风险决策',
    'approval_request': '人工审批请求',
    'approval_result': '人工审批结果',
    'execution_result': '执行结果',
    'verification_result': '验证结果',
    'postmortem_result': '复盘结果',
    'matrix_leader_dm': 'Matrix 指挥官私聊通道'
  };

  var skills = {
    'system_metrics_collector': '系统指标采集',
    'evidence_analyzer': '证据分析',
    'runbook_matcher': '运行手册匹配',
    'twin-evidence-collector': '数字孪生证据采集',
    'twin_recovery_verifier': '数字孪生恢复验证',
    'twin-recovery-verifier': '数字孪生恢复验证'
  };

  function rememberRaw(element, raw) {
    if (element && raw && element.nodeType === 1 && !element.title) {
      element.title = '原始标识：' + raw;
    }
  }

  function translateToken(raw) {
    var value = String(raw || '').trim();
    return exact[value] || agents[value] || tasks[value] || messageTypes[value] || skills[value] || value;
  }

  function translateTrace() {
    if (window.page !== 'trace' && typeof page !== 'undefined' && page !== 'trace') return;
    var body = document.getElementById('traceBody');
    if (!body) return;

    var subtitle = document.getElementById('pageSub');
    if (subtitle) subtitle.textContent = '任务拆解、上下文传递、智能体运行、技能运行、工具调用和人工审批全程可追溯';
    var title = document.getElementById('pageTitle');
    if (title) title.textContent = '智能体追踪';
    document.querySelectorAll('#nav button').forEach(function (button) {
      if (button.textContent.trim() === 'Agent Trace') button.textContent = '智能体追踪';
      if (button.textContent.trim() === 'Skill Runs') button.textContent = '技能运行';
    });
    document.querySelectorAll('#content select option').forEach(function (option) {
      option.textContent = option.textContent
        .replace(/gateway_latency/g, '网关高延迟')
        .replace(/payment_bad_config/g, '支付配置异常')
        .replace(/desktop_app_stopped/g, '桌面应用停止')
        .replace(/\bresolved\b/gi, '已解决')
        .replace(/\bwaiting_approval\b/gi, '等待人工审批')
        .replace(/\bfailed\b/gi, '已失败');
    });

    body.querySelectorAll('.badge').forEach(function (node) {
      var raw = node.textContent.trim();
      var translated = translateToken(raw);
      if (translated !== raw) {
        rememberRaw(node, raw);
        node.textContent = translated;
      }
    });

    body.querySelectorAll('.tl b').forEach(function (node) {
      var raw = node.textContent.trim();
      if (raw.indexOf(' → ') >= 0) {
        node.textContent = raw.split(' → ').map(function (part) { return agents[part] || part; }).join(' → ');
      } else if (agents[raw]) {
        rememberRaw(node, raw);
        node.textContent = agents[raw];
      }
    });

    body.querySelectorAll('.tl > div:not(.mono)').forEach(function (node) {
      var raw = node.textContent.trim();
      var separator = raw.indexOf(' · ');
      var first = separator >= 0 ? raw.slice(0, separator) : raw;
      var translated = translateToken(first);
      if (translated !== first) {
        rememberRaw(node, first);
        node.textContent = translated + (separator >= 0 ? raw.slice(separator) : '');
      }
    });

    body.querySelectorAll('.mono.muted').forEach(function (node) {
      node.innerHTML = node.innerHTML
        .replace(/\brun=/g, '运行记录=')
        .replace(/\bparent=Human\b/g, '父任务=人工触发')
        .replace(/\bparent=/g, '父任务=');
    });

    body.querySelectorAll('td').forEach(function (node) {
      var raw = node.textContent.trim();
      var at = raw.indexOf('@');
      var skillId = at >= 0 ? raw.slice(0, at) : raw;
      if (skills[skillId]) {
        rememberRaw(node, skillId);
        node.textContent = skills[skillId] + (at >= 0 ? ' @ ' + raw.slice(at + 1) : '');
      }
    });

    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    var nodes = [], current;
    while ((current = walker.nextNode())) nodes.push(current);
    nodes.forEach(function (node) {
      var raw = node.nodeValue;
      var trimmed = raw.trim();
      if (exact[trimmed]) node.nodeValue = raw.replace(trimmed, exact[trimmed]);
      else if (trimmed === '完整证据JSON') node.nodeValue = raw.replace(trimmed, '完整原始证据 JSON（技术字段保留英文）');
    });
  }

  window.trace = async function () {
    await originalTrace.apply(this, arguments);
    translateTrace();
  };

  window.__INTELLIOPS_TRACE_CN__ = true;
}());
