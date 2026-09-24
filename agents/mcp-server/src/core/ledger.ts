// SiteLedger: the chain-facing port. `SimulatedLedger` is an executable
// mirror of contracts/sigil/sources/site.move and sentinel_registry.move.
// It uses the same rules and the same abort codes, so agents can plan
// against it locally and the test suite pins the contract semantics. A Sui
// adapter implements the same interface by building PTBs against the
// published package.

export const Abort = {
  ENotSigner: 0,
  EAlreadyApproved: 1,
  EThresholdNotMet: 2,
  EReviewsNotMet: 3,
  ENoSuchVersion: 4,
  ENoSuchProposal: 5,
  ENotSentinel: 6,
  EFrozen: 7,
  EBadConfig: 8,
  ERevoked: 9,
  EAlreadyAttested: 10,
  ECannotRevokeLive: 11,
} as const;

export class MoveAbort extends Error {
  readonly code: number;
  readonly fn: string;
  constructor(code: number, fn: string) {
    const name = Object.entries(Abort).find(([, v]) => v === code)?.[0] ?? "EUnknown";
    super(`sigil::site::${fn} aborted with ${name} (${code})`);
    this.code = code;
    this.fn = fn;
  }
}

export interface Version {
  blobId: string;
  manifestRoot: string;
  promotedMs: number;
  attesters: string[];
  revoked: boolean;
}

export interface Proposal {
  id: number;
  blobId: string;
  manifestRoot: string;
  proposer: string;
  approvals: string[];
  clean: string[];
  flagged: string[];
  createdMs: number;
}

export interface Site {
  id: string;
  name: string;
  signers: string[];
  threshold: number;
  requiredReviews: number;
  versions: Version[];
  live: number;
  hasLive: boolean;
  frozen: boolean;
  proposals: Record<string, Proposal>;
  nextProposal: number;
}

export interface LedgerEvent {
  type: string;
  site: string;
  [k: string]: unknown;
}

export interface SiteLedger {
  createSite(sender: string, name: string, signers: string[], threshold: number, requiredReviews: number): Promise<string>;
  propose(sender: string, siteId: string, blobId: string, manifestRoot: string): Promise<number>;
  approve(sender: string, siteId: string, proposal: number): Promise<void>;
  attest(sender: string, siteId: string, proposal: number, clean: boolean): Promise<void>;
  promote(sender: string, siteId: string, proposal: number): Promise<number>;
  rollback(sender: string, siteId: string, to: number): Promise<void>;
  freeze(sender: string, siteId: string): Promise<void>;
  revoke(sender: string, siteId: string, version: number): Promise<void>;
  getSite(siteId: string): Promise<Site>;
  events(siteId?: string): Promise<LedgerEvent[]>;
}

export interface LedgerState {
  sites: Record<string, Site>;
  sentinelStakes: Record<string, number>;
  minStake: number;
  events: LedgerEvent[];
  nextSite: number;
}

export class SimulatedLedger implements SiteLedger {
  private state: LedgerState;
  private now: () => number;
  private onChange: (s: LedgerState) => void;

  constructor(
    state: LedgerState = { sites: {}, sentinelStakes: {}, minStake: 10_000, events: [], nextSite: 0 },
    now: () => number = Date.now,
    onChange: (s: LedgerState) => void = () => {},
  ) {
    this.state = state;
    this.now = now;
    this.onChange = onChange;
  }

  snapshot(): LedgerState {
    return structuredClone(this.state);
  }

  // Simulation-only stand-in for sentinel_registry::stake.
  stakeSentinel(who: string, amount: number) {
    this.state.sentinelStakes[who] = (this.state.sentinelStakes[who] ?? 0) + amount;
    this.commit();
  }

  private isActiveSentinel(who: string) {
    return (this.state.sentinelStakes[who] ?? 0) >= this.state.minStake;
  }

  private site(id: string): Site {
    const s = this.state.sites[id];
    if (!s) throw new Error(`no such site: ${id}`);
    return s;
  }

  private emit(e: LedgerEvent) {
    this.state.events.push({ ...e, ms: this.now() });
  }

  private commit() {
    this.onChange(this.state);
  }

  private assertSigner(s: Site, who: string, fn: string) {
    if (!s.signers.includes(who)) throw new MoveAbort(Abort.ENotSigner, fn);
  }

  async createSite(_sender: string, name: string, signers: string[], threshold: number, requiredReviews: number) {
    const unique = [...new Set(signers)];
    if (unique.length !== signers.length || threshold < 1 || threshold > unique.length)
      throw new MoveAbort(Abort.EBadConfig, "create");
    const id = `0xsite${(this.state.nextSite++).toString(16).padStart(4, "0")}`;
    this.state.sites[id] = {
      id,
      name,
      signers: unique,
      threshold,
      requiredReviews,
      versions: [],
      live: 0,
      hasLive: false,
      frozen: false,
      proposals: {},
      nextProposal: 0,
    };
    this.emit({ type: "SiteCreated", site: id, name, threshold, requiredReviews });
    this.commit();
    return id;
  }

