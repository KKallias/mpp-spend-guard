'use strict';

const { privateKeyToAccount } = require('viem/accounts');
const { Mppx, tempo } = require('mppx/client');

/**
 * createMppClient — real mppx-backed implementation of the `.pay(challenge)`
 * interface guardedPay() expects, wired to Tempo's Moderato testnet.
 *
 * mppx works by patching `fetch` to transparently handle HTTP 402 responses:
 * on a 402 it reads the Challenge, signs a Credential with the wallet, and
 * retries the request. `challenge.resource` here is the URL of the
 * MPP-protected endpoint being paid for.
 *
 * @param {object} [opts]
 * @param {string} [opts.privateKey]  Defaults to AGENT_WALLET_PRIVATE_KEY env var.
 */
function createMppClient(opts = {}) {
  const privateKey = opts.privateKey || process.env.AGENT_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('createMppClient requires a private key (AGENT_WALLET_PRIVATE_KEY)');
  }

  const account = privateKeyToAccount(privateKey);
  // polyfill: false — keep globalThis.fetch untouched so callers can still
  // make plain, unpaid probe requests; only mppx.fetch() is payment-aware.
  const mppx = Mppx.create({
    methods: [tempo({ account })],
    polyfill: false,
  });

  return {
    account,

    /**
     * @param {object} challenge
     * @param {string} challenge.resource  URL of the MPP-protected resource to pay for.
     * @returns {Promise<object>} Receipt-like object (status, receipt header, response body).
     */
    async pay(challenge) {
      const response = await mppx.fetch(challenge.resource);

      if (response.status === 402) {
        // Guard already approved this, but the live endpoint still rejected
        // the payment (e.g. expired challenge, insufficient balance).
        const body = await response.text();
        throw new Error(`MPP payment failed: still 402 after retry — ${body}`);
      }

      const receiptHeader = response.headers.get('payment-receipt');
      const body = await response.text();

      return {
        status: response.status,
        receiptHeader,
        body,
      };
    },
  };
}

module.exports = { createMppClient };
