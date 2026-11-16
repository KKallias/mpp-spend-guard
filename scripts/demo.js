'use strict';

/**
 * Offline demo — no keys, no internet, no funds. Run: npm run demo
 *
 * One normal payment, then five attacks the guard stops. Scenarios 1-3 and 6 use a
 * stand-in client that "settles" instantly (nothing can settle offline).
 * Scenarios 4-5 run the real mppx client against a local server that changes
 * its quote between the probe and the payment.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { generatePrivateKey } = require('viem/accounts');

const { guardedPay, SpendGuard, AuditLog } = require('../src');
const { createMppClient } = require('../src/mppClient');

const SHOP = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ATTACKER = '0x000000000000000000000000000000000000dEaD';
const PATHUSD = '0x20c0000000000000000000000000000000000000';
const usd = (minor) => `$${(minor / 1e6).toFixed(2)}`;

/** Local MPP endpoint that always answers 402 with the given quote. */
function serve(quote) {
  const request = Buffer.from(JSON.stringify({
    amount: String(quote.amount),
    currency: PATHUSD,
    methodDetails: { chainId: 42431, feePayer: true },
    recipient: quote.recipient,
  })).toString('base64url');
  const server = http.createServer((req, res) => {
    res.writeHead(402, {
      'www-authenticate': `Payment id="demo", realm="localhost", method="tempo", intent="charge", request="${request}"`,
    });
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, url: `http://127.0.0.1:${server.address().port}/paid` })));
}

async function main() {
  const auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpp-demo-')), 'audit.log');
  const auditLog = new AuditLog(auditFile);
  const instant = { async pay() { return { status: 200 }; } };
  const policy = {
    perRequestCapMinor: 200_000, // $0.20 per call
    sessionCapMinor: 500_000,    // $0.50 per session
    allowedRecipients: [SHOP],
  };
  const quote = (over = {}) => ({
    resource: 'https://api.example/search', amountMinor: 100_000, recipient: SHOP, currency: PATHUSD, ...over,
  });
  const show = (n, title, r) => {
    const outcome = r.paid ? 'PAID   ' : 'BLOCKED';
    const why = r.paid ? 'within policy' : (r.error ? r.error.message : r.decision.reason);
    console.log(`${n}. ${title}\n   ${outcome}  ${why}\n`);
  };

  console.log(`Policy: max ${usd(policy.perRequestCapMinor)} per call, ${usd(policy.sessionCapMinor)} per session, one approved recipient\n`);

  let guard = new SpendGuard(policy);
  show(1, `Normal call, ${usd(100_000)} to the approved recipient`,
    await guardedPay(instant, quote(), guard, auditLog));
  show(2, `Agent tries a ${usd(4_000_000)} call`,
    await guardedPay(instant, quote({ amountMinor: 4_000_000 }), guard, auditLog));
  show(3, 'Agent tries to pay an address that is not on the allowlist',
    await guardedPay(instant, quote({ recipient: ATTACKER }), guard, auditLog));

  const mppx = createMppClient({ privateKey: generatePrivateKey() }); // throwaway key, never funded
  const hike = await serve({ amount: 4_000_000, recipient: SHOP });
  show(4, `Server quoted ${usd(100_000)} when probed, asks ${usd(4_000_000)} at payment time`,
    await guardedPay(mppx, quote({ resource: hike.url }), new SpendGuard(policy), auditLog));
  hike.server.close();

  const swap = await serve({ amount: 100_000, recipient: ATTACKER });
  show(5, 'Server keeps the price but swaps the recipient at payment time',
    await guardedPay(mppx, quote({ resource: swap.url }), new SpendGuard(policy), auditLog));
  swap.server.close();

  guard = new SpendGuard(policy);
  const burst = await Promise.all(Array.from({ length: 20 }, () => guardedPay(instant, quote(), guard, auditLog)));
  const paid = burst.filter((r) => r.paid).length;
  console.log(`6. Runaway loop: 20 calls of ${usd(100_000)} fired at once\n   ${paid} PAID, ${burst.length - paid} BLOCKED  `
    + `session spend ${usd(guard.sessionSpentMinor)} of ${usd(policy.sessionCapMinor)} cap\n`);

  const entries = auditLog.readAll();
  console.log(`Audit log: ${entries.length} decisions written, ${entries.filter((e) => e.allowed).length} allowed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
