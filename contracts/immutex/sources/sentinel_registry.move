/// Staked Sentinels: the security reviewers who attest to site builds.
///
/// A Sentinel is usually an autonomous agent running `immutex-sentinel` in a
/// sandbox, but the contract doesn't care what it is. It only needs a bonded
/// IMTX stake. An attestation is a claim backed by that stake. If a build a
/// Sentinel called clean is later revoked as malicious, the SlashCap holder
/// (a DAO or multi-sig) can slash the bond, and the slashed IMTX is burned.
module immutex::sentinel_registry;

use immutex::immutex::{IMMUTEX, BurnVault, burn_slashed};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};

const EBelowMinimum: u64 = 0;
const ENotStaked: u64 = 1;
const EUnbonding: u64 = 2;
const EStillLocked: u64 = 3;
const EBadBps: u64 = 4;
const ENotUnbonding: u64 = 5;

const BPS: u64 = 10_000;
/// 7 days. Must exceed the window in which a bad build is realistically
/// detected, so a Sentinel can't attest to a drainer and then unbond before
/// it's caught.
const UNBONDING_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// 10,000 IMTX.
const DEFAULT_MIN_STAKE: u64 = 10_000_000_000_000;

public struct Registry has key {
    id: UID,
    min_stake: u64,
    stakes: Table<address, u64>,
    unbonding_until: Table<address, u64>,
    vault: Balance<IMMUTEX>,
}

/// Held by governance. Can slash and set parameters, but can't move stake
/// anywhere except the burn vault.
public struct SlashCap has key, store { id: UID }

public struct Staked has copy, drop { sentinel: address, total: u64 }
public struct UnbondRequested has copy, drop { sentinel: address, unlock_ms: u64 }
public struct Slashed has copy, drop { sentinel: address, amount: u64, evidence: vector<u8> }

fun init(ctx: &mut TxContext) {
    transfer::share_object(Registry {
        id: object::new(ctx),
        min_stake: DEFAULT_MIN_STAKE,
        stakes: table::new(ctx),
        unbonding_until: table::new(ctx),
        vault: balance::zero(),
    });
    transfer::public_transfer(SlashCap { id: object::new(ctx) }, ctx.sender());
}

public fun stake(reg: &mut Registry, c: Coin<IMMUTEX>, ctx: &TxContext) {
    let who = ctx.sender();
    assert!(!reg.unbonding_until.contains(who), EUnbonding);
    let add = c.value();
    reg.vault.join(c.into_balance());
    let total = if (reg.stakes.contains(who)) {
        let s = reg.stakes.borrow_mut(who);
        *s = *s + add;
        *s
    } else {
        reg.stakes.add(who, add);
        add
    };
    assert!(total >= reg.min_stake, EBelowMinimum);
    event::emit(Staked { sentinel: who, total });
}

/// Stops the Sentinel from attesting right away. The stake stays slashable
/// until the unbonding window has passed.
public fun request_unbond(reg: &mut Registry, clock: &Clock, ctx: &TxContext) {
    let who = ctx.sender();
    assert!(reg.stakes.contains(who), ENotStaked);
    assert!(!reg.unbonding_until.contains(who), EUnbonding);
    let unlock_ms = clock.timestamp_ms() + UNBONDING_MS;
    reg.unbonding_until.add(who, unlock_ms);
    event::emit(UnbondRequested { sentinel: who, unlock_ms });
}

public fun withdraw(reg: &mut Registry, clock: &Clock, ctx: &mut TxContext): Coin<IMMUTEX> {
    let who = ctx.sender();
    assert!(reg.unbonding_until.contains(who), ENotUnbonding);
    assert!(clock.timestamp_ms() >= *reg.unbonding_until.borrow(who), EStillLocked);
    reg.unbonding_until.remove(who);
    let amount = reg.stakes.remove(who);
    coin::from_balance(reg.vault.split(amount), ctx)
}

/// Slash `bps` of a Sentinel's bond and burn it. `evidence` should be the
/// revoked build's manifest root plus the governance proposal reference.
public fun slash(
    _: &SlashCap,
    reg: &mut Registry,
    burn_vault: &mut BurnVault,
    sentinel: address,
    bps: u64,
    evidence: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(bps > 0 && bps <= BPS, EBadBps);
    assert!(reg.stakes.contains(sentinel), ENotStaked);
    let s = reg.stakes.borrow_mut(sentinel);
    let amount = (((*s as u128) * (bps as u128) / (BPS as u128)) as u64);
    *s = *s - amount;
    burn_slashed(burn_vault, coin::from_balance(reg.vault.split(amount), ctx));
    event::emit(Slashed { sentinel, amount, evidence });
}

public fun set_min_stake(_: &SlashCap, reg: &mut Registry, min_stake: u64) {
    reg.min_stake = min_stake;
}

/// A Sentinel may attest only while bonded at or above the minimum and not unbonding.
public fun is_active(reg: &Registry, who: address): bool {
    reg.stakes.contains(who)
        && *reg.stakes.borrow(who) >= reg.min_stake
        && !reg.unbonding_until.contains(who)
}

public fun stake_of(reg: &Registry, who: address): u64 {
    if (reg.stakes.contains(who)) { *reg.stakes.borrow(who) } else { 0 }
}

#[test_only]
/// Shares a Registry where each of `sentinels` is bonded at the minimum stake.
public fun share_for_testing(sentinels: vector<address>, ctx: &mut TxContext) {
    let mut stakes = table::new(ctx);
    sentinels.do!(|a| stakes.add(a, DEFAULT_MIN_STAKE));
    transfer::share_object(Registry {
        id: object::new(ctx),
        min_stake: DEFAULT_MIN_STAKE,
        stakes,
        unbonding_until: table::new(ctx),
        vault: balance::zero(),
    });
}
