/// Fee router. Every platform action (deploy, storage-epoch extension, domain
/// mapping) pays a SUI fee here, and it's split on-chain into:
///   * buyback: a keeper agent swaps it for IMTX on a DEX and calls
///     `immutex::burn_buyback`. Both legs are public events, so anyone can
///     check that what came in was actually burned.
///   * portals: reward pool for Portal/CDN node operators.
///   * sentinels: reward pool for staked build reviewers.
///   * ops: protocol operations.
module immutex::treasury;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;

const EBadSplit: u64 = 0;
const EZeroFee: u64 = 1;

const BPS: u64 = 10_000;

public enum Action has copy, drop, store {
    Deploy,
    ExtendStorage,
    MapDomain,
}

public struct Treasury has key {
    id: UID,
    buyback: Balance<SUI>,
    portals: Balance<SUI>,
    sentinels: Balance<SUI>,
    ops: Balance<SUI>,
    buyback_bps: u64,
    portal_bps: u64,
    sentinel_bps: u64,
}

/// Governance: changes the split.
public struct AdminCap has key, store { id: UID }
/// Keeper agents: move pooled funds out to the buyback/reward executors.
public struct KeeperCap has key, store { id: UID }

public struct FeePaid has copy, drop { payer: address, site: ID, action: Action, amount: u64 }
public struct PoolWithdrawn has copy, drop { pool: u8, amount: u64 }

fun init(ctx: &mut TxContext) {
    transfer::share_object(Treasury {
        id: object::new(ctx),
        buyback: balance::zero(),
        portals: balance::zero(),
        sentinels: balance::zero(),
        ops: balance::zero(),
        buyback_bps: 4_000,
        portal_bps: 3_000,
        sentinel_bps: 2_000,
    });
    transfer::public_transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
    transfer::public_transfer(KeeperCap { id: object::new(ctx) }, ctx.sender());
}

fun portion(total: u64, bps: u64): u64 {
    (((total as u128) * (bps as u128) / (BPS as u128)) as u64)
}

public fun pay(t: &mut Treasury, fee: Coin<SUI>, site: ID, action: Action, ctx: &TxContext) {
    let amount = fee.value();
    assert!(amount > 0, EZeroFee);
    let mut b = fee.into_balance();
    t.buyback.join(b.split(portion(amount, t.buyback_bps)));
    t.portals.join(b.split(portion(amount, t.portal_bps)));
    t.sentinels.join(b.split(portion(amount, t.sentinel_bps)));
    t.ops.join(b); // remainder, including rounding dust
    event::emit(FeePaid { payer: ctx.sender(), site, action, amount });
}

public fun withdraw_buyback(_: &KeeperCap, t: &mut Treasury, ctx: &mut TxContext): Coin<SUI> {
    let amount = t.buyback.value();
    event::emit(PoolWithdrawn { pool: 0, amount });
    coin::from_balance(t.buyback.withdraw_all(), ctx)
}

public fun withdraw_portal_rewards(_: &KeeperCap, t: &mut Treasury, ctx: &mut TxContext): Coin<SUI> {
    let amount = t.portals.value();
    event::emit(PoolWithdrawn { pool: 1, amount });
    coin::from_balance(t.portals.withdraw_all(), ctx)
}

public fun withdraw_sentinel_rewards(_: &KeeperCap, t: &mut Treasury, ctx: &mut TxContext): Coin<SUI> {
    let amount = t.sentinels.value();
    event::emit(PoolWithdrawn { pool: 2, amount });
    coin::from_balance(t.sentinels.withdraw_all(), ctx)
}

public fun withdraw_ops(_: &AdminCap, t: &mut Treasury, ctx: &mut TxContext): Coin<SUI> {
    let amount = t.ops.value();
    event::emit(PoolWithdrawn { pool: 3, amount });
    coin::from_balance(t.ops.withdraw_all(), ctx)
}

public fun set_split(_: &AdminCap, t: &mut Treasury, buyback_bps: u64, portal_bps: u64, sentinel_bps: u64) {
    assert!(buyback_bps + portal_bps + sentinel_bps <= BPS, EBadSplit);
    t.buyback_bps = buyback_bps;
    t.portal_bps = portal_bps;
    t.sentinel_bps = sentinel_bps;
}

/// Holder tiers: fee discount in bps for a given amount of locked IMTX (9 decimals).
///   Tier 1 >= 1,000 IMTX: 20% off
///   Tier 2 >= 25,000 IMTX: 40% off (plus priority portal routing, enforced off-chain)
///   Tier 3 >= 250,000 IMTX: 60% off (plus continuous Sentinel monitoring)
public fun discount_bps(locked_memo: u64): u64 {
    if (locked_memo >= 250_000_000_000_000) { 6_000 }
    else if (locked_memo >= 25_000_000_000_000) { 4_000 }
    else if (locked_memo >= 1_000_000_000_000) { 2_000 }
    else { 0 }
}

public fun deploy_action(): Action { Action::Deploy }
public fun extend_storage_action(): Action { Action::ExtendStorage }
public fun map_domain_action(): Action { Action::MapDomain }

#[test_only]
public fun keeper_cap_for_testing(ctx: &mut TxContext): KeeperCap { KeeperCap { id: object::new(ctx) } }
