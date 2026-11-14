//! Citario: agents pay authors per citation.
//!
//! The contract enforces what the author agreed to (price bounds), that every
//! citation comes from a quote the facilitator signed, and that a quote is used
//! once. It does not know whether the AI's price is "right"; it knows the price
//! is inside the author's bounds. Code enforces, AI explains.
//!
//! Function-call access keys cannot attach a deposit, so a reader agent's owner
//! tops up a balance with `deposit` (full-access key) and the agent's limited key
//! calls `cite`, which spends from that balance. Authors withdraw their earnings
//! with `withdraw`, so a payment never fails because an author account is missing.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PublicKey};

#[cfg(test)]
mod tests;

/// Longest a signed quote may live, so a leaked quote cannot be replayed later.
pub const MAX_QUOTE_TTL_NS: u64 = 15 * 60 * 1_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Article {
    pub article_id: String,
    pub author: AccountId,
    /// sha256 of the plaintext article, hex. The text itself never goes on chain.
    pub content_hash: String,
    pub title: String,
    pub floor: U128,
    pub ceiling: U128,
    pub citations: u32,
    pub earned: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Citation {
    pub quote_id: String,
    pub article_id: String,
    pub reader: AccountId,
    pub passage_hash: String,
    pub price: U128,
    pub block_height: U64,
    pub timestamp_ns: U64,
}

#[near(serializers = [json])]
pub struct SignedQuote {
    pub article_id: String,
    pub quote_id: String,
    pub passage_hash: String,
    pub price: U128,
    pub expires_at_ns: U64,
    /// ed25519 signature by the facilitator key over `quote_message(..)`, base64 bytes.
    pub signature: near_sdk::json_types::Base64VecU8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Citario {
    owner: AccountId,
    facilitator_key: PublicKey,
    articles: LookupMap<String, Article>,
    article_ids: Vector<String>,
    citations: LookupMap<String, Citation>,
    citation_ids: Vector<String>,
    reader_balance: LookupMap<AccountId, u128>,
    author_balance: LookupMap<AccountId, u128>,
    author_earned: LookupMap<AccountId, u128>,
}

/// The exact bytes the facilitator signs and the contract verifies.
pub fn quote_message(contract: &AccountId, reader: &AccountId, q: &SignedQuote) -> String {
    format!(
        "citario-quote:v1:{}:{}:{}:{}:{}:{}:{}",
        contract, reader, q.article_id, q.quote_id, q.passage_hash, q.price.0, q.expires_at_ns.0
    )
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({ "standard": "citario", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[near]
impl Citario {
    #[init]
    pub fn new(owner: AccountId, facilitator_key: PublicKey) -> Self {
        require!(
            matches!(facilitator_key.curve_type(), near_sdk::CurveType::ED25519),
            "facilitator key must be ed25519"
        );
        Self {
            owner,
            facilitator_key,
            articles: LookupMap::new(b"a"),
            article_ids: Vector::new(b"i"),
            citations: LookupMap::new(b"c"),
            citation_ids: Vector::new(b"q"),
            reader_balance: LookupMap::new(b"r"),
            author_balance: LookupMap::new(b"b"),
            author_earned: LookupMap::new(b"e"),
        }
    }

    // ---------- author ----------

    /// The caller becomes the author. Bounds are in yoctoNEAR.
    pub fn register_article(
        &mut self,
        article_id: String,
        title: String,
        content_hash: String,
        floor: U128,
        ceiling: U128,
    ) {
        require!(!article_id.is_empty() && article_id.len() <= 64, "article_id must be 1-64 chars");
        require!(title.len() <= 200, "title too long");
        require!(content_hash.len() == 64, "content_hash must be sha256 hex");
        require!(self.articles.get(&article_id).is_none(), "article_id already registered");
        require!(floor.0 > 0 && floor.0 <= ceiling.0, "need 0 < floor <= ceiling");
        let author = env::predecessor_account_id();
        let article = Article {
            article_id: article_id.clone(),
            author: author.clone(),
            content_hash,
            title,
            floor,
            ceiling,
            citations: 0,
            earned: U128(0),
        };
        self.articles.insert(article_id.clone(), article);
        self.article_ids.push(article_id.clone());
        emit("register", json!({ "article_id": article_id, "author": author, "floor": floor, "ceiling": ceiling }));
    }

    pub fn set_bounds(&mut self, article_id: String, floor: U128, ceiling: U128) {
        require!(floor.0 > 0 && floor.0 <= ceiling.0, "need 0 < floor <= ceiling");
        let a = self.articles.get_mut(&article_id).unwrap_or_else(|| env::panic_str("unknown article"));
        require!(a.author == env::predecessor_account_id(), "only the author can set bounds");
        a.floor = floor;
        a.ceiling = ceiling;
        emit("set_bounds", json!({ "article_id": article_id, "floor": floor, "ceiling": ceiling }));
    }

    /// Author pulls everything earned so far.
    pub fn withdraw(&mut self) -> Promise {
        let author = env::predecessor_account_id();
        let amount = self.author_balance.get(&author).copied().unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.author_balance.insert(author.clone(), 0);
        emit("withdraw", json!({ "author": author, "amount": U128(amount) }));
        Promise::new(author).transfer(NearToken::from_yoctonear(amount))
    }

    // ---------- reader ----------

    /// Top up a reader balance. `reader` defaults to the caller, so a human can
    /// fund an agent account that only holds a function-call key.
    #[payable]
    pub fn deposit(&mut self, reader: Option<AccountId>) {
        let reader = reader.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach a deposit");
        let bal = self.reader_balance.get(&reader).copied().unwrap_or(0);
        self.reader_balance.insert(reader.clone(), bal + amount);
        emit("deposit", json!({ "reader": reader, "amount": U128(amount) }));
    }

    /// Pay for a signed quote. Callable with a function-call key (no deposit).
    pub fn cite(&mut self, quote: SignedQuote) -> Citation {
        let reader = env::predecessor_account_id();
        let now = env::block_timestamp();
        require!(now < quote.expires_at_ns.0, "quote expired");
        require!(quote.expires_at_ns.0 <= now + MAX_QUOTE_TTL_NS, "quote ttl too long");
        require!(self.citations.get(&quote.quote_id).is_none(), "quote already used");
        require!(quote.passage_hash.len() == 64, "passage_hash must be sha256 hex");

        let msg = quote_message(&env::current_account_id(), &reader, &quote);
        let sig: [u8; 64] = quote.signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("bad signature length"));
        let pk: [u8; 32] = self.facilitator_key.as_bytes()[1..].try_into().unwrap();
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &pk), "quote not signed by the facilitator");

        let price = quote.price.0;
        let (author, floor, ceiling) = {
            let a = self.articles.get(&quote.article_id).unwrap_or_else(|| env::panic_str("unknown article"));
            (a.author.clone(), a.floor.0, a.ceiling.0)
        };
        require!(price >= floor && price <= ceiling, "price outside the author's bounds");

        let bal = self.reader_balance.get(&reader).copied().unwrap_or(0);
        require!(bal >= price, "reader balance too low; call deposit first");
        self.reader_balance.insert(reader.clone(), bal - price);

        let ab = self.author_balance.get(&author).copied().unwrap_or(0);
        self.author_balance.insert(author.clone(), ab + price);
        let ae = self.author_earned.get(&author).copied().unwrap_or(0);
        self.author_earned.insert(author.clone(), ae + price);
        let a = self.articles.get_mut(&quote.article_id).unwrap();
        a.citations += 1;
        a.earned = U128(a.earned.0 + price);

        let c = Citation {
            quote_id: quote.quote_id.clone(),
            article_id: quote.article_id.clone(),
            reader: reader.clone(),
            passage_hash: quote.passage_hash.clone(),
            price: quote.price,
            block_height: U64(env::block_height()),
            timestamp_ns: U64(now),
        };
        self.citations.insert(quote.quote_id.clone(), c.clone());
        self.citation_ids.push(quote.quote_id.clone());
        emit(
            "cite",
            json!({
                "article_id": c.article_id, "quote_id": c.quote_id, "passage_hash": c.passage_hash,
                "price": c.price, "reader": reader, "author": author, "block": c.block_height,
            }),
        );
        c
    }

    /// Reader takes back unspent balance.
    pub fn withdraw_reader(&mut self, amount: U128) -> Promise {
        let reader = env::predecessor_account_id();
        let bal = self.reader_balance.get(&reader).copied().unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= bal, "amount exceeds balance");
        self.reader_balance.insert(reader.clone(), bal - amount.0);
        Promise::new(reader).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------- owner ----------

    pub fn set_facilitator_key(&mut self, facilitator_key: PublicKey) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(matches!(facilitator_key.curve_type(), near_sdk::CurveType::ED25519), "ed25519 only");
        self.facilitator_key = facilitator_key;
    }

    // ---------- views ----------

    pub fn get_facilitator_key(&self) -> &PublicKey {
        &self.facilitator_key
    }

    pub fn get_article(&self, article_id: String) -> Option<&Article> {
        self.articles.get(&article_id)
    }

    pub fn list_articles(&self, from: Option<u32>, limit: Option<u32>) -> Vec<&Article> {
        self.article_ids
            .iter()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|id| self.articles.get(id))
            .collect()
    }

    pub fn get_citation(&self, quote_id: String) -> Option<&Citation> {
        self.citations.get(&quote_id)
    }

    /// Newest first. `article_id` filters; scans at most `from + limit*20` entries.
    pub fn list_citations(&self, article_id: Option<String>, from: Option<u32>, limit: Option<u32>) -> Vec<&Citation> {
        let limit = limit.unwrap_or(50).min(100) as usize;
        let n = self.citation_ids.len();
        (0..n)
            .rev()
            .filter_map(|i| self.citation_ids.get(i))
            .filter_map(|id| self.citations.get(id))
            .filter(|c| article_id.as_ref().map_or(true, |a| &c.article_id == a))
            .skip(from.unwrap_or(0) as usize)
            .take(limit)
            .collect()
    }

    pub fn author_earnings(&self, author: AccountId) -> U128 {
        U128(self.author_earned.get(&author).copied().unwrap_or(0))
    }

    pub fn author_balance(&self, author: AccountId) -> U128 {
        U128(self.author_balance.get(&author).copied().unwrap_or(0))
    }

    pub fn reader_balance(&self, reader: AccountId) -> U128 {
        U128(self.reader_balance.get(&reader).copied().unwrap_or(0))
    }
}
