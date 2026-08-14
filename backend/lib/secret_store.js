'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');

function powershell(script, input) {
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || 'DPAPI operation failed').trim());
  return String(result.stdout || '').trim();
}

function save(file, value) {
  if (process.platform !== 'win32') throw new Error('persistent_secret_store_requires_windows');
  const secret = String(value || '');
  if (!secret) { try { fs.unlinkSync(file); } catch (_) { /* already absent */ } return false; }
  const script = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)";
  const encrypted = powershell(script, secret);
  fs.writeFileSync(file, encrypted, { encoding: 'ascii', mode: 0o600 });
  return true;
}

function load(file) {
  if (process.platform !== 'win32' || !fs.existsSync(file)) return '';
  const encrypted = fs.readFileSync(file, 'ascii').trim();
  if (!encrypted) return '';
  const script = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$p=[Convert]::FromBase64String($v);$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($b)";
  return powershell(script, encrypted);
}

function exists(file) { return fs.existsSync(file) && fs.statSync(file).size > 0; }

module.exports = { save, load, exists };
