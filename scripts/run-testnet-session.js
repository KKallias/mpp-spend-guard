'use strict';

/**
 * Real end-to-end run against a live MPP-protected endpoint on Tempo's
 * Moderato testnet. Two scenarios:
 *  1. ALLOW  — a guard with normal caps pays the real endpoint.
 *  2. BLOCK  — a guard with a deliberately tiny per-request cap rejects the
 *     same challenge; mppx is never invoked, no payment is attempted.
 *
 * Run with: node --env-file=.env scripts/run-testnet-session.js
 */

const path = require('path');
const { SpendGuard, AuditLog, guardedPay } = require('../src');
const { createMppClient } = require('../src/mppClient');

const ENDPOINT = 'https://mpp.dev/api/ping/paid';

async function probeChallenge(url) {
  const res = await fetch(url);
  if (res.status !== 402) {
    throw new Error(`Expected 402 from ${url}, got ${res.status}`);
  }
  const auth = res.headers.get('www-authenticate') || '';
  const match = auth.match(/request="([^"]+)"/);
  if (!match) throw new Error(`No request= param in WWW-Authenticate: ${auth}`);
  const decoded = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  return {
    resource: url,
    amountMinor: Number(decoded.amount),
    recipient: decoded.recipient,
    currency: decoded.currency,
  };
}

async function main() {
  const auditLog = new AuditLog(path.join(process.cwd(), 'audit.log'));
  const mppClient = createMppClient();

  const challenge = await probeChallenge(ENDPOINT);
  console.log('Live challenge from', ENDPOINT, '->', challenge);

  // --- Scenario 1: ALLOWED, real payment goes through ---
  const allowGuard = new SpendGuard({
    perRequestCapMinor: 200_000, // $0.20 — above the $0.10 ping price
    sessionCapMinor: 1_000_000,
  });
  const allowedResult = await guardedPay(mppClient, challenge, allowGuard, auditLog);
  console.log('\n[ALLOW scenario]');
  console.log('paid:', allowedResult.paid, 'reason:', allowedResult.decision.reason);
  if (allowedResult.paid) {
    console.log('receipt header:', allowedResult.receipt.receiptHeader);
    console.log('response status:', allowedResult.receipt.status);
  }

  // --- Scenario 2: BLOCKED, guard rejects before any network payment call ---
  const blockGuard = new SpendGuard({
    perRequestCapMinor: 1_000, // $0.001 — well below the $0.10 ping price
    sessionCapMinor: 1_000_000,
  });
  const blockedResult = await guardedPay(mppClient, challenge, blockGuard, auditLog);
  console.log('\n[BLOCK scenario]');
  console.log('paid:', blockedResult.paid, 'reason:', blockedResult.decision.reason);

  console.log('\naudit.log entries:');
  for (const entry of auditLog.readAll()) {
    console.log(JSON.stringify(entry));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
