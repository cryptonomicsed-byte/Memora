// SiteLedger backed by the published memora Move package on Sui.
//
// Writes are single-command PTBs against memora::site. Reads decode the Site
// object and its proposal Table entries straight from BCS, so the
// layouts below must match contracts/memora/sources/site.move field for
// field. Aborts in memora::site are re-raised as the same MoveAbort the
// SimulatedLedger throws, so tools and agents handle both identically.

import { bcs } from "@mysten/sui/bcs";
import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, normalizeSuiAddress, toHex } from "@mysten/sui/utils";
import { MoveAbort } from "./ledger.ts";
import type { LedgerEvent, Proposal, Site, SiteLedger } from "./ledger.ts";

// ── BCS layouts (mirror site.move) ──────────────────────────────────────────
const VecSet = bcs.struct("VecSet", { contents: bcs.vector(bcs.Address) });

export const VersionBcs = bcs.struct("Version", {
  blob_id: bcs.string(),
  manifest_root: bcs.vector(bcs.u8()),
  promoted_ms: bcs.u64(),
  attesters: bcs.vector(bcs.Address),
  revoked: bcs.bool(),
});

export const ProposalBcs = bcs.struct("Proposal", {
  blob_id: bcs.string(),
  manifest_root: bcs.vector(bcs.u8()),
  proposer: bcs.Address,
  approvals: VecSet,
  clean: VecSet,
  flagged: VecSet,
  created_ms: bcs.u64(),
});

export const SiteBcs = bcs.struct("Site", {
  id: bcs.Address,
  name: bcs.string(),
  signers: VecSet,
  threshold: bcs.u64(),
  required_reviews: bcs.u64(),
  versions: bcs.vector(VersionBcs),
  live: bcs.u64(),
  has_live: bcs.bool(),
  frozen: bcs.bool(),
  proposals: bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }),
  next_proposal: bcs.u64(),
});

export const SiteEvents = {
  SiteCreated: bcs.struct("SiteCreated", { site: bcs.Address, name: bcs.string(), threshold: bcs.u64(), required_reviews: bcs.u64() }),
  Proposed: bcs.struct("Proposed", {
    site: bcs.Address,
    proposal: bcs.u64(),
    blob_id: bcs.string(),
    manifest_root: bcs.vector(bcs.u8()),
    proposer: bcs.Address,
  }),
  Approved: bcs.struct("Approved", { site: bcs.Address, proposal: bcs.u64(), signer: bcs.Address, approvals: bcs.u64() }),
  Attested: bcs.struct("Attested", { site: bcs.Address, proposal: bcs.u64(), sentinel: bcs.Address, clean: bcs.bool() }),
  Promoted: bcs.struct("Promoted", { site: bcs.Address, version: bcs.u64(), blob_id: bcs.string(), manifest_root: bcs.vector(bcs.u8()) }),
  RolledBack: bcs.struct("RolledBack", { site: bcs.Address, from: bcs.u64(), to: bcs.u64(), by: bcs.Address }),
  Frozen: bcs.struct("Frozen", { site: bcs.Address, by: bcs.Address }),
  Revoked: bcs.struct("Revoked", { site: bcs.Address, version: bcs.u64(), attesters: bcs.vector(bcs.Address), by: bcs.Address }),
};
const EventBcs: Record<string, { parse(bytes: Uint8Array): unknown }> = SiteEvents;

// ── Minimal client surface (satisfied by SuiGrpcClient.core / SuiGraphQLClient.core) ──
interface ChainEvent {
  eventType: string;
  bcs: Uint8Array;
}

interface ExecResult {
  $kind: "Transaction" | "FailedTransaction";
  Transaction?: ExecTx;
  FailedTransaction?: ExecTx;
}

interface ExecTx {
  digest: string;
  status: { success: boolean; error: null | { message: string; $kind?: string; MoveAbort?: { abortCode: string; location?: { module?: string; functionName?: string } } } };
  events?: ChainEvent[];
  objectTypes?: Record<string, string>;
}

