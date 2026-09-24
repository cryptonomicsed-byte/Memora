# Memora: Value Proposition

Memora is a launchpad for dApp front-ends. Builds are content-addressed on decentralized storage (Walrus first, with Arweave and Shadow Drive planned). What is live is decided by an on-chain **Site object**, and every build is reviewed by **staked Sentinel agents** before it can go live.

## The reframe: agents are the deployers now

Today, coding agents already push to Vercel and AWS through MCP servers and CI tokens. Every one of those credentials is a standing, all-powerful key: whoever holds it (the agent, a leaked token, a hijacked GitHub account) can ship anything to production.

Memora's thesis is that **agents should be able to ship to production without being trusted.** The guardrails live on-chain, not in the agent's good behavior:

- A Deployer agent can *propose* a build, but it can't make it live.
- A build goes live only after M-of-N signer approvals **and** a quorum of Sentinel attestations, each Sentinel backed by a slashable bond.
- Any single signer (or a Guardian agent holding a signer key) can roll back to a known-good build in one transaction.

That makes Memora a deployment substrate built for autonomous agents: every capability is an MCP tool (`agents/mcp-server`), and every policy is enforced by Move (`contracts/memora`).

---

## Part 1: Why host on Memora instead of Vercel or AWS

| Threat on Web2 hosting | What Memora does | Where it lives |
|---|---|---|
| **DNS / registrar hijack, stolen CI or env secrets, injected drainer scripts** | Content is pinned by manifest root on-chain. Portals serve only bytes that hash to it. Changing the site takes a signed tx against the Site object. | `site.move::propose/promote`, `memora_verify_live` |
| **Takedown by the host or its regulators** | Content is replicated across decentralized storage nodes, and anyone can run a Portal. There is no single account to suspend. | `WalrusBlobStore`, portal profile |
| **A single developer account pushes a malicious update** | Promotion needs `threshold` signer approvals **plus** `required_reviews` clean Sentinel attestations. Each flag raises the bar by one. | `site.move::promote` |
| **Slow rollback during an active exploit** | Every promoted build is kept immutably. One signer, one tx: `freeze` → `rollback` → `revoke`. | `memora_incident_response` |
| **Nobody reviews the shipped JS** | Staked Sentinels diff each build against the live one and flag new approvals, raw `eth_sign`, `eval`, new external origins, and encoded payloads. | `agents/sentinel` (Rust) |

**Pitch for developers:** *Ship in one call from your agent or CI to content-addressed, multi-sig-governed hosting. A stolen token can propose a drainer, but it can't make it live. If something bad does go live, one signer reverts it in a single transaction.*

## Part 2: Why hold MEMO

| Mechanism | How it works | Where it lives |
|---|---|---|
| **Fee-funded buyback & burn** | Deploy, storage-extension, and domain fees are paid in SUI and split on-chain (default 40% buyback, 30% portals, 20% sentinels, 10% ops). A Keeper agent swaps the buyback pool for MEMO and burns it through a shared `BurnVault`. There is no mint function after genesis. | `treasury.move`, `memo.move` |
| **Portal operator rewards** | Portal nodes that serve verified bytes share the portal pool. | `treasury::withdraw_portal_rewards` (distribution logic on the roadmap) |
| **Sentinel staking** | Reviewing builds requires a MEMO bond with a 7-day unbonding window. Attesting to a build later revoked as malicious is slashable, and slashed MEMO is burned. | `sentinel_registry.move` |
| **Holder tiers** | Locked MEMO reduces fees: ≥1k MEMO 20% off, ≥25k 40% off with priority routing, ≥250k 60% off with continuous Sentinel monitoring. | `treasury::discount_bps` |

**Pitch for holders:** *MEMO is the bond that makes agent reviews trustworthy, and the sink for fees from every deployment on the platform.*

---

## Claims to tighten before this goes public

The original pitch overstates a few things. Sophisticated developers and regulators will notice.

1. **"Un-hackable" isn't true.** Signer keys can still be phished. The honest claim is narrower and still strong: *no single credential can change what users see*. Say that instead.
2. **Public portals are a chokepoint.** Most users reach a Walrus site through a public HTTP portal, which can be geo-blocked or taken down. Censorship resistance holds for the *content* and for anyone who runs their own portal. Ship a one-command portal and SuiNS-native resolution to back the claim up.
3. **Storage expires.** Walrus storage is paid per epoch. "Can't be taken down" needs auto-renewal, which is a Keeper agent job and a fee source.
4. **The front-end still calls centralized RPCs and APIs.** The Sentinel's `new_origins` diff surfaces these, but hosting alone doesn't remove them.
5. **Token language.** Phrases like "creating upward price pressure" and "invest" tie the token to profit from others' efforts, which is the core of a securities analysis in most jurisdictions. Present MEMO as a bond and fee instrument, keep burn accounting public, and get legal review before launch. The buyback also only matters if fee revenue is large relative to unlocks and emissions, so publish that ratio.
6. **Competition.** Mysten's own Walrus Sites already covers basic hosting. The moat is what Walrus Sites doesn't have: **staked, slashable, agent-run build review, on-chain release policy, and an MCP-native deploy surface.** Lead with those.
