# DropLedger

**An on-chain journal for airdrop farmers — built for the Binance Agent ID
Hackathon (submission period 18 Nov – 9 Dec 2026).**

If you follow 20+ crypto projects, you have to remember: which projects did
I join? What tasks are done? Which wallet did I use? When did I last act? Is
this project still alive? DropLedger is the notebook that answers all of
that — stored on-chain, under your Agent ID identity.

## What it is

- **Projects** — add a project (name, chain, wallet label, notes) and track
  its lifecycle: Active / Paused / Ended / TGE.
- **Tasks** — each project has a checklist (Social, On-chain, Testnet,
  Daily, Weekly, Other; recurring or one-off). Check tasks off, or add
  several at once in a single transaction to save gas.
- **Dashboard** — projects, tasks done, tasks remaining, per-project
  progress bars, and last-activity timestamps so stale projects stand out.
- **On-chain** — every entry is a transaction on BNB Chain, readable by
  anyone, writable only by you.

## How Agent ID is used

Agent ID is the access control **and** the identity of the journal:

- **Write access** — only addresses holding an Agent ID (SPACE ID ERC-721,
  non-transferable, `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` on BNB Chain)
  can create projects or log tasks. The contract checks
  `balanceOf(msg.sender) > 0` on the Agent ID contract on every write.
- **Identity** — your journal lives at your address, and that address is
  the one holding your `name.ai` Agent ID. The journal is your agent's
  on-chain work record.
- **Reads are public** — anyone can view any journal without an Agent ID.
  The frontend shows a clear read-only notice (with how to claim an Agent ID
  in the Binance App) instead of failing silently when a connected wallet
  holds no Agent ID.
- Agent ID is **not** used as a wallet-lookup-by-name tool: journals are
  addressed by wallet address, and the app never resolves names to wallets.

## Repo layout

```
dropledger/
├── README.md                 — this file
├── contract/
│   ├── foundry.toml          — Foundry config (solc 0.8.24)
│   ├── src/DropLedger.sol    — the journal contract (no funds, no owner,
│   │                           no upgradeability, no pause switch)
│   ├── test/DropLedger.t.sol — 17 Foundry tests (incl. mock Agent ID ERC-721)
│   └── lib-forge-std/        — vendored forge-std (test dependency)
└── frontend/
    ├── index.html            — single-page app (mobile-first)
    ├── styles.css            — own dark-theme design
    └── app.js                — ethers v6 via CDN; contract addresses live in
                                the CONFIG block at the top of the file
```

## Run the tests

Foundry is required (`forge`). From `contract/`:

```sh
forge test
```

17 tests, all passing. Coverage: the Agent ID write gate (non-holders
revert on every write; access is lost if the ID is burned), project
create/update, task add/complete/batch, stats math, `lastActivityAt`
bumps, per-user isolation, and public reads.

## Deploy + verify

> Testnet first, mainnet only after the testnet deployment is verified
> working end-to-end in the frontend.

**1. Get testnet BNB (free).** Create a fresh throwaway wallet and claim
0.1 tBNB from the official faucet at
<https://testnet.bnbchain.org/faucet-smart-chain> (or any public tBNB faucet).
Never reuse a wallet that holds real funds for testnet deploys.

**2. Deploy to BNB Chain Testnet (Chapel, chain id 97).** The constructor
takes the Agent ID contract address. NOTE (verified 2026-11-18): the real
Agent ID registry (`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`) has NO code
on testnet — it is mainnet-only. For the testnet deployment, first deploy
a minimal mock ERC-721 with `balanceOf` (the test file
`test/DropLedger.t.sol` contains one — extract it), mint a mock Agent ID
to the wallet you will test with, then deploy DropLedger with the mock's
address as the constructor arg. On mainnet, use the real registry address.

```sh
cd contract
forge create src/DropLedger.sol:DropLedger \
  --rpc-url https://bsc-testnet.publicnode.com \
  --private-key <THROWAWAY_TESTNET_KEY> \
  --constructor-args <AGENT_ID_ADDRESS> \
  --verify --verifier-url https://api-testnet.bscscan.com/api \
  --etherscan-api-key <BSCSCAN_API_KEY>
```

**3. Test in the frontend.** Paste the testnet contract address into the
`CONFIG.contracts[97]` slot at the top of `frontend/app.js`, serve the
`frontend/` directory (any static host — see below), connect a wallet
holding a testnet Agent ID, and exercise create-project / add-task /
complete-task.

**4. Deploy to BNB Chain mainnet (chain id 56)** with the same command
against `https://bsc.publicnode.com` and the mainnet BscScan verifier
(`https://api.bscscan.com/api`). Deployment gas is small (a simple contract,
a few dollars at most); confirm the exact gas quote before signing.
Paste the mainnet address into `CONFIG.contracts[56]`.

**5. Verify on BscScan.** `--verify` above handles it. The verified source
must match this repo exactly — the hackathon requires source-verified,
open-source contracts.

## Host the frontend (free options)

The frontend is static (HTML/CSS/JS, no backend, no build step). Any free
static host works: GitHub Pages, Cloudflare Pages, Vercel (free tier), or
Netlify Drop. Deploy the `frontend/` directory as-is and use the resulting
public URL as the project website in the hackathon submission.

## Hackathon submission checklist

- [ ] Contract deployed on BNB Chain mainnet, source verified on BscScan.
- [ ] Contract is open-source (this repo) with permissions disclosed:
      no owner, no funds held, no upgradeability, no pause.
- [ ] Website (hosted frontend URL) live and working on mobile.
- [ ] Agent ID usage description: "Only Agent ID holders can write journal
      entries; the journal is the holder's on-chain farming record under
      their Agent ID identity; reads are public."
- [ ] Innovation Award eligibility: product live + at least 30 Agent ID
      addresses interacting with the contract during the submission period
      (18 Nov – 9 Dec 2026). Drive this with X posts in the Agent ID
      community (#AgenticWallet), the hackathon community, and airdrop
      farmer groups — the ask is one cheap transaction to start a journal.

## Known limits (honest)

- **Journal data is public on-chain by design.** Anyone can read any
  journal. Users must never log seeds, private keys, API secrets, or
  anything sensitive — the UI warns about this on the notes field and in
  the footer.
- **Manual logging.** Entries are logged by the user; DropLedger does not
  auto-read wallet activity across chains (that would be a separate,
  much larger product).
- **One journal per address.** The journal is keyed by wallet address, so
  farmers with several wallets keep one journal per wallet (the
  per-project wallet label records which wallet a project uses).
- **Gas per write.** Every entry costs a small BNB gas fee; batch task
  creation (`addTasksBatch`) exists to keep this cheap.
- **No backend, no accounts.** There is no server, no database, and no
  login beyond the wallet connection. If the contract address in
  `app.js` is not set, the app shows a "not deployed yet" notice.
