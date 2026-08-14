'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function append(state, eventId, evidenceType, payload, metadata = {}) {
  if (!Array.isArray(state.evidence_ledger)) state.evidence_ledger = [];
  const previous = [...state.evidence_ledger].reverse().find(item => item.event_id === eventId);
  const createdAt = new Date().toISOString();
  const payloadHash = sha256(canonical(payload));
  const record = {
    sequence: previous ? previous.sequence + 1 : 1,
    evidence_id: `ev_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
    event_id: eventId, evidence_type: evidenceType, created_at: createdAt,
    actor: metadata.actor || 'system', trace_id: metadata.trace_id || '',
    payload_hash: payloadHash, previous_hash: previous ? previous.chain_hash : 'GENESIS'
  };
  record.chain_hash = sha256(`${record.previous_hash}|${canonical(record)}`);
  state.evidence_ledger.push(record);
  return record;
}

function verify(records) {
  let previousHash = 'GENESIS';
  let expectedSequence = 1;
  for (const record of records) {
    if (record.sequence !== expectedSequence || record.previous_hash !== previousHash) {
      return { valid: false, checked: expectedSequence - 1, failed_sequence: record.sequence, reason: 'sequence_or_previous_hash_mismatch' };
    }
    const copy = { ...record };
    delete copy.chain_hash;
    const expected = sha256(`${record.previous_hash}|${canonical(copy)}`);
    if (expected !== record.chain_hash) return { valid: false, checked: expectedSequence - 1, failed_sequence: record.sequence, reason: 'chain_hash_mismatch' };
    previousHash = record.chain_hash;
    expectedSequence += 1;
  }
  return { valid: true, checked: records.length, head_hash: previousHash };
}

function recordsFor(state, eventId) {
  return (state.evidence_ledger || []).filter(item => item.event_id === eventId).sort((a, b) => a.sequence - b.sequence);
}

function manifest(files) {
  const hashes = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(canonical(value))]));
  return { algorithm: 'SHA-256', generated_at: new Date().toISOString(), file_hashes: hashes, root_hash: sha256(canonical(hashes)) };
}

module.exports = { canonical, sha256, append, verify, recordsFor, manifest };
