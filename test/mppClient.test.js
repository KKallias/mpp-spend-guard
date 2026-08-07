'use strict';

/**
 * Tests for the real mppx-backed client. These exercise the parts we own —
 * the price-ceiling enforcement and receipt decoding — without touching the
 * network: a fake MPP-protected server is served over loopback, and mppx's
 * real 402 handling runs against it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generatePrivateKey } = require('viem/accounts');

const { createMppClient, decodeReceipt } = require('../src/mppClient');

/**
 * Serves a 402 quoting `amount`, so we can assert what the client does with
 * the quote. Payment itself is never completed — the ceiling check must fire
 * before any credential is signed, which is exactly what we're testing.
 */
function startChallengeServer(amount) {
  const request = Buffer.from(
    JSON.stringify({
      amount: String(amount),
      currency: '0x20c0000000000000000000000000000000000000',
      methodDetails: { chainId: 42431, feePayer: true },
      recipient: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    }),
  ).toString('base64url');

  const server = http.createServer((req, res) => {
    res.writeHead(402, {
      'content-type': 'application/problem+json',
      'www-authenticate': `Payment id="test-challenge", realm="localhost", method="tempo", intent="charge", request="${request}"`,
    });
    res.end(JSON.stringify({ status: 402, title: 'Payment Required' }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/paid` });
    });
  });
}

test('refuses to sign when the live challenge quotes more than the guard approved', async () => {
  const { server, url } = await startChallengeServer(500_000); // server wants $0.50
  try {
    const client = createMppClient({ privateKey: generatePrivateKey() });

    await assert.rejects(
      () => client.pay({ resource: url, amountMinor: 100_000 }), // guard approved $0.10
      /asks for 500000 but the guard only approved 100000/,
    );
  } finally {
    server.close();
  }
});

test('does not reject when the live challenge quotes at or below the approved amount', async () => {
  const { server, url } = await startChallengeServer(100_000);
  try {
    const client = createMppClient({ privateKey: generatePrivateKey() });

    // The ceiling check passes, so mppx proceeds to sign and retry. The fake
    // server always replies 402, so pay() surfaces that instead — proving the
    // failure came from settlement, not from the ceiling check.
    await assert.rejects(
      () => client.pay({ resource: url, amountMinor: 100_000 }),
      (err) => {
        assert.doesNotMatch(err.message, /guard only approved/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('requires a private key', () => {
  const saved = process.env.AGENT_WALLET_PRIVATE_KEY;
  delete process.env.AGENT_WALLET_PRIVATE_KEY;
  try {
    assert.throws(() => createMppClient(), /requires a private key/);
  } finally {
    if (saved !== undefined) process.env.AGENT_WALLET_PRIVATE_KEY = saved;
  }
});

test('decodes a Payment-Receipt header into the settlement reference', () => {
  const receipt = {
    method: 'tempo',
    status: 'success',
    reference: '0xd0a0c30d6ac30bf66c527cd9e754b5f2616a018c0310eb7c0ab95899a3063943',
  };
  const header = Buffer.from(JSON.stringify(receipt)).toString('base64url');

  assert.deepEqual(decodeReceipt(header), receipt);
});

test('decodeReceipt returns null for a missing or unreadable header', () => {
  assert.equal(decodeReceipt(null), null);
  assert.equal(decodeReceipt('not-valid-base64-json'), null);
});