export interface SuiCore {
  getObject(o: { objectId: string; include: { content: true } }): Promise<{ object: { content: Uint8Array } }>;
  getDynamicField(o: { parentId: string; name: { type: string; bcs: Uint8Array } }): Promise<{ dynamicField: { value: { bcs: Uint8Array } } }>;
  signAndExecuteTransaction(o: {
    transaction: Transaction;
    signer: Signer;
    include: { events: true; objectTypes: true; effects: true };
  }): Promise<ExecResult>;
  waitForTransaction(o: { digest: string }): Promise<unknown>;
  listEvents(o: { filter: { eventType: string }; limit?: number }): Promise<{ events: ChainEvent[] }>;
}

export interface SuiLedgerConfig {
  packageId: string;
  /** Shared sentinel_registry::Registry object ID (needed by attest). */
  registryId: string;
  signer: Signer;
  core: SuiCore;
  /** How many trailing proposal slots getSite scans for pending proposals. */
  proposalScanWindow?: number;
}

const u64 = (n: number) => BigInt(n);
const num = (v: string | number | bigint) => Number(v);
const hex = (b: Iterable<number>) => toHex(Uint8Array.from(b));

export class SuiLedger implements SiteLedger {
  private cfg: SuiLedgerConfig;
  readonly address: string;

  constructor(cfg: SuiLedgerConfig) {
    this.cfg = cfg;
    this.address = normalizeSuiAddress(cfg.signer.toSuiAddress());
  }

  private target(fn: string) {
    return `${this.cfg.packageId}::site::${fn}` as const;
  }

  // The chain decides the sender from the key. Refuse to act "as" anyone else.
  private assertSender(sender: string) {
    if (normalizeSuiAddress(sender) !== this.address)
      throw new Error(`this ledger signs as ${this.address}; cannot act as ${sender}`);
  }

  private async exec(fn: string, build: (tx: Transaction) => void): Promise<ExecTx> {
    const tx = new Transaction();
    build(tx);
    const res = await this.cfg.core.signAndExecuteTransaction({
      transaction: tx,
      signer: this.cfg.signer,
      include: { events: true, objectTypes: true, effects: true },
    });
    const t = (res.Transaction ?? res.FailedTransaction)!;
    if (!t.status.success) {
      const err = t.status.error;
      const abort = err?.$kind === "MoveAbort" ? err.MoveAbort : undefined;
      if (abort && (abort.location?.module ?? "site") === "site") throw new MoveAbort(num(abort.abortCode), fn);
      throw new Error(`memora::site::${fn} failed: ${err?.message ?? "unknown error"}`);
    }
    await this.cfg.core.waitForTransaction({ digest: t.digest });
    return t;
  }

  private event(t: ExecTx, name: string) {
    const e = t.events?.find((e) => e.eventType === `${this.cfg.packageId}::site::${name}`);
    if (!e) throw new Error(`expected ${name} event in ${t.digest}`);
    return EventBcs[name].parse(e.bcs) as Record<string, any>;
  }

  async createSite(sender: string, name: string, signers: string[], threshold: number, requiredReviews: number) {
    this.assertSender(sender);
    const t = await this.exec("create", (tx) =>
      tx.moveCall({
        target: this.target("create"),
        arguments: [
          tx.pure.string(name),
          tx.pure.vector("address", signers),
          tx.pure.u64(u64(threshold)),
          tx.pure.u64(u64(requiredReviews)),
        ],
      }),
    );
    return normalizeSuiAddress(this.event(t, "SiteCreated").site);
  }

  async propose(sender: string, siteId: string, blobId: string, manifestRoot: string) {
    this.assertSender(sender);
    const t = await this.exec("propose", (tx) =>
      tx.moveCall({
        target: this.target("propose"),
        arguments: [tx.object(siteId), tx.pure.string(blobId), tx.pure.vector("u8", fromHex(manifestRoot)), tx.object.clock()],
      }),
    );
    return num(this.event(t, "Proposed").proposal);
  }

  async approve(sender: string, siteId: string, proposal: number) {
    this.assertSender(sender);
    await this.exec("approve", (tx) =>
      tx.moveCall({ target: this.target("approve"), arguments: [tx.object(siteId), tx.pure.u64(u64(proposal))] }),
    );
  }

