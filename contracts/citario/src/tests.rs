use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 10u128.pow(24);
const NOW: u64 = 1_000_000_000_000;
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn pubkey(k: &SigningKey) -> PublicKey {
    let mut bytes = vec![0u8]; // curve type ed25519
    bytes.extend_from_slice(k.verifying_key().as_bytes());
    PublicKey::try_from(bytes).unwrap()
}

fn ctx(who: AccountId, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("citario.testnet".parse().unwrap())
        .predecessor_account_id(who)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(NOW)
        .build());
}

fn author() -> AccountId {
    accounts(1)
}
fn reader() -> AccountId {
    accounts(2)
}

fn setup() -> Citario {
    ctx(accounts(0), 0);
    let mut c = Citario::new(accounts(0), pubkey(&key()));
    ctx(author(), 0);
    c.register_article("paper-1".into(), "A paper".into(), HASH.into(), U128(NEAR / 20), U128(NEAR / 2));
    ctx(reader(), NEAR);
    c.deposit(None);
    c
}

fn quote(id: &str, price: u128, signer: &SigningKey) -> SignedQuote {
    let mut q = SignedQuote {
        article_id: "paper-1".into(),
        quote_id: id.into(),
        passage_hash: HASH.into(),
        price: U128(price),
        expires_at_ns: U64(NOW + 60_000_000_000),
        signature: Base64VecU8(vec![]),
    };
    let msg = quote_message(&"citario.testnet".parse().unwrap(), &reader(), &q);
    q.signature = Base64VecU8(signer.sign(msg.as_bytes()).to_bytes().to_vec());
    q
}

#[test]
fn cite_pays_author_and_records() {
    let mut c = setup();
    ctx(reader(), 0);
    let price = 7 * NEAR / 100;
    c.cite(quote("q1", price, &key()));
    assert_eq!(c.reader_balance(reader()).0, NEAR - price);
    assert_eq!(c.author_balance(author()).0, price);
    assert_eq!(c.author_earnings(author()).0, price);
    let a = c.get_article("paper-1".into()).unwrap();
    assert_eq!(a.citations, 1);
    assert_eq!(c.list_citations(Some("paper-1".into()), None, None).len(), 1);
}

#[test]
#[should_panic(expected = "quote already used")]
fn quote_is_single_use() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite(quote("q1", NEAR / 10, &key()));
    c.cite(quote("q1", NEAR / 10, &key()));
}

#[test]
#[should_panic(expected = "price outside the author's bounds")]
fn price_below_floor_rejected() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite(quote("q1", 0, &key()));
}

#[test]
#[should_panic(expected = "price outside the author's bounds")]
fn price_above_ceiling_rejected() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite(quote("q1", NEAR, &key()));
}

#[test]
#[should_panic(expected = "quote not signed by the facilitator")]
fn forged_quote_rejected() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite(quote("q1", NEAR / 10, &SigningKey::from_bytes(&[9u8; 32])));
}

#[test]
#[should_panic(expected = "quote not signed by the facilitator")]
fn quote_for_another_reader_rejected() {
    let mut c = setup();
    let q = quote("q1", NEAR / 10, &key());
    ctx(accounts(3), NEAR);
    c.deposit(None);
    ctx(accounts(3), 0);
    c.cite(q);
}

#[test]
#[should_panic(expected = "quote expired")]
fn expired_quote_rejected() {
    let mut c = setup();
    let mut q = quote("q1", NEAR / 10, &key());
    q.expires_at_ns = U64(NOW - 1);
    ctx(reader(), 0);
    c.cite(q);
}

#[test]
#[should_panic(expected = "reader balance too low")]
fn insufficient_balance_rejected() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite(quote("q1", NEAR / 2, &key()));
    c.cite(quote("q2", NEAR / 2, &key()));
    c.cite(quote("q3", NEAR / 2, &key()));
}

#[test]
#[should_panic(expected = "only the author can set bounds")]
fn only_author_sets_bounds() {
    let mut c = setup();
    ctx(reader(), 0);
    c.set_bounds("paper-1".into(), U128(1), U128(2));
}

#[test]
fn author_withdraws() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite(quote("q1", NEAR / 10, &key()));
    ctx(author(), 0);
    c.withdraw();
    assert_eq!(c.author_balance(author()).0, 0);
    assert_eq!(c.author_earnings(author()).0, NEAR / 10);
}
