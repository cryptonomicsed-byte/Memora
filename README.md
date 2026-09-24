# Immutex

A cryptographically enforced supply-chain guardrail for dApp front-ends: a security and governance layer on top of decentralized storage. Builds are content-addressed on Walrus. What's live is governed by an on-chain Site object. Before any build can go live, it needs M-of-N signer approval and a review quorum from staked Sentinel agents.

**Agents can ship to production without being trusted:** the chain enforces the release policy, not the agent.

→ Pitch, tokenomics, and the claims to tighten: [`docs/VALUE_PROPOSITION.md`](docs/VALUE_PROPOSITION.md)

## Agent topology

```
            ┌────────────── MCP tool surface (agents/mcp-server) ──────────────┐
 Deployer ──┤ immutex_deploy ─────────────► Site.propose                        │
 Signers  ──┤ immutex_approve ────────────► Site.approve  (M-of-N)              │
 Sentinel ──┤ immutex_review_proposal ─► Rust scan ─► Site.attest (staked)      │
 Deployer ──┤ immutex_promote ────────────► Site.promote  (threshold + quorum)  │
 Guardian ──┤ immutex_verify_live / immutex_incident_response                    │
            │                    ─► freeze → rollback → revoke (1 signer)      │
 Portal   ──┤ immutex_verify_live: serve only bytes matching the on-chain root  │
 Keeper   ──┤ treasury.withdraw_buyback → DEX swap → immutex.burn_buyback         │
            └──────────────────────────────────────────────────────────────────┘
```

| Agent | Profile | Sandbox & capabilities | Memory namespace |
|---|---|---|---|
| Deployer | `agents/profiles/deployer.json` | process; read build dir, Walrus publisher, proposer key | `deployer` |
| Sentinel | `sentinel.json` | process + Rust scanner (Wasm-ready); aggregator, sentinel key | `sentinel` |
| Guardian | `guardian.json` | process; aggregator, one signer key | `guardian` |
| Portal | `portal.json` | container; aggregator, HTTP serve | `portal` |
| Keeper | `keeper.json` | process; KeeperCap, DEX router | `keeper` |

Profiles are re-read from disk on every `immutex_list_agents` call, so dropping in a new JSON file registers a new role without a restart. Memory is append-only JSONL per namespace (`immutex_remember` / `immutex_recall`). Sentinels record each verdict there and recall past reviews of a site before judging the next one.

## Languages

| Component | Language | Why |
|---|---|---|
| `contracts/immutex` | **Move** (Sui) | Object-capability model: Site, caps, and balances are typed resources, and one-tx rollback falls out naturally |
| `agents/sentinel` | **Rust** | Zero-dependency, IO-free core that parses hostile input safely and compiles to `wasm32-wasip1` for sandboxed reviewers |
| `agents/mcp-server` | **TypeScript** | Reference MCP SDK, Walrus HTTP API, and the web/JS ecosystem the scanned builds come from |

Next up: an **Elixir/OTP** supervisor for the Sentinel and Portal swarms (fault-tolerant fan-out across many sites), and **Go** for the standalone portal binary.

## Layout

```
contracts/immutex/sources/
  site.move               Site object: propose/approve/attest/promote, rollback/freeze_site/revoke
  sentinel_registry.move  IMTX bonds, 7-day unbonding, slash → burn
  treasury.move           SUI fee split: buyback / portals / sentinels / ops, holder tiers
  immutex.move               fixed-supply IMTX, burn-only BurnVault
  storage_vault.move      per-site prepaid storage renewal, capped + rate-limited keeper draws
contracts/immutex/tests/   Move unit tests (site lifecycle, aborts)
agents/sentinel/          Rust drainer/injection scanner (lib + CLI)
agents/mcp-server/        MCP server; SimulatedLedger + SuiLedger (@mysten/sui, gRPC); Walrus/FS stores
agents/profiles/          agent profiles
docs/                     value proposition
```

## Quickstart

```bash
# 1. Build the scanner
cd agents/sentinel && cargo test && cargo build --release

# 2. Run the MCP server (Node ≥ 22.18, runs TypeScript directly)
cd ../mcp-server && npm install && npm test
npm start          # stdio MCP server; state in ./.immutex
```

Register it with any MCP client, e.g. Claude Code:

```bash
claude mcp add immutex -- node /path/to/repo/agents/mcp-server/src/index.ts
```

Set `IMMUTEX_STORAGE=walrus` (and optionally `WALRUS_PUBLISHER`, `WALRUS_AGGREGATOR`, `WALRUS_EPOCHS`) to upload to Walrus testnet instead of the local filesystem store.

To run against a published package on Sui instead of the simulator:

```bash
cd contracts/immutex && sui client publish        # note the package ID and the shared Registry ID
IMMUTEX_LEDGER=sui SUI_NETWORK=testnet \
IMMUTEX_PACKAGE_ID=0x… IMMUTEX_REGISTRY_ID=0x… SUI_PRIVATE_KEY=suiprivkey1… \
npm start
```

Each agent runs its own server instance with its own key. The `actor` argument on a tool must match that key's address, because the chain, not the tool call, decides who signed.

## Status

- **Tested locally:** the Rust scanner (8 unit tests) and the MCP server (12 tests). Seven cover the full tool flow against `SimulatedLedger`, which mirrors the Move abort codes. Five cover `SuiLedger` against a mocked chain client: PTB targets and arguments, event decoding, abort mapping, and BCS decoding of the Site and its proposal Table.
- **CI (`.github/workflows/ci.yml`):** installs the latest Sui CLI release and runs `sui move build` and `sui move test`, plus the Rust and TypeScript suites. The Move package has not been compiled outside CI.
- **Not yet run against live testnet:** `SuiLedger` needs a published package. The BCS layouts in `sui-ledger.ts` must stay field-for-field in sync with `site.move`.
- **Roadmap:** Arweave and Shadow Drive `BlobStore` adapters, portal reward distribution by verified bandwidth, SuiNS resolution, yield-funded storage vaults, the Wasm-sandboxed scanner, and an Elixir/OTP supervisor for the Sentinel and Portal swarms.