  async attest(sender: string, siteId: string, proposal: number, clean: boolean) {
    this.assertSender(sender);
    await this.exec("attest", (tx) =>
      tx.moveCall({
        target: this.target("attest"),
        arguments: [tx.object(siteId), tx.object(this.cfg.registryId), tx.pure.u64(u64(proposal)), tx.pure.bool(clean)],
      }),
    );
  }

  async promote(sender: string, siteId: string, proposal: number) {
    this.assertSender(sender);
    const t = await this.exec("promote", (tx) =>
      tx.moveCall({ target: this.target("promote"), arguments: [tx.object(siteId), tx.pure.u64(u64(proposal)), tx.object.clock()] }),
    );
    return num(this.event(t, "Promoted").version);
  }

  async rollback(sender: string, siteId: string, to: number) {
    this.assertSender(sender);
    await this.exec("rollback", (tx) =>
      tx.moveCall({ target: this.target("rollback"), arguments: [tx.object(siteId), tx.pure.u64(u64(to))] }),
    );
  }

  async freeze(sender: string, siteId: string) {
    this.assertSender(sender);
    await this.exec("freeze_site", (tx) => tx.moveCall({ target: this.target("freeze_site"), arguments: [tx.object(siteId)] }));
  }

  async revoke(sender: string, siteId: string, version: number) {
    this.assertSender(sender);
    await this.exec("revoke", (tx) =>
      tx.moveCall({ target: this.target("revoke"), arguments: [tx.object(siteId), tx.pure.u64(u64(version))] }),
    );
  }

  async getSite(siteId: string): Promise<Site> {
    const { object } = await this.cfg.core.getObject({ objectId: siteId, include: { content: true } });
    const s = SiteBcs.parse(object.content);
    const next = num(s.next_proposal);
    const window = this.cfg.proposalScanWindow ?? 50;
    const proposals: Record<string, Proposal> = {};
    // Promoted proposals are removed from the Table, so a missing slot is normal.
    const slots = Array.from({ length: Math.min(next, window) }, (_, i) => next - 1 - i);
    await Promise.all(
      slots.map(async (id) => {
        try {
          const { dynamicField } = await this.cfg.core.getDynamicField({
            parentId: s.proposals.id,
            name: { type: "u64", bcs: bcs.u64().serialize(u64(id)).toBytes() },
          });
          const p = ProposalBcs.parse(dynamicField.value.bcs);
          proposals[id] = {
            id,
            blobId: p.blob_id,
            manifestRoot: hex(p.manifest_root),
            proposer: p.proposer,
            approvals: p.approvals.contents,
            clean: p.clean.contents,
            flagged: p.flagged.contents,
            createdMs: num(p.created_ms),
          };
        } catch {
          /* slot empty: already promoted */
        }
      }),
    );
    return {
      id: normalizeSuiAddress(s.id),
      name: s.name,
      signers: s.signers.contents,
      threshold: num(s.threshold),
      requiredReviews: num(s.required_reviews),
      versions: s.versions.map((v) => ({
        blobId: v.blob_id,
        manifestRoot: hex(v.manifest_root),
        promotedMs: num(v.promoted_ms),
        attesters: v.attesters,
        revoked: v.revoked,
      })),
      live: num(s.live),
      hasLive: s.has_live,
      frozen: s.frozen,
      proposals,
      nextProposal: next,
    };
  }

  /** First page (≤50) of memora::site events, optionally filtered to one Site. */
  async events(siteId?: string): Promise<LedgerEvent[]> {
    const { events } = await this.cfg.core.listEvents({ filter: { eventType: `${this.cfg.packageId}::site` }, limit: 50 });
    const want = siteId && normalizeSuiAddress(siteId);
    const out: LedgerEvent[] = [];
    for (const e of events) {
      const type = e.eventType.split("::").pop()!;
      const layout = EventBcs[type];
      if (!layout) continue;
      const data = layout.parse(e.bcs) as Record<string, unknown>;
      const site = normalizeSuiAddress(data.site as string);
      if (want && site !== want) continue;
      out.push({ ...data, type, site });
    }
    return out;
  }
}
