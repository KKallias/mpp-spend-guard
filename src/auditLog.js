'use strict';

const fs = require('fs');
const path = require('path');

/**
 * AuditLog — append-only JSON-lines log of every SpendGuard decision.
 * One line per decision, so the file is grep-able and diffable, and can be
 * reconciled later against MPP's own balance/ledger view.
 */
class AuditLog {
  /** @param {string} filePath  Where to write the log. Defaults to ./audit.log */
  constructor(filePath = path.join(process.cwd(), 'audit.log')) {
    this.filePath = filePath;
  }

  /**
   * @param {object} entry
   * @param {object} entry.challenge   The MPP Challenge that was evaluated.
   * @param {object} entry.decision    The result returned by SpendGuard.evaluate(), or a
   *                                   payment-outcome record written by guardedPay.
   * @param {string} [entry.paymentId] Payment id, for reconciliation.
   * @param {string} [entry.note]      Free-text note (e.g. reconciliation instructions).
   */
  record({ challenge, decision, paymentId, note }) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      resource: challenge && challenge.resource,
      amountMinor: challenge && safeAmount(challenge.amountMinor),
      recipient: challenge && challenge.recipient,
      allowed: decision.allowed,
      reason: decision.reason,
      sessionSpentMinor: decision.sessionSpentMinor,
      ...(paymentId !== undefined ? { paymentId } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    fs.appendFileSync(this.filePath, line + '\n');
    return line;
  }

  /** Read back all logged entries (useful for tests and reconciliation reports). */
  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
}

// JSON.stringify throws on bigint and silently turns NaN/Infinity into null;
// keep malformed amounts visible in the log instead.
function safeAmount(v) {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}

module.exports = { AuditLog };
