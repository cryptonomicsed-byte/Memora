#[test_only]
module sigil::storage_vault_tests;

use sigil::storage_vault::{Self, Vault};
use sigil::treasury;
use std::string::utf8;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use std::unit_test::destroy;

const OWNER: address = @0xA;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[test]
fun create_returns_cap_and_draws_are_capped_and_rate_limited() {
    let mut sc = ts::begin(OWNER);
    let site = object::id_from_address(@0x5173);
    let cap = storage_vault::create<SUI>(site, 100, sc.ctx());

    sc.next_tx(OWNER);
    let mut v = sc.take_shared<Vault<SUI>>();
    let keeper = treasury::keeper_cap_for_testing(sc.ctx());
    let mut clk = clock::create_for_testing(sc.ctx());
    storage_vault::fund(&mut v, coin::mint_for_testing<SUI>(500, sc.ctx()), sc.ctx());

    let c = storage_vault::draw_for_renewal(&keeper, &mut v, 100, utf8(b"blob"), &clk, sc.ctx());
    assert!(c.value() == 100);
    clk.increment_for_testing(DAY_MS);
    let c2 = storage_vault::draw_for_renewal(&keeper, &mut v, 50, utf8(b"blob"), &clk, sc.ctx());
    assert!(storage_vault::available(&v) == 350);

    let rest = storage_vault::withdraw(&cap, &mut v, 350, sc.ctx());
    assert!(rest.value() == 350);

    destroy(c);
    destroy(c2);
    destroy(rest);
    destroy(keeper);
    destroy(cap);
    clk.destroy_for_testing();
    ts::return_shared(v);
    sc.end();
}

#[test, expected_failure(abort_code = 0, location = sigil::storage_vault)]
fun draw_over_cap_aborts() {
    let mut sc = ts::begin(OWNER);
    let cap = storage_vault::create<SUI>(object::id_from_address(@0x5173), 100, sc.ctx());
    sc.next_tx(OWNER);
    let mut v = sc.take_shared<Vault<SUI>>();
    let keeper = treasury::keeper_cap_for_testing(sc.ctx());
    let clk = clock::create_for_testing(sc.ctx());
    storage_vault::fund(&mut v, coin::mint_for_testing<SUI>(500, sc.ctx()), sc.ctx());
    let c = storage_vault::draw_for_renewal(&keeper, &mut v, 101, utf8(b"blob"), &clk, sc.ctx());
    destroy(c);
    destroy(keeper);
    destroy(cap);
    clk.destroy_for_testing();
    ts::return_shared(v);
    sc.end();
}

#[test, expected_failure(abort_code = 1, location = sigil::storage_vault)]
fun second_draw_same_day_aborts() {
    let mut sc = ts::begin(OWNER);
    let cap = storage_vault::create<SUI>(object::id_from_address(@0x5173), 100, sc.ctx());
    sc.next_tx(OWNER);
    let mut v = sc.take_shared<Vault<SUI>>();
    let keeper = treasury::keeper_cap_for_testing(sc.ctx());
    let clk = clock::create_for_testing(sc.ctx());
    storage_vault::fund(&mut v, coin::mint_for_testing<SUI>(500, sc.ctx()), sc.ctx());
    let c = storage_vault::draw_for_renewal(&keeper, &mut v, 10, utf8(b"blob"), &clk, sc.ctx());
    let c2 = storage_vault::draw_for_renewal(&keeper, &mut v, 10, utf8(b"blob"), &clk, sc.ctx());
    destroy(c);
    destroy(c2);
    destroy(keeper);
    destroy(cap);
    clk.destroy_for_testing();
    ts::return_shared(v);
    sc.end();
}
