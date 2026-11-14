use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 10u128.pow(24);
const NOW: u64 = 1_000_000_000_000;
const TTL: u64 = 1_000_000_000;
const DOI: &str = "10.1234/abc.5678";
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
    let mut c = Citario::new(accounts(0), pubkey(&key()), Some(U64(TTL)), None);
    ctx(author(), 0);
    c.register_article("paper-1".into(), "A paper".into(), HASH.into(), U128(NEAR / 20), U128(NEAR / 2), "author-retained".into(), Mode::Paid, None);
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

fn ctx_at(who: AccountId, deposit: u128, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("citario.testnet".parse().unwrap())
        .predecessor_account_id(who)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts)
        .build());
}

#[test]
#[should_panic(expected = "does not allow selling the text")]
fn nc_license_cannot_be_sold() {
    let mut c = setup();
    ctx(author(), 0);
    c.register_article("p2".into(), "NC".into(), HASH.into(), U128(1), U128(2), "CC-BY-NC-4.0".into(), Mode::Paid, None);
}

#[test]
#[should_panic(expected = "text is not for sale")]
fn cite_only_rejects_quotes() {
    let mut c = setup();
    ctx(author(), 0);
    c.register_article("p2".into(), "NC".into(), "".into(), U128(NEAR / 100), U128(NEAR / 10), "CC-BY-NC-4.0".into(), Mode::CiteOnly, None);
    let mut q = quote("q1", NEAR / 10, &key());
    q.article_id = "p2".into();
    let msg = quote_message(&"citario.testnet".parse().unwrap(), &reader(), &q);
    q.signature = Base64VecU8(key().sign(msg.as_bytes()).to_bytes().to_vec());
    ctx(reader(), 0);
    c.cite(q);
}

#[test]
fn cite_fee_pays_cite_only_author() {
    let mut c = setup();
    ctx(author(), 0);
    c.register_article("p2".into(), "NC".into(), "".into(), U128(NEAR / 100), U128(NEAR / 10), "CC-BY-NC-4.0".into(), Mode::CiteOnly, None);
    ctx(reader(), 0);
    c.cite_fee("p2".into(), U128(NEAR / 50));
    assert_eq!(c.author_balance(author()).0, NEAR / 50);
    assert_eq!(c.list_fee_citations(None, None, None).len(), 1);
}

#[test]
fn unregistered_doi_escrows_then_releases_on_approval() {
    let mut c = setup();
    ctx(reader(), 0);
    let f = c.cite_doi(format!("https://doi.org/{}", DOI.to_uppercase()), U128(NEAR / 50));
    assert!(f.escrowed);
    assert_eq!(c.get_doi(DOI.into()).escrow.0, NEAR / 50);
    assert_eq!(c.author_balance(author()).0, 0);

    // author registers it: pending until the verifier approves
    ctx(author(), 0);
    let a = c.register_article("p3".into(), "DOI paper".into(), HASH.into(), U128(NEAR / 20), U128(NEAR / 2), "CC-BY-4.0".into(), Mode::Paid, Some(DOI.into()));
    assert!(!a.active);

    ctx(accounts(0), 0);
    let released = c.approve_author(DOI.into(), author());
    assert_eq!(released.0, NEAR / 50);
    assert_eq!(c.author_balance(author()).0, NEAR / 50);
    assert!(c.get_article("p3".into()).unwrap().active);
    assert_eq!(c.get_doi(DOI.into()).escrow.0, 0);

    // later DOI fees go straight to the author
    ctx(reader(), 0);
    let f2 = c.cite_doi(DOI.into(), U128(NEAR / 50));
    assert!(!f2.escrowed);
    assert_eq!(c.author_balance(author()).0, 2 * NEAR / 50);
}

#[test]
#[should_panic(expected = "article is pending verification")]
fn pending_doi_article_cannot_be_cited() {
    let mut c = setup();
    ctx(author(), 0);
    c.register_article("p3".into(), "DOI paper".into(), HASH.into(), U128(NEAR / 20), U128(NEAR / 2), "CC-BY-4.0".into(), Mode::Paid, Some(DOI.into()));
    let mut q = quote("q1", NEAR / 10, &key());
    q.article_id = "p3".into();
    let msg = quote_message(&"citario.testnet".parse().unwrap(), &reader(), &q);
    q.signature = Base64VecU8(key().sign(msg.as_bytes()).to_bytes().to_vec());
    ctx(reader(), 0);
    c.cite(q);
}

#[test]
#[should_panic(expected = "verifier only")]
fn only_verifier_approves() {
    let mut c = setup();
    ctx(author(), 0);
    c.approve_author(DOI.into(), author());
}

#[test]
fn escrow_refund_after_ttl() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite_doi(DOI.into(), U128(NEAR / 50));
    let before = c.reader_balance(reader()).0;
    ctx_at(reader(), 0, NOW + TTL);
    assert_eq!(c.refund_escrow(DOI.into()).0, NEAR / 50);
    assert_eq!(c.reader_balance(reader()).0, before + NEAR / 50);
    assert_eq!(c.get_doi(DOI.into()).escrow.0, 0);
}

#[test]
#[should_panic(expected = "escrow still waiting")]
fn escrow_refund_too_early() {
    let mut c = setup();
    ctx(reader(), 0);
    c.cite_doi(DOI.into(), U128(NEAR / 50));
    c.refund_escrow(DOI.into());
}

#[test]
#[should_panic(expected = "belongs to another verified author")]
fn verified_doi_cannot_be_registered_by_someone_else() {
    let mut c = setup();
    ctx(accounts(0), 0);
    c.approve_author(DOI.into(), author());
    ctx(accounts(3), 0);
    c.register_article("p4".into(), "stolen".into(), HASH.into(), U128(1), U128(2), "CC-BY-4.0".into(), Mode::Paid, Some(DOI.into()));
}

#[test]
fn cite_fee_with_attached_deposit() {
    let mut c = setup();
    ctx(accounts(4), NEAR / 50);
    c.cite_doi(DOI.into(), U128(NEAR / 50));
    assert_eq!(c.reader_balance(accounts(4)).0, 0);
    assert_eq!(c.get_doi(DOI.into()).escrow.0, NEAR / 50);
}
