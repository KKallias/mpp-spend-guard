# mpp-spend-guard

![Status](https://img.shields.io/badge/status-MVP%20%2F%20testnet%20verified-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue)

> **Status: MVP / testnet only.** Verified end-to-end against a live
> MPP-protected endpoint on Tempo's Moderato testnet. Holds no real funds
> and is not ready for production use.

Pre-payment spend-limit check + audit log for agents transacting over the
[Machine Payments Protocol (MPP)](https://mpp.dev) — Stripe & Tempo's open
standard for billing AI agents over HTTP (launched March 2026).

Same idea as [x402-spend-guard](https://github.com/KKallias/x402-spend-guard),
ported to MPP's "session" model: before your agent authorizes a payment for an
MPP `Challenge` (the 402 response describing price + payment options),
SpendGuard checks it against configured limits and logs the decision —
**before** money moves, not after.

## What it checks

- **Per-request cap** — reject any single charge above a configured max
- **Session cap** — reject once cumulative session spend would exceed a max
- **Rate limit** — reject if too many requests happen in a rolling window
- **Recipient allowlist** (optional) — reject payments to unrecognized recipients

Every decision — allowed or blocked — is appended to `audit.log` as one JSON
line, so it's grep-able and can later be reconciled against MPP's own
balance/ledger view.

## Status

- [x] Core decision engine (`src/spendGuard.js`)
- [x] Audit logging (`src/auditLog.js`)
- [x] Unit tests, 6/6 passing, zero network dependency (`npm test`)
- [x] Wired to the real MPP client (`mppx`) against Tempo's Moderato testnet (`src/mppClient.js`)
- [x] End-to-end run with a real approved payment and a real blocked request (see below)

## Quickstart (logic only, no network needed)

```bash
npm test
```

## Wiring to the real SDK

The guard is deliberately decoupled from any MPP client — `guardedPay()`
takes any object with an async `.pay(challenge)` method. [`src/mppClient.js`](src/mppClient.js)
implements that interface for real using [`mppx`](https://www.npmjs.com/package/mppx)
(MPP's official TypeScript/Node SDK) against Tempo's Moderato testnet.

1. **Install the SDK.**
   ```bash
   npm install mppx viem
   ```

2. **Create + fund a testnet wallet.** Tempo's Moderato testnet has a public
   faucet (as of Aug 2026 the working endpoint is under `tempo.xyz`, not
   `docs.tempo.xyz` — always check `tempo.xyz/developers/docs/quickstart/faucet`
   for the current one):
   ```bash
   curl -X POST https://tempo.xyz/developers/api/faucet \
     -H "Content-Type: application/json" \
     -d '{"address": "<your-wallet-address>"}'
   ```
   This drips 1,000,000 units each of pathUSD, AlphaUSD, BetaUSD and ThetaUSD.

3. **`createMppClient()`** (in `src/mppClient.js`) wraps `mppx/client`'s
   payment-aware `fetch`:
   ```js
   const { createMppClient } = require('./src/mppClient');
   const mppClient = createMppClient({ privateKey: process.env.AGENT_WALLET_PRIVATE_KEY });
   ```
   Internally it does:
   ```js
   const mppx = Mppx.create({ methods: [tempo({ account })], polyfill: false });
   // mppx.fetch() auto-handles a 402: signs a Credential, retries, returns the paid response
   ```

4. **Use `guardedPay` in place of a direct payment call:**
   ```js
   const { guardedPay, SpendGuard } = require('./src');
   const guard = new SpendGuard({ perRequestCapMinor: 200_000, sessionCapMinor: 1_000_000 });

   const { paid, receipt, decision } = await guardedPay(mppClient, challenge, guard);
   if (!paid) {
     console.log('Blocked:', decision.reason);
   }
   ```

5. `scripts/run-testnet-session.js` runs a full real session — see below for
   the actual output.

## Real testnet run (Tempo Moderato, Aug 2026)

Ran [`scripts/run-testnet-session.js`](scripts/run-testnet-session.js) against
the live MPP-protected endpoint **`https://mpp.dev/api/ping/paid`**
(from [mpp.dev](https://mpp.dev)'s own service catalog), using a freshly
generated Tempo Moderato testnet wallet:

- **Wallet address:** `0x12b9bE35DB1EbF5F98251a3c591D2e4E45a5843C`
- **Chain:** Tempo Moderato testnet, chainId `42431` (`https://rpc.moderato.tempo.xyz`)
- **Funded via faucet:** `POST https://tempo.xyz/developers/api/faucet` — 4 txs,
  one per stablecoin (pathUSD/AlphaUSD/BetaUSD/ThetaUSD), confirmed on-chain
  (`balanceOf` went from `0` to `1,000,000,000,000` raw pathUSD units, i.e. 1M pathUSD).
- **Live challenge probed from the endpoint:** `amount: 100000` (raw units,
  6 decimals → $0.10), `currency: pathUSD`, `recipient: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`.

Two scenarios, same real challenge, two different `SpendGuard` configs:

| Scenario | Cap config | Result |
|---|---|---|
| ALLOW | `perRequestCapMinor: 200_000` ($0.20) | Guard allowed it → mppx paid the real endpoint → `200 OK` + `Payment-Receipt` header |
| BLOCK | `perRequestCapMinor: 1_000` ($0.001) | Guard blocked it (`exceeds_per_request_cap`) → mppx/network never touched |

The ALLOW scenario settled on-chain: wallet's pathUSD balance went from
`1,000,000,000,000` → `999,999,800,000` raw units (price + Tempo's
in-token network fee). Decoded `Payment-Receipt`:

```json
{"method":"tempo","status":"success","timestamp":"2026-08-06T20:29:53.255Z","reference":"0xd0a0c30d6ac30bf66c527cd9e754b5f2616a018c0310eb7c0ab95899a3063943"}
```

`audit.log` for the run — both decisions logged, exactly one paid:

```json
{"ts":"2026-08-06T20:29:52.009Z","resource":"https://mpp.dev/api/ping/paid","amountMinor":100000,"recipient":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","allowed":true,"reason":"ok","sessionSpentMinor":0}
{"ts":"2026-08-06T20:29:53.389Z","resource":"https://mpp.dev/api/ping/paid","amountMinor":100000,"recipient":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","allowed":false,"reason":"exceeds_per_request_cap","sessionSpentMinor":0}
```

To reproduce: copy `.env.example` to `.env`, fill in a funded
`AGENT_WALLET_PRIVATE_KEY`, then:

```bash
node --env-file=.env scripts/run-testnet-session.js
```

## Why MPP and not another protocol

MPP just launched (March 2026) and its tooling ecosystem is still thin —
similar position to where x402 was when the spend-guard idea started. Its
"session" primitive (pre-authorized spending limit, streamed micropayments)
maps directly onto what this guard checks, arguably more naturally than
x402's per-request-only model.

## License

[MIT](LICENSE)
