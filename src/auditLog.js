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
   * @param {object} entry.decision    The result returned by SpendGuard.evaluate().
   */
  record({ challenge, decision }) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      resource: challenge && challenge.resource,
      amountMinor: challenge && challenge.amountMinor,
      recipient: challenge && challenge.recipient,
      allowed: decision.allowed,
      reason: decision.reason,
      sessionSpentMinor: decision.sessionSpentMinor,
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

module.exports = { AuditLog };
