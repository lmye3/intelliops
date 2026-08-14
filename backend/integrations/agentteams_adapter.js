'use strict';

const crypto = require('node:crypto');

function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('AgentTeams Controller only allows http/https');
  if (url.username || url.password) throw new TypeError('URL中禁止嵌入凭据');
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(url.hostname.toLowerCase()) && process.env.INTELLIOPS_AGENTTEAMS_ALLOW_REMOTE !== '1') {
    throw new TypeError('Only a local AgentTeams Controller is allowed by default');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function listFrom(data, key) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data[key])) return data[key];
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function versionFrom(data) {
  return String(data && (data.version || data.gitVersion || data.appVersion || data.tag || data.controller) || 'unknown');
}

class AgentTeamsAdapter {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ? normalizeBaseUrl(options.baseUrl) : '';
    this.token = String(options.token || '');
    this.matrixUrl = options.matrixUrl ? normalizeBaseUrl(options.matrixUrl) : '';
    this.matrixToken = String(options.matrixToken || '');
    this.matrixUserId = String(options.matrixUserId || '');
    this.teamName = String(options.teamName || 'intelliops-operations');
    this.timeoutMs = Math.max(1000, Math.min(15000, Number(options.timeoutMs || 5000)));
  }

  headers(json = false, matrix = false) {
    const headers = {};
    const token = matrix ? this.matrixToken : this.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  async request(path, options = {}) {
    if (!this.baseUrl) throw new Error('agentteams_controller_not_configured');
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers(Boolean(options.body)), ...(options.headers || {}) },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    let data = text;
    if (text && response.headers.get('content-type')?.includes('json')) {
      try { data = JSON.parse(text); } catch (_) { throw new Error(`Invalid AgentTeams JSON: ${path}`); }
    }
    if (!response.ok) throw new Error(`AgentTeams ${path} HTTP ${response.status}`);
    return data;
  }

  async status() {
    const checkedAt = new Date().toISOString();
    if (!this.baseUrl) return {
      connected: false, mode: 'local_verified', reason: 'controller_not_configured', checked_at: checkedAt,
      contract: 'AgentTeams v1.2.2', evidence_level: 'local_contract_only', task_dispatch_ready: false
    };
    try {
      const health = await this.request('/healthz');
      const [status, version, teamsData, workersData] = await Promise.all([
        this.request('/api/v1/status'), this.request('/api/v1/version'),
        this.request('/api/v1/teams'), this.request('/api/v1/workers')
      ]);
      const teams = listFrom(teamsData, 'teams');
      const workers = listFrom(workersData, 'workers');
      const dispatchReady = Boolean(this.matrixUrl && this.matrixToken && this.matrixUserId);
      return {
        connected: true, mode: 'official_agentteams', checked_at: checkedAt,
        controller_url: this.baseUrl, controller_health: health, controller: version,
        controller_version: versionFrom(version), cluster: status, teams, workers,
        intelliops_team_present: teams.some(item => item && (item.name === this.teamName || item.teamName === this.teamName || item.metadata?.name === this.teamName)),
        task_dispatch_ready: dispatchReady,
        task_dispatch_reason: dispatchReady ? '' : 'matrix_temporary_session_not_available',
        evidence_level: 'official_controller_api_verified'
      };
    } catch (error) {
      return {
        connected: false, mode: 'local_verified', controller_url: this.baseUrl,
        reason: String(error.message || error), checked_at: checkedAt, evidence_level: 'connection_failed',
        task_dispatch_ready: false
      };
    }
  }

  workerSpecs(model) {
    return [
      ['commander', 'Alert aggregation, task decomposition and dispatch; never repairs directly'],
      ['detective', 'Evidence collection and structured diagnosis; never repairs directly'],
      ['ranger', 'Runbook matching, risk checks, approval and controlled execution'],
      ['sage', 'Postmortem and lessons; never mutates original audit records']
    ].map(([suffix, identity]) => ({ name: `intelliops-${suffix}`, model, identity, runtime: 'openclaw' }));
  }

  async provisionIntelliOpsTeam(model) {
    const workerSpecs = this.workerSpecs(model);
    const current = listFrom(await this.request('/api/v1/workers'), 'workers');
    const existing = new Set(current.map(item => item && (item.name || item.metadata?.name)));
    const created = [];
    for (const spec of workerSpecs) {
      if (!existing.has(spec.name)) {
        await this.request('/api/v1/workers', { method: 'POST', body: JSON.stringify(spec) });
        created.push(spec.name);
      }
    }
    const teams = listFrom(await this.request('/api/v1/teams'), 'teams');
    if (!teams.some(item => item && (item.name === this.teamName || item.teamName === this.teamName || item.metadata?.name === this.teamName))) {
      await this.request('/api/v1/teams', {
        method: 'POST',
        body: JSON.stringify({
          name: this.teamName, description: 'IntelliOps auditable operations workflow', peerMentions: true,
          workerMembers: workerSpecs.map((item, index) => ({ name: item.name, role: index === 0 ? 'team_leader' : 'worker' }))
        })
      });
    }
    return { status: 'accepted', team_name: this.teamName, created_workers: created, requested_workers: workerSpecs.map(item => item.name) };
  }

  async dispatchIncident(incident, trace) {
    if (!this.matrixUrl || !this.matrixToken || !this.matrixUserId) throw new Error('matrix_temporary_session_not_available');
    const team = await this.request(`/api/v1/teams/${encodeURIComponent(this.teamName)}`);
    const roomId = team.leaderDMRoomID || team.status?.leaderDMRoomID;
    if (!roomId) throw new Error('agentteams_leader_dm_room_not_ready');
    const transactionId = crypto.randomUUID();
    const correlationToken = `intelliops:${incident.id}:${trace.plan.trace_id}:${transactionId}`;
    const payload = {
      msgtype: 'm.text',
      body: [
        'IntelliOps official incident task',
        `event_id: ${incident.id}`,
        `title: ${incident.title}`,
        `severity: ${incident.severity}`,
        `service: ${incident.service || 'unknown'}`,
        `description: ${incident.description || ''}`,
        `trace_id: ${trace.plan.trace_id}`,
        `correlation_token: ${correlationToken}`,
        'Delegate read-only evidence collection and diagnosis to the team. Return a concise conclusion with worker names and evidence. Do not execute system changes; all repair actions remain governed by IntelliOps approval policy.'
      ].join('\n'),
      'm.mentions': { user_ids: [] }
    };
    const response = await fetch(`${this.matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`, {
      method: 'PUT', headers: this.headers(true, true), body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Matrix dispatch HTTP ${response.status}`);
    return {
      dispatch_id: crypto.randomUUID(), status: 'WAITING_RESULT', runtime: 'official_agentteams',
      transport: 'matrix_leader_dm', team_name: this.teamName, room_id: roomId,
      matrix_event_id: data.event_id, transaction_id: transactionId,
      event_id: incident.id, trace_id: trace.plan.trace_id, correlation_token: correlationToken,
      sender_user_id: this.matrixUserId, sent_at: new Date().toISOString(),
      result_event_id: '', result_sender: '', result_text: '', finished_at: null
    };
  }

  async pollDispatchResult(dispatch, timeoutMs = 300000, intervalMs = 5000) {
    if (!dispatch || !dispatch.room_id || !dispatch.sent_at || !dispatch.event_id || !dispatch.trace_id) throw new Error('invalid_dispatch_record');
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    const sentAt = Date.parse(dispatch.sent_at);
    while (Date.now() < deadline) {
      const response = await fetch(`${this.matrixUrl}/_matrix/client/v3/rooms/${encodeURIComponent(dispatch.room_id)}/messages?dir=b&limit=100`, {
        headers: this.headers(false, true), signal: AbortSignal.timeout(this.timeoutMs)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Matrix messages HTTP ${response.status}`);
      const event = (data.chunk || []).find(item => {
        if (!item || item.type !== 'm.room.message' || item.sender === dispatch.sender_user_id) return false;
        if (Number(item.origin_server_ts || 0) < sentAt || item.event_id === dispatch.matrix_event_id) return false;
        const body = String(item.content?.body || '').trim();
        if (!body) return false;
        const replyTo = item.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
        const explicitCorrelation = body.includes(dispatch.correlation_token || '__missing_correlation__');
        const scopedIds = body.includes(dispatch.event_id) && body.includes(dispatch.trace_id);
        return replyTo === dispatch.matrix_event_id || explicitCorrelation || scopedIds;
      });
      if (event) return {
        status: 'SUCCEEDED', result_event_id: event.event_id, result_sender: event.sender,
        result_text: String(event.content.body).slice(0, 12000), finished_at: new Date().toISOString()
      };
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return { status: 'TIMED_OUT', finished_at: new Date().toISOString(), error: 'official_agentteams_result_timeout' };
  }
}

module.exports = { AgentTeamsAdapter, normalizeBaseUrl, listFrom, versionFrom };
