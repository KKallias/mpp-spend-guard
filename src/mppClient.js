'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { privateKeyToAccount } = require('viem/accounts');
const { Mppx, tempo } = require('mppx/client');

/**
 * createMppClient — real mppx-backed implementation of the `.pay(challenge)`
 * interface guardedPay() expects, wired to Tempo's Moderato testnet.
 *
 * mppx handles HTTP 402 transparently: on a 402 it reads the Challenge, signs
 * a Credential with the wallet, and retries the request. `challenge.resource`
 * here is the URL of the MPP-protected endpoint being paid for.
 *
 * ## Why there's a ceiling check
 *
 * SpendGuard evaluates a challenge that was observed at some earlier moment.
 * By the time pay() runs, it issues a *fresh* request and the server replies
 * with a *new* challenge — which does not have to quote the same price. MPP
 * services are allowed to price dynamically (the mpp.dev directory lists
 * services ranging $0.05–$4 per call), so without a check, a server could
 * quote a cheap price when probed and a much higher one when actually paid.
 * The guard would log "allowed: 100000" while the wallet paid far more.
 *
 * So pay() enforces the approved amount as a hard ceiling inside mppx's
 * `onChallenge` hook, which runs *before* the credential is signed. If the
 * live challenge asks for more than the guard approved — or no valid approved
 * amount was passed at all — we throw and no payment is ever signed or sent.
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

  // Carries per-call state into the onChallenge hook: the approved ceiling and
  // whether we have let mppx sign a credential. Uses AsyncLocalStorage rather
  // than a closure variable so concurrent pay() calls can't read each other's.
  const callStore = new AsyncLocalStorage();

  // polyfill: false — keep globalThis.fetch untouched so callers can still
  // make plain, unpaid probe requests; only mppx.fetch() is payment-aware.
  const mppx = Mppx.create({
    methods: [tempo({ account })],
    polyfill: false,
    onChallenge: async (challenge) => {
      const ctx = callStore.getStore();
      const ceiling = ctx && ctx.ceiling;
      // Fail closed: never sign without a valid approved amount.
      if (!Number.isInteger(ceiling) || ceiling < 0) {
        throw new Error(
          `no valid approved amount — refusing to sign (got ${JSON.stringify(ceiling === undefined ? 'undefined' : String(ceiling))})`,
        );
      }
      const quoted = Number(challenge.request && challenge.request.amount);
      if (!Number.isFinite(quoted)) {
        throw new Error(
          `MPP challenge has no readable amount (got ${JSON.stringify(challenge.request && challenge.request.amount)}) — refusing to sign`,
        );
      }
      if (quoted > ceiling) {
        throw new Error(
          `MPP challenge asks for ${quoted} but the guard only approved ${ceiling} — refusing to sign`,
        );
      }
      // From here on mppx signs and sends a credential: any later failure means
      // the payment outcome is unknown.
      ctx.signed = true;
      // Returning undefined lets mppx sign the credential as normal.
      return undefined;
    },
  });

  return {
    account,

    /**
     * @param {object} challenge
     * @param {string} challenge.resource     URL of the MPP-protected resource to pay for.
     * @param {number} challenge.amountMinor  Amount the guard approved; enforced as a
     *   hard ceiling on what the live challenge is allowed to charge. Required —
     *   without it the client refuses to sign.
     * @param {object} [opts]
     * @param {number} [opts.timeoutMs=30000]  Abort the whole paid fetch after this long.
     * @returns {Promise<object>} Receipt-like object (status, receipt header + decoded receipt, body).
     * @throws {Error} with `.code`:
     *   - 'TIMEOUT_BEFORE_SIGNING' — timed out before any credential was signed; nothing paid.
     *   - 'OUTCOME_UNKNOWN'        — failed after signing; the payment may have settled.
     *   - 'PAYMENT_FAILED'         — any other failure (refused to sign, still 402, ...).
     */
    async pay(challenge, { timeoutMs = 30_000 } = {}) {
      const ctx = { ceiling: challenge.amountMinor, signed: false };
      const signal = AbortSignal.timeout(timeoutMs);

      let response;
      try {
        response = await callStore.run(ctx, () => mppx.fetch(challenge.resource, { signal }));
      } catch (err) {
        if (ctx.signed) {
          throw withCode(
            `MPP payment outcome unknown — credential may have been sent: ${err.message}`,
            'OUTCOME_UNKNOWN',
            err,
          );
        }
        if (isAbortError(err)) {
          throw withCode(
            `MPP request timed out after ${timeoutMs}ms before signing — nothing was paid`,
            'TIMEOUT_BEFORE_SIGNING',
            err,
          );
        }
        throw withCode(`MPP payment failed: ${err.message}`, 'PAYMENT_FAILED', err);
      }

      if (response.status === 402) {
        // Guard already approved this, but the live endpoint still rejected
        // the payment (e.g. expired challenge, insufficient balance).
        const body = await response.text();
        throw withCode(`MPP payment failed: still 402 after retry — ${body}`, 'PAYMENT_FAILED');
      }

      const receiptHeader = response.headers.get('payment-receipt');
      const body = await response.text();

      return {
        status: response.status,
        receiptHeader,
        receipt: decodeReceipt(receiptHeader),
        body,
      };
    },
  };
}

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.name === 'TimeoutError' ||
    (err.cause && (err.cause.name === 'AbortError' || err.cause.name === 'TimeoutError')));
}

function withCode(message, code, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

/**
 * Decodes the base64url `Payment-Receipt` header into an object, so callers get
 * the settlement reference (tx hash) without decoding it themselves. Returns
 * null if the header is absent or unparseable — a receipt we can't read is not
 * worth throwing over, the payment already succeeded.
 */
function decodeReceipt(receiptHeader) {
  if (!receiptHeader) return null;
  try {
    return JSON.parse(Buffer.from(receiptHeader, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { createMppClient, decodeReceipt };
