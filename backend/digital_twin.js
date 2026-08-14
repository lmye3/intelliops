'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const path = require('node:path');

const COMPONENTS = [
  { id: 'gateway', name: '孪生API网关', port: 8871, kind: 'managed_service' },
  { id: 'payment', name: '孪生支付服务', port: 8872, kind: 'managed_service' },
  { id: 'inventory-app', name: '孪生库存受管应用', port: 8873, kind: 'managed_application' }
];

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

class DigitalTwinManager {
  constructor() {
    this.components = new Map(COMPONENTS.map(item => [item.id, {
      ...item, server: null, process: null, pid: null, generation: 0,
      config: { latency_ms: 15, error_rate: 0, healthy: true },
      baseline: { latency_ms: 15, error_rate: 0, healthy: true },
      requests: [], changes: []
    }]));
  }

  async startAll() {
    for (const item of this.components.values()) await this.start(item.id);
    return this.status();
  }

  async start(id) {
    const component = this.components.get(id);
    if (!component) throw new Error('unknown_twin_component');
    if (component.kind === 'managed_application') {
      if (component.process && component.process.exitCode === null) return component;
      const script = path.join(__dirname, 'twin_app.js');
      const processValue = childProcess.spawn(process.execPath, [script, String(component.port), component.id, String(process.pid)], {
        cwd: __dirname, windowsHide: true, stdio: 'ignore'
      });
      component.process = processValue; component.pid = processValue.pid; component.generation += 1;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (processValue.exitCode !== null) throw new Error('managed_twin_application_exited');
        try { const response = await fetch(`http://127.0.0.1:${component.port}/health`, { signal: AbortSignal.timeout(300) }); if (response.ok) return component; } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      processValue.kill(); throw new Error('managed_twin_application_start_timeout');
    }
    if (component.server && component.server.listening) return component;
    const server = http.createServer(async (req, res) => {
      const started = Date.now();
      const requestId = crypto.randomUUID();
      if (req.url === '/health') {
        const ok = component.config.healthy;
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, component: component.id, generation: component.generation, mode: 'real_local_http_twin' }));
      } else if (req.url === '/work') {
        await new Promise(resolve => setTimeout(resolve, component.config.latency_ms));
        const failed = Math.random() < component.config.error_rate || !component.config.healthy;
        res.writeHead(failed ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !failed, request_id: requestId, component: component.id }));
      } else {
        res.writeHead(404); res.end();
      }
      component.requests.push({ request_id: requestId, path: req.url, status: res.statusCode, duration_ms: Date.now() - started, at: new Date().toISOString() });
      if (component.requests.length > 500) component.requests.splice(0, component.requests.length - 500);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(component.port, '127.0.0.1', resolve);
    });
    component.server = server;
    component.pid = process.pid;
    component.generation += 1;
    return component;
  }

  async stop(id) {
    const component = this.components.get(id);
    if (!component) throw new Error('unknown_twin_component');
    if (component.kind === 'managed_application') {
      if (!component.process || component.process.exitCode !== null) return;
      const processValue = component.process; component.process = null;
      processValue.kill('SIGTERM');
      await Promise.race([new Promise(resolve => processValue.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
      if (processValue.exitCode === null) processValue.kill();
      return;
    }
    if (!component.server) return;
    const server = component.server;
    component.server = null;
    await new Promise(resolve => server.close(resolve));
  }

  async stopAll() {
    for (const item of this.components.values()) await this.stop(item.id);
  }

  async reset() {
    for (const item of this.components.values()) {
      item.config = { ...item.baseline };
      if ((item.kind === 'managed_application' && (!item.process || item.process.exitCode !== null)) || (item.kind !== 'managed_application' && (!item.server || !item.server.listening))) await this.start(item.id);
      item.changes.push({ at: new Date().toISOString(), action: 'restore_baseline', config: { ...item.config } });
    }
    return this.status();
  }

  async inject(scenario) {
    const recipes = {
      gateway_latency: { component_id: 'gateway', fault: { latency_ms: 480 }, recovery: 'restore_config', risk_level: 'L1' },
      payment_bad_config: { component_id: 'payment', fault: { error_rate: 1, healthy: false }, recovery: 'restore_config', risk_level: 'L1' },
      payment_service_crash: { component_id: 'payment', stop: true, recovery: 'restart_service', risk_level: 'L2' },
      inventory_app_crash: { component_id: 'inventory-app', stop: true, recovery: 'restart_managed_application', risk_level: 'L3' }
    };
    const recipe = recipes[scenario];
    if (!recipe) throw new Error('scenario_not_allowlisted');
    const component = this.components.get(recipe.component_id);
    const before = this.publicComponent(component);
    if (recipe.stop) await this.stop(component.id);
    else Object.assign(component.config, recipe.fault);
    component.changes.push({ at: new Date().toISOString(), action: 'inject_fault', scenario, before, after: this.publicComponent(component) });
    return { scenario, ...recipe, before, after: this.publicComponent(component), execution_mode: 'sandbox' };
  }

  async recover(action, componentId) {
    const component = this.components.get(componentId);
    if (!component) throw new Error('unknown_twin_component');
    const allowed = {
      restore_config: ['gateway', 'payment'],
      restart_service: ['gateway', 'payment'],
      restart_managed_application: ['inventory-app']
    };
    if (!allowed[action] || !allowed[action].includes(componentId)) throw new Error('recovery_not_allowlisted');
    const before = this.publicComponent(component);
    if (action === 'restore_config') component.config = { ...component.baseline };
    else {
      await this.stop(componentId);
      component.config = { ...component.baseline };
      await this.start(componentId);
    }
    const record = { at: new Date().toISOString(), action, before, after: this.publicComponent(component), execution_mode: 'sandbox', arbitrary_shell: false };
    component.changes.push(record);
    return record;
  }

  async probe(id, count = 8) {
    const component = this.components.get(id);
    if (!component) throw new Error('unknown_twin_component');
    const samples = [];
    for (let index = 0; index < Math.max(1, Math.min(20, count)); index += 1) {
      const started = Date.now();
      try {
        const response = await fetch(`http://127.0.0.1:${component.port}/work`, { signal: AbortSignal.timeout(1200) });
        samples.push({ ok: response.ok, status: response.status, duration_ms: Date.now() - started, at: new Date().toISOString() });
      } catch (error) {
        samples.push({ ok: false, status: 0, duration_ms: Date.now() - started, error: String(error.message || error), at: new Date().toISOString() });
      }
    }
    const failed = samples.filter(item => !item.ok).length;
    return {
      component_id: id, source: 'real_local_http_requests', checked_at: new Date().toISOString(),
      request_count: samples.length, success_count: samples.length - failed,
      error_count: failed, error_rate: Math.round(failed / samples.length * 10000) / 100,
      p95_latency_ms: percentile(samples.map(item => item.duration_ms), 0.95), samples
    };
  }

  publicComponent(component) {
    return {
      id: component.id, name: component.name, kind: component.kind, port: component.port,
      running: component.kind === 'managed_application' ? Boolean(component.process && component.process.exitCode === null) : Boolean(component.server && component.server.listening), pid: component.pid,
      generation: component.generation, config: { ...component.config },
      request_count: component.requests.length, latest_change: component.changes.at(-1) || null
    };
  }

  status() {
    return {
      mode: 'real_local_http_digital_twin', generated_at: new Date().toISOString(),
      components: [...this.components.values()].map(item => this.publicComponent(item)),
      allowed_scenarios: ['gateway_latency', 'payment_bad_config', 'payment_service_crash', 'inventory_app_crash'],
      allowed_recoveries: ['restore_config', 'restart_service', 'restart_managed_application'],
      arbitrary_shell_allowed: false
    };
  }
}

module.exports = { DigitalTwinManager, COMPONENTS };
