# Memora

An agent-native launchpad for dApp front-ends. Builds are content-addressed on decentralized storage. What's live is governed by an on-chain Site object. Before any build can go live, it is reviewed by staked Sentinel agents.

**Agents can ship to production without being trusted:** the chain enforces the release policy, not the agent.

→ Pitch, tokenomics, and the claims to tighten: [`docs/VALUE_PROPOSITION.md`](docs/VALUE_PROPOSITION.md)

## Agent topology

```
            ┌────────────── MCP tool surface (agents/mcp-server) ──────────────┐
 Deployer ──┤ memora_deploy ─────────────► Site.propose                        │
 Signers  ──┤ memora_approve ────────────► Site.approve  (M-of-N)              │
 Sentinel ──┤ memora_review_proposal ─► Rust scan ─► Site.attest (staked)      │
 Deployer ──┤ memora_promote ────────────► Site.promote  (threshold + quorum)  │
 Guardian ──┤ memora_verify_live / memora_incident_response                    │
            │                    ─► freeze → rollback → revoke (1 signer)      │
 Portal   ──┤ memora_verify_live: serve only bytes matching the on-chain root  │
 Keeper   ──┤ treasury.withdraw_buyback → DEX swap → memo.burn_buyback         │
            └──────────────────────────────────────────────────────────────────┘
```

| Agent | Profile | Sandbox & capabilities | Memory namespace |
|---|---|---|---|
| Deployer | `agents/profiles/deployer.json` | process; read build dir, Walrus publisher, proposer key | `deployer` |
| Sentinel | `sentinel.json` | process + Rust scanner (Wasm-ready); aggregator, sentinel key | `sentinel` |
| Guardian | `guardian.json` | process; aggregator, one signer key | `guardian` |
| Portal | `portal.json` | container; aggregator, HTTP serve | `portal` |
| Keeper | `keeper.json` | process; KeeperCap, DEX router | `keeper` |

Profiles are re-read from disk on every `memora_list_agents` call, so dropping in a new JSON file registers a new role without a restart. Memory is append-only JSONL per namespace (`memora_remember` / `memora_recall`). Sentinels record each verdict there and recall past reviews of a site before judging the next one.

## Languages

| Component | Language | Why |
|---|---|---|
| `contracts/memora` | **Move** (Sui) | Object-capability model: Site, caps, and balances are typed resources, and one-tx rollback falls out naturally |
| `agents/sentinel` | **Rust** | Zero-dependency, IO-free core that parses hostile input safely and compiles to `wasm32-wasip1` for sandboxed reviewers |
| `agents/mcp-server` | **TypeScript** | Reference MCP SDK, Walrus HTTP API, and the web/JS ecosystem the scanned builds come from |

Next up: an **Elixir/OTP** supervisor for the Sentinel and Portal swarms (fault-tolerant fan-out across many sites), and **Go** for the standalone portal binary.

## Layout

```
contracts/memora/sources/
  site.move               Site object: propose/approve/attest/promote, rollback/freeze/revoke
  sentinel_registry.move  MEMO bonds, 7-day unbonding, slash → burn
  treasury.move           SUI fee split: buyback / portals / sentinels / ops, holder tiers
  memo.move               fixed-supply MEMO, burn-only BurnVault
agents/sentinel/          Rust drainer/injection scanner (lib + CLI)
agents/mcp-server/        MCP server, simulated ledger mirroring the Move rules, Walrus/FS stores
agents/profiles/          agent profiles
docs/                     value proposition
```

## Quickstart

```bash
# 1. Build the scanner
cd agents/sentinel && cargo test && cargo build --release

# 2. Run the MCP server (Node ≥ 22.18, runs TypeScript directly)
cd ../mcp-server && npm install && npm test
npm start          # stdio MCP server; state in ./.memora
```

Register it with any MCP client, e.g. Claude Code:

```bash
claude mcp add memora -- node /path/to/Memora/agents/mcp-server/src/index.ts
```

Set `MEMORA_STORAGE=walrus` (and optionally `WALRUS_PUBLISHER`, `WALRUS_AGGREGATOR`, `WALRUS_EPOCHS`) to upload to Walrus testnet instead of the local filesystem store.

## Status

- **Tested:** the Rust scanner (8 unit tests) and the MCP tool flow (7 tests). The tool-flow tests cover the full lifecycle: a clean build ships, an injected drainer gets flagged and promotion aborts, a tampered blob is caught, and incident response rolls back and revokes. They run against a simulated ledger that mirrors the Move abort codes.
- **Not yet compiled:** the Move package. It targets Sui Move 2024 edition; run `sui move build` before publishing.
- **Roadmap:** a Sui ledger adapter (PTBs against the published package, replacing `SimulatedLedger` behind the same `SiteLedger` interface), Arweave and Shadow Drive `BlobStore` adapters, portal reward distribution by verified bandwidth, SuiNS resolution, storage auto-renewal, and the Wasm-sandboxed scanner.
