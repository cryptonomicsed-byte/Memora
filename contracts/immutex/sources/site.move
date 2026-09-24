/// The Site object: the on-chain source of truth for what a dApp front-end is.
///
/// Portals resolve `name -> Site -> versions[live].blob_id` and serve only
/// content whose hash matches `manifest_root`. Changing what users see
/// therefore requires a signed transaction against this object. A stolen CI
/// token, a hijacked Web2 account, or a compromised registrar can't do it.
///
/// The asymmetry is deliberate:
///   * Moving forward (promote a new build) needs M-of-N signer approvals
///     AND a quorum of staked Sentinel attestations.
///   * Moving back (roll back to a build that already passed that gate)
///     needs just one signer, so incident response takes one transaction.
module immutex::site;

use immutex::sentinel_registry::{Self, Registry};
use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};

const ENotSigner: u64 = 0;
const EAlreadyApproved: u64 = 1;
const EThresholdNotMet: u64 = 2;
const EReviewsNotMet: u64 = 3;
const ENoSuchVersion: u64 = 4;
const ENoSuchProposal: u64 = 5;
const ENotSentinel: u64 = 6;
const EFrozen: u64 = 7;
const EBadConfig: u64 = 8;
const ERevoked: u64 = 9;
const EAlreadyAttested: u64 = 10;
const ECannotRevokeLive: u64 = 11;

public struct Version has store, copy, drop {
    /// Walrus blob ID, Arweave tx ID, or Shadow Drive URI.
    blob_id: String,
    /// sha256 root over the sorted (path, sha256) file manifest.
    manifest_root: vector<u8>,
    promoted_ms: u64,
    /// Sentinels whose clean attestation let this version through.
    attesters: vector<address>,
    revoked: bool,
}

public struct Proposal has store, drop {
    blob_id: String,
    manifest_root: vector<u8>,
    proposer: address,
    approvals: VecSet<address>,
    clean: VecSet<address>,
    flagged: VecSet<address>,
    created_ms: u64,
}

public struct Site has key {
    id: UID,
    name: String,
    signers: VecSet<address>,
    threshold: u64,
    required_reviews: u64,
    versions: vector<Version>,
    live: u64,
    has_live: bool,
    frozen: bool,
    proposals: Table<u64, Proposal>,
    next_proposal: u64,
}

public struct SiteCreated has copy, drop { site: ID, name: String, threshold: u64, required_reviews: u64 }
public struct Proposed has copy, drop { site: ID, proposal: u64, blob_id: String, manifest_root: vector<u8>, proposer: address }
public struct Approved has copy, drop { site: ID, proposal: u64, signer: address, approvals: u64 }
public struct Attested has copy, drop { site: ID, proposal: u64, sentinel: address, clean: bool }
public struct Promoted has copy, drop { site: ID, version: u64, blob_id: String, manifest_root: vector<u8> }
public struct RolledBack has copy, drop { site: ID, from: u64, to: u64, by: address }
public struct Frozen has copy, drop { site: ID, by: address }
public struct Revoked has copy, drop { site: ID, version: u64, attesters: vector<address>, by: address }

public fun create(
    name: String,
    signers: vector<address>,
    threshold: u64,
    required_reviews: u64,
    ctx: &mut TxContext,
) {
    let signers = vec_set::from_keys(signers);
    assert!(threshold > 0 && threshold <= signers.length(), EBadConfig);
    let site = Site {
        id: object::new(ctx),
        name,
        signers,
        threshold,
        required_reviews,
        versions: vector[],
        live: 0,
        has_live: false,
        frozen: false,
        proposals: table::new(ctx),
        next_proposal: 0,
    };
    event::emit(SiteCreated { site: object::id(&site), name, threshold, required_reviews });
    transfer::share_object(site);
}

public fun propose(
    site: &mut Site,
    blob_id: String,
    manifest_root: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): u64 {
    let who = ctx.sender();
    assert_signer(site, who);
    assert!(!site.frozen, EFrozen);
    let pid = site.next_proposal;
    site.next_proposal = pid + 1;
    site.proposals.add(pid, Proposal {
        blob_id,
        manifest_root,
        proposer: who,
        approvals: vec_set::singleton(who),
        clean: vec_set::empty(),
        flagged: vec_set::empty(),
        created_ms: clock.timestamp_ms(),
    });
    event::emit(Proposed { site: object::id(site), proposal: pid, blob_id, manifest_root, proposer: who });
    pid
}