  async propose(sender: string, siteId: string, blobId: string, manifestRoot: string) {
    const s = this.site(siteId);
    this.assertSigner(s, sender, "propose");
    if (s.frozen) throw new MoveAbort(Abort.EFrozen, "propose");
    const id = s.nextProposal++;
    s.proposals[id] = {
      id,
      blobId,
      manifestRoot,
      proposer: sender,
      approvals: [sender],
      clean: [],
      flagged: [],
      createdMs: this.now(),
    };
    this.emit({ type: "Proposed", site: siteId, proposal: id, blobId, manifestRoot, proposer: sender });
    this.commit();
    return id;
  }

  private proposal(s: Site, id: number, fn: string) {
    const p = s.proposals[id];
    if (!p) throw new MoveAbort(Abort.ENoSuchProposal, fn);
    return p;
  }

  async approve(sender: string, siteId: string, proposal: number) {
    const s = this.site(siteId);
    this.assertSigner(s, sender, "approve");
    const p = this.proposal(s, proposal, "approve");
    if (p.approvals.includes(sender)) throw new MoveAbort(Abort.EAlreadyApproved, "approve");
    p.approvals.push(sender);
    this.emit({ type: "Approved", site: siteId, proposal, signer: sender, approvals: p.approvals.length });
    this.commit();
  }

  async attest(sender: string, siteId: string, proposal: number, clean: boolean) {
    if (!this.isActiveSentinel(sender)) throw new MoveAbort(Abort.ENotSentinel, "attest");
    const s = this.site(siteId);
    const p = this.proposal(s, proposal, "attest");
    if (p.clean.includes(sender) || p.flagged.includes(sender)) throw new MoveAbort(Abort.EAlreadyAttested, "attest");
    (clean ? p.clean : p.flagged).push(sender);
    this.emit({ type: "Attested", site: siteId, proposal, sentinel: sender, clean });
    this.commit();
  }

  async promote(sender: string, siteId: string, proposal: number) {
    const s = this.site(siteId);
    this.assertSigner(s, sender, "promote");
    if (s.frozen) throw new MoveAbort(Abort.EFrozen, "promote");
    const p = this.proposal(s, proposal, "promote");
    if (p.approvals.length < s.threshold) throw new MoveAbort(Abort.EThresholdNotMet, "promote");
    if (p.clean.length < s.requiredReviews + p.flagged.length) throw new MoveAbort(Abort.EReviewsNotMet, "promote");
    delete s.proposals[proposal];
    s.versions.push({
      blobId: p.blobId,
      manifestRoot: p.manifestRoot,
      promotedMs: this.now(),
      attesters: [...p.clean],
      revoked: false,
    });
    s.live = s.versions.length - 1;
    s.hasLive = true;
    this.emit({ type: "Promoted", site: siteId, version: s.live, blobId: p.blobId, manifestRoot: p.manifestRoot });
    this.commit();
    return s.live;
  }

  async rollback(sender: string, siteId: string, to: number) {
    const s = this.site(siteId);
    this.assertSigner(s, sender, "rollback");
    if (!(to >= 0 && to < s.versions.length)) throw new MoveAbort(Abort.ENoSuchVersion, "rollback");
    if (s.versions[to].revoked) throw new MoveAbort(Abort.ERevoked, "rollback");
    const from = s.live;
    s.live = to;
    s.frozen = false;
    this.emit({ type: "RolledBack", site: siteId, from, to, by: sender });
    this.commit();
  }

  async freeze(sender: string, siteId: string) {
    const s = this.site(siteId);
    this.assertSigner(s, sender, "freeze_site");
    s.frozen = true;
    this.emit({ type: "Frozen", site: siteId, by: sender });
    this.commit();
  }

  async revoke(sender: string, siteId: string, version: number) {
    const s = this.site(siteId);
    this.assertSigner(s, sender, "revoke");
    if (!(version >= 0 && version < s.versions.length)) throw new MoveAbort(Abort.ENoSuchVersion, "revoke");
    if (s.hasLive && s.live === version) throw new MoveAbort(Abort.ECannotRevokeLive, "revoke");
    s.versions[version].revoked = true;
    this.emit({ type: "Revoked", site: siteId, version, attesters: s.versions[version].attesters, by: sender });
    this.commit();
  }

  async getSite(siteId: string) {
    return structuredClone(this.site(siteId));
  }

  async events(siteId?: string) {
    return structuredClone(siteId ? this.state.events.filter((e) => e.site === siteId) : this.state.events);
  }
}

// Mirrors site::live_blob_id: frozen or never-promoted sites resolve to nothing.
export function liveVersion(site: Site): Version | undefined {
  return site.hasLive && !site.frozen ? site.versions[site.live] : undefined;
}
