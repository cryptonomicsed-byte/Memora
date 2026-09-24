# Immutex: Value Proposition

**Immutex is a cryptographically enforced supply-chain guardrail for dApp front-ends. It's a security and governance layer that sits on top of raw decentralized storage.**

Builds are stored content-addressed on Walrus first, with Arweave and Shadow Drive planned. What users actually see is decided by an on-chain **Site object**. A build becomes live only after M-of-N signer approval **and** a quorum of reviews from **staked Sentinels** whose bonds can be slashed.

## The reframe: agents are the deployers now

Coding agents already ship to production through raw CI tokens and cloud APIs. Each of those credentials is a standing key that can deploy anything. An agent that gets hijacked, or one that hallucinates a malicious dependency, ships straight to users.

Immutex lets agents ship to production **without being trusted**. The guardrails are enforced by the chain, not by the agent's behavior:

- A Deployer agent can *propose* a build. It can't make it live.
- Promotion needs `threshold` signer approvals **and** `required_reviews` clean Sentinel attestations. Each flag raises the required number of clean reviews by one.
- Any single signer, including a Guardian agent holding one signer key, can freeze or roll back in one transaction.

Every capability is an MCP tool (`agents/mcp-server`), and every rule is enforced in Move (`contracts/immutex`).

---

## Part 1: Why developers deploy through Immutex

### 1. Defense in depth, not "un-hackable"

Keys can still be phished and signers can still be socially engineered. Immutex doesn't pretend otherwise. What it guarantees is narrower and verifiable: **no single compromised credential, API key, CI pipeline, or rogue agent can change what live users are served.** An attacker needs to compromise `threshold` independent signers *and* get past `required_reviews` bonded Sentinels, each of whom loses stake if they approve a drainer.

| Web2 failure mode | Immutex control | Where |
|---|---|---|
| Stolen CI or env secrets inject a drainer | A proposal alone can't go live. It needs signer threshold plus Sentinel quorum | `site::promote` |
| DNS or registrar hijack points users elsewhere | Content is pinned by manifest root on-chain, and portals serve only bytes that hash to it | `immutex_verify_live` |
| A single developer account pushes malicious code | M-of-N approval, and Sentinels diff the build against the live one | `site::approve`, `agents/sentinel` |
| Rollback takes minutes or hours mid-incident | One signer, one tx: `freeze_site` → `rollback` → `revoke` | `immutex_incident_response` |

### 2. Multi-portal access, honestly scoped

Files stored on Walrus or Arweave persist independently of any company. **Most people still reach a site through an HTTP portal** (for example, wal.app), and any single portal can be blocked or taken down. Immutex treats portals as a **redundant fallback network**, not a single front door:

- Every portal verifies bytes against the on-chain manifest root, so users get the same content whichever portal serves it.
- Portal operators earn from the portal reward pool, so the network isn't one company's gateway.
- dApps are encouraged to publish several gateways, including one they self-host, alongside SuiNS resolution.

The accurate claim: **content can't be altered or erased by one party, and access survives as long as any honest portal is reachable.**

### 3. Durable availability through storage vaults

Decentralized blob storage isn't permanent by default. Walrus storage is paid per epoch and expires if it isn't renewed. Immutex makes renewal programmatic:

- Each site can have a **Storage Vault** (`storage_vault.move`) that anyone can fund: the team, a DAO, or its users.
- A Keeper agent draws from the vault and extends the site's blobs in the same transaction. Draws are capped per call and rate-limited, so a compromised keeper can take at most one bounded draw per day. Every draw emits the blob ID it was meant to renew, so it can be audited.
- *Roadmap:* fund vaults from staking yield (for example, StakedSui or WAL staking rewards), so a site can pay for its own storage indefinitely from principal.

### 4. The security and governance layer on top of Walrus Sites

Mysten's `walrus-sites` tooling handles storing and indexing static sites well. Immutex doesn't compete with that layer. It adds what that layer doesn't have:

| | Walrus Sites | Immutex |
|---|---|---|
| Content-addressed storage | ✅ | ✅ (on Walrus, plus planned Arweave and Shadow Drive adapters) |
| Multi-sig or DAO approval before a build goes live | — | ✅ `site::approve` / `promote` |
| Automated drainer and injection scanning | — | ✅ Rust Sentinel, diffed against the live build |
| Staked, slashable review consensus | — | ✅ `sentinel_registry` |
| One-tx rollback with revocation of bad builds | — | ✅ `site::rollback` / `revoke` |
| MCP-native surface for autonomous agents | — | ✅ 15 tools |
| Programmatic storage renewal | — | ✅ `storage_vault` |

**For developers:** *Let your agents and CI ship to decentralized storage with the guardrails production needs. A stolen token can propose a build but can't make it live, and one signer can revert anything that slips through.*

---

## Part 2: The IMMUTEX token's role

IMMUTEX exists to make the review layer trustworthy and to account for how much the protocol is used. The description below is functional. It isn't a promise of price performance.

| Function | Mechanism | Where |
|---|---|---|
| **Security bond** | Sentinels must bond IMMUTEX to review builds. The 7-day unbonding window prevents approve-and-exit. Stake slashed for attesting to a revoked build is **burned**, not redistributed, so reviewers gain nothing from colluding to slash each other. | `sentinel_registry.move` |
| **Usage-based supply contraction** | Deploy, storage-renewal, and domain fees are paid in SUI and split on-chain (default 40% buyback, 30% portals, 20% Sentinels, 10% operations). A Keeper agent converts the buyback share to IMMUTEX and burns it through a vault that exposes no mint function. Contraction tracks actual protocol usage. | `treasury.move`, `immutex.move` |
| **Service rewards** | Portal operators earn for verified bandwidth. Sentinels earn for security verification. Both are paid from protocol fees, not new issuance. | `treasury::withdraw_*` |
| **Fee tiers** | Locking IMMUTEX reduces platform fees (20%, 40%, or 60% off) and unlocks priority routing and continuous monitoring. | `treasury::discount_bps` |

**Language guidance for all public material:** say "usage-based supply contraction via programmatic protocol-fee burns" and "staking rewards for bandwidth and security-verification services". Avoid "investment", "returns", "price pressure", and any statement about future value. Publish burn and fee accounting directly from on-chain events (`Burned`, `FeePaid`, `PoolWithdrawn`). Get jurisdiction-specific legal review before any token distribution.

---

## Known limitations

These should appear anywhere the pitch does:

1. Signer and Sentinel keys remain attack targets. Threshold and bonding raise the cost of an attack. They don't eliminate it.
2. The scanner is heuristic. It catches known drainer patterns and new external origins, not every possible attack. Human-reviewed exceptions go through the `review` verdict.
3. A front-end can still call centralized RPCs and APIs at runtime. The Sentinel flags new origins, but hosting alone doesn't decentralize them.
4. Storage renewal depends on vaults being funded, and yield-funded vaults are still on the roadmap.
5. Fee-based burns are only significant if fee revenue is material relative to token unlocks. Publish both figures.
