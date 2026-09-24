/// MEMO: the Memora platform token.
///
/// Fixed supply. The whole supply is minted once at publish time; the
/// TreasuryCap is then locked inside a shared `BurnVault` that exposes
/// *burn only*. Nobody, including the deployer, can mint again, which is
/// what makes buyback-and-burn a real supply reduction.
module memora::memo;

use sui::coin::{Self, Coin, TreasuryCap};
use sui::event;

/// 1,000,000,000 MEMO with 9 decimals.
const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000_000;

public struct MEMO has drop {}

public struct BurnVault has key {
    id: UID,
    cap: TreasuryCap<MEMO>,
    total_burned: u64,
}

public struct Burned has copy, drop {
    amount: u64,
    total_burned: u64,
    reason: u8,
}

/// Burn reasons, recorded on-chain so agents can attribute supply changes.
const REASON_BUYBACK: u8 = 0;
const REASON_SLASH: u8 = 1;

#[allow(deprecated_usage)]
fun init(witness: MEMO, ctx: &mut TxContext) {
    let (mut cap, metadata) = coin::create_currency(
        witness,
        9,
        b"MEMO",
        b"Memora",
        b"Captures fees from agent-native, content-addressed dApp hosting.",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    let supply = coin::mint(&mut cap, TOTAL_SUPPLY, ctx);
    transfer::public_transfer(supply, ctx.sender());
    transfer::share_object(BurnVault { id: object::new(ctx), cap, total_burned: 0 });
}

public fun burn_buyback(vault: &mut BurnVault, c: Coin<MEMO>): u64 {
    burn(vault, c, REASON_BUYBACK)
}

public(package) fun burn_slashed(vault: &mut BurnVault, c: Coin<MEMO>): u64 {
    burn(vault, c, REASON_SLASH)
}

fun burn(vault: &mut BurnVault, c: Coin<MEMO>, reason: u8): u64 {
    let amount = coin::burn(&mut vault.cap, c);
    vault.total_burned = vault.total_burned + amount;
    event::emit(Burned { amount, total_burned: vault.total_burned, reason });
    amount
}

public fun total_burned(vault: &BurnVault): u64 { vault.total_burned }

public fun circulating_supply(vault: &BurnVault): u64 { coin::total_supply(&vault.cap) }
