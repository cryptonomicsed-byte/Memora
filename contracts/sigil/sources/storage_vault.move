/// Auto-renewing storage vault: a prepaid, per-site balance that Keeper
/// agents draw from to extend the site's storage epochs before they expire.
///
/// Anyone can fund a site's vault (a DAO, its users, a grants program).
/// The keeper draws and then extends the blob in the same PTB. The vault
/// bounds what a compromised keeper could take: at most `max_draw` per call,
/// no more than once per `min_interval_ms`. Every draw emits the blob it was
/// meant to renew, so watchers can check the matching extension happened.
module sigil::storage_vault;

use sigil::treasury::KeeperCap;
use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;

const EOverMaxDraw: u64 = 0;
const ETooSoon: u64 = 1;
const EWrongVault: u64 = 2;
const EZeroAmount: u64 = 3;

/// One day. Walrus epochs are longer, so this never blocks a legitimate renewal.
const DEFAULT_MIN_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

/// `T` is the storage payment coin (WAL for Walrus).
public struct Vault<phantom T> has key {
    id: UID,
    site: ID,
    balance: Balance<T>,
    max_draw: u64,
    min_interval_ms: u64,
    last_draw_ms: u64,
    total_drawn: u64,
}

public struct VaultOwnerCap has key, store { id: UID, vault: ID }

public struct Funded has copy, drop { vault: ID, site: ID, amount: u64, by: address }
public struct RenewalDrawn has copy, drop { vault: ID, site: ID, blob_id: String, amount: u64 }

/// Shares the vault and returns its owner cap, so the caller's PTB decides
/// where the cap goes (a multisig, a DAO object, or the sender).
public fun create<T>(site: ID, max_draw: u64, ctx: &mut TxContext): VaultOwnerCap {
    let vault = Vault<T> {
        id: object::new(ctx),
        site,
        balance: balance::zero(),
        max_draw,
        min_interval_ms: DEFAULT_MIN_INTERVAL_MS,
        last_draw_ms: 0,
        total_drawn: 0,
    };
    let cap = VaultOwnerCap { id: object::new(ctx), vault: object::id(&vault) };
    transfer::share_object(vault);
    cap
}

public fun fund<T>(v: &mut Vault<T>, c: Coin<T>, ctx: &TxContext) {
    let amount = c.value();
    assert!(amount > 0, EZeroAmount);
    v.balance.join(c.into_balance());
    event::emit(Funded { vault: object::id(v), site: v.site, amount, by: ctx.sender() });
}

public fun draw_for_renewal<T>(
    _: &KeeperCap,
    v: &mut Vault<T>,
    amount: u64,
    blob_id: String,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(amount > 0, EZeroAmount);
    assert!(amount <= v.max_draw, EOverMaxDraw);
    let now = clock.timestamp_ms();
    assert!(v.total_drawn == 0 || now >= v.last_draw_ms + v.min_interval_ms, ETooSoon);
    v.last_draw_ms = now;
    v.total_drawn = v.total_drawn + amount;
    event::emit(RenewalDrawn { vault: object::id(v), site: v.site, blob_id, amount });
    coin::from_balance(v.balance.split(amount), ctx)
}

public fun set_max_draw<T>(cap: &VaultOwnerCap, v: &mut Vault<T>, max_draw: u64) {
    assert!(cap.vault == object::id(v), EWrongVault);
    v.max_draw = max_draw;
}

public fun withdraw<T>(cap: &VaultOwnerCap, v: &mut Vault<T>, amount: u64, ctx: &mut TxContext): Coin<T> {
    assert!(cap.vault == object::id(v), EWrongVault);
    coin::from_balance(v.balance.split(amount), ctx)
}

public fun available<T>(v: &Vault<T>): u64 { v.balance.value() }
public fun site_id<T>(v: &Vault<T>): ID { v.site }
