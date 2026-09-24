#[test_only]
module sigil::site_tests;

use sigil::sentinel_registry::{Self, Registry};
use sigil::site::{Self, Site};
use std::string::utf8;
use sui::clock::{Self, Clock};
use sui::test_scenario::{Self as ts, Scenario};

const A: address = @0xA;
const B: address = @0xB;
const MALLORY: address = @0xBAD;
const S1: address = @0x51;
const S2: address = @0x52;

/// Site "dex" with signers {A, B}, threshold 2, one required review; S1 and S2 bonded.
fun setup(): (Scenario, Clock) {
    let mut sc = ts::begin(A);
    site::create(utf8(b"dex"), vector[A, B], 2, 1, sc.ctx());
    sentinel_registry::share_for_testing(vector[S1, S2], sc.ctx());
    let clk = clock::create_for_testing(sc.ctx());
    (sc, clk)
}

fun propose(sc: &mut Scenario, clk: &Clock, who: address, blob: vector<u8>): u64 {
    sc.next_tx(who);
    let mut s = sc.take_shared<Site>();
    let p = site::propose(&mut s, utf8(blob), blob, clk, sc.ctx());
    ts::return_shared(s);
    p
}

fun approve(sc: &mut Scenario, who: address, p: u64) {
    sc.next_tx(who);
    let mut s = sc.take_shared<Site>();
    site::approve(&mut s, p, sc.ctx());
    ts::return_shared(s);
}

fun attest(sc: &mut Scenario, who: address, p: u64, clean: bool) {
    sc.next_tx(who);
    let mut s = sc.take_shared<Site>();
    let reg = sc.take_shared<Registry>();
    site::attest(&mut s, &reg, p, clean, sc.ctx());
    ts::return_shared(reg);
    ts::return_shared(s);
}

fun promote(sc: &mut Scenario, clk: &Clock, who: address, p: u64) {
    sc.next_tx(who);
    let mut s = sc.take_shared<Site>();
    site::promote(&mut s, p, clk, sc.ctx());
    ts::return_shared(s);
}

fun ship(sc: &mut Scenario, clk: &Clock, blob: vector<u8>) {
    let p = propose(sc, clk, A, blob);
    approve(sc, B, p);
    attest(sc, S1, p, true);
    promote(sc, clk, A, p);
}

fun finish(sc: Scenario, clk: Clock) {
    clk.destroy_for_testing();
    sc.end();
}

#[test]
fun ships_after_threshold_and_review() {
    let (mut sc, clk) = setup();
    ship(&mut sc, &clk, b"v0");
    sc.next_tx(A);
    let s = sc.take_shared<Site>();
    assert!(site::live_blob_id(&s) == option::some(utf8(b"v0")));
    assert!(site::version_count(&s) == 1);
    ts::return_shared(s);
    finish(sc, clk);
}

#[test, expected_failure(abort_code = 0, location = sigil::site)]
fun non_signer_cannot_propose() {
    let (mut sc, clk) = setup();
    propose(&mut sc, &clk, MALLORY, b"evil");
    finish(sc, clk);
}

#[test, expected_failure(abort_code = 2, location = sigil::site)]
fun one_signer_cannot_promote() {
    let (mut sc, clk) = setup();
    let p = propose(&mut sc, &clk, A, b"v0");
    attest(&mut sc, S1, p, true);
    promote(&mut sc, &clk, A, p);
    finish(sc, clk);
}

#[test, expected_failure(abort_code = 3, location = sigil::site)]
fun a_flag_raises_the_review_bar() {
    let (mut sc, clk) = setup();
    let p = propose(&mut sc, &clk, A, b"v0");
    approve(&mut sc, B, p);
    attest(&mut sc, S1, p, true);
    attest(&mut sc, S2, p, false);
    promote(&mut sc, &clk, A, p);
    finish(sc, clk);
}

#[test, expected_failure(abort_code = 6, location = sigil::site)]
fun unbonded_address_cannot_attest() {
    let (mut sc, clk) = setup();
    let p = propose(&mut sc, &clk, A, b"v0");
    attest(&mut sc, MALLORY, p, true);
    finish(sc, clk);
}

#[test]
fun single_signer_freeze_and_rollback() {
    let (mut sc, clk) = setup();
    ship(&mut sc, &clk, b"v0");
    ship(&mut sc, &clk, b"v1");
    sc.next_tx(B);
    let mut s = sc.take_shared<Site>();
    site::freeze_site(&mut s, sc.ctx());
    assert!(site::live_blob_id(&s).is_none());
    site::rollback(&mut s, 0, sc.ctx());
    site::revoke(&mut s, 1, sc.ctx());
    assert!(site::live_blob_id(&s) == option::some(utf8(b"v0")));
    assert!(!site::is_frozen(&s));
    ts::return_shared(s);
    finish(sc, clk);
}

#[test, expected_failure(abort_code = 9, location = sigil::site)]
fun cannot_roll_back_to_revoked() {
    let (mut sc, clk) = setup();
    ship(&mut sc, &clk, b"v0");
    ship(&mut sc, &clk, b"v1");
    sc.next_tx(A);
    let mut s = sc.take_shared<Site>();
    site::rollback(&mut s, 0, sc.ctx());
    site::revoke(&mut s, 1, sc.ctx());
    site::rollback(&mut s, 1, sc.ctx());
    ts::return_shared(s);
    finish(sc, clk);
}