public fun approve(site: &mut Site, proposal: u64, ctx: &TxContext) {
    let who = ctx.sender();
    assert_signer(site, who);
    assert!(site.proposals.contains(proposal), ENoSuchProposal);
    let site_id = object::id(site);
    let p = site.proposals.borrow_mut(proposal);
    assert!(!p.approvals.contains(&who), EAlreadyApproved);
    p.approvals.insert(who);
    event::emit(Approved { site: site_id, proposal, signer: who, approvals: p.approvals.length() });
}

/// A staked Sentinel records its verdict on a proposed build. `clean = false`
/// is a flag. Each flag raises the number of clean attestations needed.
public fun attest(site: &mut Site, reg: &Registry, proposal: u64, clean: bool, ctx: &TxContext) {
    let who = ctx.sender();
    assert!(sentinel_registry::is_active(reg, who), ENotSentinel);
    assert!(site.proposals.contains(proposal), ENoSuchProposal);
    let site_id = object::id(site);
    let p = site.proposals.borrow_mut(proposal);
    assert!(!p.clean.contains(&who) && !p.flagged.contains(&who), EAlreadyAttested);
    if (clean) { p.clean.insert(who) } else { p.flagged.insert(who) };
    event::emit(Attested { site: site_id, proposal, sentinel: who, clean });
}

public fun promote(site: &mut Site, proposal: u64, clock: &Clock, ctx: &TxContext) {
    assert_signer(site, ctx.sender());
    assert!(!site.frozen, EFrozen);
    assert!(site.proposals.contains(proposal), ENoSuchProposal);
    let p = site.proposals.borrow(proposal);
    assert!(p.approvals.length() >= site.threshold, EThresholdNotMet);
    assert!(p.clean.length() >= site.required_reviews + p.flagged.length(), EReviewsNotMet);

    let Proposal { blob_id, manifest_root, clean, .. } = site.proposals.remove(proposal);
    site.versions.push_back(Version {
        blob_id,
        manifest_root,
        promoted_ms: clock.timestamp_ms(),
        attesters: clean.into_keys(),
        revoked: false,
    });
    site.live = site.versions.length() - 1;
    site.has_live = true;
    event::emit(Promoted { site: object::id(site), version: site.live, blob_id, manifest_root });
}

/// One signer, one transaction: point the site back at a known-good build.
/// Also clears a freeze, so the incident playbook is `freeze_site` then `rollback`.
public fun rollback(site: &mut Site, to: u64, ctx: &TxContext) {
    let who = ctx.sender();
    assert_signer(site, who);
    assert!(to < site.versions.length(), ENoSuchVersion);
    assert!(!site.versions[to].revoked, ERevoked);
    let from = site.live;
    site.live = to;
    site.frozen = false;
    event::emit(RolledBack { site: object::id(site), from, to, by: who });
}

/// Any single signer can halt serving. Portals render a maintenance page.
public fun freeze_site(site: &mut Site, ctx: &TxContext) {
    let who = ctx.sender();
    assert_signer(site, who);
    site.frozen = true;
    event::emit(Frozen { site: object::id(site), by: who });
}

/// Mark a past build malicious so it can never be rolled back to. The event
/// lists the Sentinels who attested it clean, which is the slashing evidence.
public fun revoke(site: &mut Site, version: u64, ctx: &TxContext) {
    let who = ctx.sender();
    assert_signer(site, who);
    assert!(version < site.versions.length(), ENoSuchVersion);
    assert!(!(site.has_live && site.live == version), ECannotRevokeLive);
    let site_id = object::id(site);
    let v = &mut site.versions[version];
    v.revoked = true;
    event::emit(Revoked { site: site_id, version, attesters: v.attesters, by: who });
}

fun assert_signer(site: &Site, who: address) {
    assert!(site.signers.contains(&who), ENotSigner);
}

// === Views (for portals and agents) ===

public fun live_blob_id(site: &Site): Option<String> {
    if (site.has_live && !site.frozen) { option::some(site.versions[site.live].blob_id) } else { option::none() }
}

public fun live_manifest_root(site: &Site): Option<vector<u8>> {
    if (site.has_live && !site.frozen) { option::some(site.versions[site.live].manifest_root) } else { option::none() }
}

public fun live_index(site: &Site): u64 { site.live }
public fun version_count(site: &Site): u64 { site.versions.length() }
public fun is_frozen(site: &Site): bool { site.frozen }
public fun name(site: &Site): String { site.name }
