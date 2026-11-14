//! Citario: agents pay authors per citation.
//!
//! The contract enforces what the author agreed to (price bounds), that every
//! paid passage comes from a quote the facilitator signed, that a quote is used
//! once, and which papers may be sold at all. It does not know whether the AI's
//! price is "right"; it knows the price is inside the author's bounds.
//!
//! Three ways an agent pays:
//! - `cite(quote)`: buys a passage of a registered, active, `Paid` article.
//! - `cite_fee(article_id, amount)`: a citation fee to a registered article,
//!   no text delivered. The only option for `CiteOnly` articles.
//! - `cite_doi(doi, amount)`: a citation fee to any DOI. If no verified author
//!   holds that DOI yet, the money waits in escrow until one is approved; each
//!   payer can take back what they put in after `escrow_ttl_ns`.
//!
//! Selling text needs rights: `Paid` is allowed only for author-retained, CC0,
//! CC-BY and CC-BY-SA. Anything else (CC-BY-NC, publisher copyright, unknown)
//! can only be `CiteOnly`. A registration that names a DOI stays pending until
//! the verifier account checks authorship and calls `approve_author`.
//!
//! Function-call access keys cannot attach a deposit, so agents spend from a
//! balance funded with `deposit`. Authors withdraw with `withdraw`.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PublicKey};

#[cfg(test)]
mod tests;

/// Longest a signed quote may live, so a leaked quote cannot be replayed later.
pub const MAX_QUOTE_TTL_NS: u64 = 15 * 60 * 1_000_000_000;
pub const DEFAULT_ESCROW_TTL_NS: u64 = 180 * 24 * 3600 * 1_000_000_000;
pub const DEFAULT_MIN_CITE_FEE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

/// Licenses under which the text itself may be sold.
pub const PAID_LICENSES: [&str; 4] = ["author-retained", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0"];

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum Mode {
    /// Passages are sold through signed quotes.
    Paid,
    /// The text is never sold; agents pay citation fees only.
    CiteOnly,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Article {
    pub article_id: String,
    pub author: AccountId,
    /// sha256 of the plaintext article, hex. Empty for CiteOnly articles without text.
    pub content_hash: String,
    pub title: String,
    pub floor: U128,
    pub ceiling: U128,
    pub citations: u32,
    pub earned: U128,
    pub doi: Option<String>,
    pub license: String,
    pub mode: Mode,
    /// false while a DOI registration waits for the verifier.
    pub active: bool,
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

/// A citation fee: to a registered article, or to a DOI (maybe still in escrow).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct FeeCitation {
    pub reader: AccountId,
    pub doi: Option<String>,
    pub article_id: Option<String>,
    pub amount: U128,
    /// true when the fee went to escrow because no verified author held the DOI.
    pub escrowed: bool,
    pub block_height: U64,
    pub timestamp_ns: U64,
}

#[near(serializers = [json])]
pub struct DoiInfo {
    pub doi: String,
    pub owner: Option<AccountId>,
    pub article_id: Option<String>,
    pub escrow: U128,
    pub fee_citations: u32,
    pub total_fees: U128,
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
    escrow_ttl_ns: u64,
    min_cite_fee: u128,
    articles: LookupMap<String, Article>,
    article_ids: Vector<String>,
    citations: LookupMap<String, Citation>,
    citation_ids: Vector<String>,
    fee_citations: Vector<FeeCitation>,
    reader_balance: LookupMap<AccountId, u128>,
    author_balance: LookupMap<AccountId, u128>,
    author_earned: LookupMap<AccountId, u128>,
    doi_owner: LookupMap<String, AccountId>,
    doi_article: LookupMap<String, String>,
    doi_escrow: LookupMap<String, u128>,
    doi_fee_count: LookupMap<String, u32>,
    doi_fee_total: LookupMap<String, u128>,
    /// key: "{doi}|{payer}" -> (amount, last contribution ns)
    escrow_contrib: LookupMap<String, (u128, u64)>,
}

/// The exact bytes the facilitator signs and the contract verifies.
pub fn quote_message(contract: &AccountId, reader: &AccountId, q: &SignedQuote) -> String {
    format!(
        "citario-quote:v1:{}:{}:{}:{}:{}:{}:{}",
        contract, reader, q.article_id, q.quote_id, q.passage_hash, q.price.0, q.expires_at_ns.0
    )
}

/// Lowercase, strip resolver prefixes. A DOI must start with "10.".
pub fn normalize_doi(doi: &str) -> String {
    let d = doi.trim().to_lowercase();
    let d = d
        .trim_start_matches("https://doi.org/")
        .trim_start_matches("http://doi.org/")
        .trim_start_matches("https://dx.doi.org/")
        .trim_start_matches("doi:")
        .to_string();
    require!(d.starts_with("10.") && d.contains('/') && d.len() <= 200, "not a DOI (expected 10.xxxx/...)");
    d
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let payload = json!({ "standard": "citario", "version": "2.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[near]
impl Citario {
    #[init]
    pub fn new(owner: AccountId, facilitator_key: PublicKey, escrow_ttl_ns: Option<U64>, min_cite_fee: Option<U128>) -> Self {
        require!(matches!(facilitator_key.curve_type(), near_sdk::CurveType::ED25519), "facilitator key must be ed25519");
        Self {
            owner,
            facilitator_key,
            escrow_ttl_ns: escrow_ttl_ns.map_or(DEFAULT_ESCROW_TTL_NS, |t| t.0),
            min_cite_fee: min_cite_fee.map_or(DEFAULT_MIN_CITE_FEE, |m| m.0),
            articles: LookupMap::new(b"a"),
            article_ids: Vector::new(b"i"),
            citations: LookupMap::new(b"c"),
            citation_ids: Vector::new(b"q"),
            fee_citations: Vector::new(b"f"),
            reader_balance: LookupMap::new(b"r"),
            author_balance: LookupMap::new(b"b"),
            author_earned: LookupMap::new(b"e"),
            doi_owner: LookupMap::new(b"o"),
            doi_article: LookupMap::new(b"d"),
            doi_escrow: LookupMap::new(b"x"),
            doi_fee_count: LookupMap::new(b"n"),
            doi_fee_total: LookupMap::new(b"t"),
            escrow_contrib: LookupMap::new(b"k"),
        }
    }

    // ---------- author ----------

    /// The caller becomes the author. Bounds are in yoctoNEAR; for CiteOnly they
    /// are the suggested citation fee range.
    #[allow(clippy::too_many_arguments)]
    pub fn register_article(
        &mut self,
        article_id: String,
        title: String,
        content_hash: String,
        floor: U128,
        ceiling: U128,
        license: String,
        mode: Mode,
        doi: Option<String>,
    ) -> Article {
        require!(!article_id.is_empty() && article_id.len() <= 64, "article_id must be 1-64 chars");
        require!(title.len() <= 300, "title too long");
        require!(!license.is_empty() && license.len() <= 64, "license must be 1-64 chars");
        require!(self.articles.get(&article_id).is_none(), "article_id already registered");
        require!(floor.0 > 0 && floor.0 <= ceiling.0, "need 0 < floor <= ceiling");
        match mode {
            Mode::Paid => {
                require!(PAID_LICENSES.contains(&license.as_str()), "this license does not allow selling the text; register as CiteOnly");
                require!(content_hash.len() == 64, "content_hash must be sha256 hex");
            }
            Mode::CiteOnly => require!(content_hash.is_empty() || content_hash.len() == 64, "content_hash must be empty or sha256 hex"),
        }
        let author = env::predecessor_account_id();
        let doi = doi.map(|d| normalize_doi(&d));
        let mut active = true;
        if let Some(d) = &doi {
            require!(self.doi_article.get(d).is_none(), "this DOI is already registered");
            match self.doi_owner.get(d) {
                Some(o) => require!(*o == author, "this DOI belongs to another verified author"),
                None => active = false,
            }
            self.doi_article.insert(d.clone(), article_id.clone());
        }
        let article = Article {
            article_id: article_id.clone(),
            author: author.clone(),
            content_hash,
            title,
            floor,
            ceiling,
            citations: 0,
            earned: U128(0),
            doi: doi.clone(),
            license: license.clone(),
            mode: mode.clone(),
            active,
        };
        self.articles.insert(article_id.clone(), article.clone());
        self.article_ids.push(article_id.clone());
        emit(
            "register",
            json!({ "article_id": article_id, "author": author, "doi": doi, "license": license, "mode": mode, "active": active, "floor": floor, "ceiling": ceiling }),
        );
        article
    }

    pub fn set_bounds(&mut self, article_id: String, floor: U128, ceiling: U128) {
        require!(floor.0 > 0 && floor.0 <= ceiling.0, "need 0 < floor <= ceiling");
        let a = self.articles.get_mut(&article_id).unwrap_or_else(|| env::panic_str("unknown article"));
        require!(a.author == env::predecessor_account_id(), "only the author can set bounds");
        a.floor = floor;
        a.ceiling = ceiling;
        emit("set_bounds", json!({ "article_id": article_id, "floor": floor, "ceiling": ceiling }));
    }

    /// Author pulls everything earned so far, including released escrow.
    pub fn withdraw(&mut self) -> Promise {
        let author = env::predecessor_account_id();
        let amount = self.author_balance.get(&author).copied().unwrap_or(0);
        require!(amount > 0, "nothing to withdraw");
        self.author_balance.insert(author.clone(), 0);
        emit("withdraw", json!({ "author": author, "amount": U128(amount) }));
        Promise::new(author).transfer(NearToken::from_yoctonear(amount))
    }

    // ---------- verifier (owner) ----------

    /// After an off-chain authorship check (Crossref author list, ORCID, email on
    /// the paper), binds a DOI to an author: activates their registration for it
    /// and releases the DOI's escrow to them.
    pub fn approve_author(&mut self, doi: String, author: AccountId) -> U128 {
        require!(env::predecessor_account_id() == self.owner, "verifier only");
        let doi = normalize_doi(&doi);
        if let Some(o) = self.doi_owner.get(&doi) {
            require!(*o == author, "DOI already bound to another author");
        }
        self.doi_owner.insert(doi.clone(), author.clone());
        if let Some(id) = self.doi_article.get(&doi).cloned() {
            let a = self.articles.get_mut(&id).unwrap();
            require!(a.author == author, "the registration for this DOI is by a different account");
            a.active = true;
        }
        let released = self.doi_escrow.get(&doi).copied().unwrap_or(0);
        if released > 0 {
            self.doi_escrow.insert(doi.clone(), 0);
            self.credit_author(&author, released);
        }
        emit("approve_author", json!({ "doi": doi, "author": author, "released": U128(released) }));
        U128(released)
    }

    /// Verifier removes a pending registration it will not approve (frees the DOI).
    pub fn reject_registration(&mut self, article_id: String, reason: String) {
        require!(env::predecessor_account_id() == self.owner, "verifier only");
        let a = self.articles.get(&article_id).cloned().unwrap_or_else(|| env::panic_str("unknown article"));
        require!(!a.active, "only pending registrations can be rejected");
        if let Some(d) = &a.doi {
            self.doi_article.remove(d);
        }
        self.articles.remove(&article_id);
        emit("reject_registration", json!({ "article_id": article_id, "author": a.author, "reason": reason }));
    }

    pub fn set_facilitator_key(&mut self, facilitator_key: PublicKey) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(matches!(facilitator_key.curve_type(), near_sdk::CurveType::ED25519), "ed25519 only");
        self.facilitator_key = facilitator_key;
    }

    // ---------- reader ----------

    /// Top up a reader balance. `reader` defaults to the caller, so a human can
    /// fund an agent account that only holds a function-call key.
    #[payable]
    pub fn deposit(&mut self, reader: Option<AccountId>) {
        let reader = reader.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach a deposit");
        self.add_reader_balance(&reader, amount);
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
            require!(a.active, "article is pending verification");
            require!(a.mode == Mode::Paid, "this article's text is not for sale; use cite_fee");
            (a.author.clone(), a.floor.0, a.ceiling.0)
        };
        require!(price >= floor && price <= ceiling, "price outside the author's bounds");

        self.spend(&reader, price);
        self.credit_author(&author, price);
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

    /// A citation fee to a registered, active article (no text delivered).
    /// Spends from the reader balance; any attached deposit is added first.
    #[payable]
    pub fn cite_fee(&mut self, article_id: String, amount: U128) -> FeeCitation {
        let reader = env::predecessor_account_id();
        self.take_attached(&reader);
        require!(amount.0 >= self.min_cite_fee, "amount below the minimum citation fee");
        let author = {
            let a = self.articles.get(&article_id).unwrap_or_else(|| env::panic_str("unknown article"));
            require!(a.active, "article is pending verification; pay its DOI with cite_doi instead");
            a.author.clone()
        };
        self.spend(&reader, amount.0);
        self.credit_author(&author, amount.0);
        let doi = {
            let a = self.articles.get_mut(&article_id).unwrap();
            a.citations += 1;
            a.earned = U128(a.earned.0 + amount.0);
            a.doi.clone()
        };
        if let Some(d) = &doi {
            self.count_doi_fee(d, amount.0);
        }
        self.record_fee(reader, doi, Some(article_id), amount, false)
    }

    /// A citation fee to any DOI. Goes to the verified author if there is one,
    /// otherwise waits in escrow for them. Spends from the reader balance; any
    /// attached deposit is added first.
    #[payable]
    pub fn cite_doi(&mut self, doi: String, amount: U128) -> FeeCitation {
        let reader = env::predecessor_account_id();
        self.take_attached(&reader);
        require!(amount.0 >= self.min_cite_fee, "amount below the minimum citation fee");
        let doi = normalize_doi(&doi);
        self.spend(&reader, amount.0);
        self.count_doi_fee(&doi, amount.0);
        match self.doi_owner.get(&doi).cloned() {
            Some(author) => {
                self.credit_author(&author, amount.0);
                let article_id = self.doi_article.get(&doi).cloned();
                if let Some(id) = &article_id {
                    if let Some(a) = self.articles.get_mut(id) {
                        a.citations += 1;
                        a.earned = U128(a.earned.0 + amount.0);
                    }
                }
                self.record_fee(reader, Some(doi), article_id, amount, false)
            }
            None => {
                let e = self.doi_escrow.get(&doi).copied().unwrap_or(0);
                self.doi_escrow.insert(doi.clone(), e + amount.0);
                let key = format!("{doi}|{reader}");
                let (prev, _) = self.escrow_contrib.get(&key).copied().unwrap_or((0, 0));
                self.escrow_contrib.insert(key, (prev + amount.0, env::block_timestamp()));
                self.record_fee(reader, Some(doi), None, amount, true)
            }
        }
    }

    /// Take back your escrowed fees for a DOI no author claimed in time.
    /// The refund goes to your Citario reader balance.
    pub fn refund_escrow(&mut self, doi: String) -> U128 {
        let reader = env::predecessor_account_id();
        let doi = normalize_doi(&doi);
        require!(self.doi_owner.get(&doi).is_none(), "an author was verified; the fees are theirs");
        let key = format!("{doi}|{reader}");
        let (amount, at) = self.escrow_contrib.get(&key).copied().unwrap_or((0, 0));
        require!(amount > 0, "nothing of yours in this escrow");
        require!(env::block_timestamp() >= at + self.escrow_ttl_ns, "escrow still waiting for the author");
        self.escrow_contrib.remove(&key);
        let e = self.doi_escrow.get(&doi).copied().unwrap_or(0);
        self.doi_escrow.insert(doi.clone(), e.saturating_sub(amount));
        self.add_reader_balance(&reader, amount);
        emit("refund_escrow", json!({ "doi": doi, "reader": reader, "amount": U128(amount) }));
        U128(amount)
    }

    /// Reader takes back unspent balance.
    pub fn withdraw_reader(&mut self, amount: U128) -> Promise {
        let reader = env::predecessor_account_id();
        let bal = self.reader_balance.get(&reader).copied().unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= bal, "amount exceeds balance");
        self.reader_balance.insert(reader.clone(), bal - amount.0);
        Promise::new(reader).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------- views ----------

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "owner": self.owner, "facilitator_key": self.facilitator_key,
            "escrow_ttl_ns": U64(self.escrow_ttl_ns), "min_cite_fee": U128(self.min_cite_fee),
            "paid_licenses": PAID_LICENSES,
        })
    }

    pub fn get_facilitator_key(&self) -> &PublicKey {
        &self.facilitator_key
    }

    pub fn get_article(&self, article_id: String) -> Option<&Article> {
        self.articles.get(&article_id)
    }

    pub fn list_articles(&self, from: Option<u32>, limit: Option<u32>) -> Vec<&Article> {
        self.article_ids
            .iter()
            .filter_map(|id| self.articles.get(id))
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .collect()
    }

    pub fn get_doi(&self, doi: String) -> DoiInfo {
        let doi = normalize_doi(&doi);
        DoiInfo {
            owner: self.doi_owner.get(&doi).cloned(),
            article_id: self.doi_article.get(&doi).cloned(),
            escrow: U128(self.doi_escrow.get(&doi).copied().unwrap_or(0)),
            fee_citations: self.doi_fee_count.get(&doi).copied().unwrap_or(0),
            total_fees: U128(self.doi_fee_total.get(&doi).copied().unwrap_or(0)),
            doi,
        }
    }

    pub fn get_citation(&self, quote_id: String) -> Option<&Citation> {
        self.citations.get(&quote_id)
    }

    /// Newest first. `article_id` filters.
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

    /// Citation fees, newest first. `doi` filters.
    pub fn list_fee_citations(&self, doi: Option<String>, from: Option<u32>, limit: Option<u32>) -> Vec<&FeeCitation> {
        let doi = doi.map(|d| normalize_doi(&d));
        let limit = limit.unwrap_or(50).min(100) as usize;
        let n = self.fee_citations.len();
        (0..n)
            .rev()
            .filter_map(|i| self.fee_citations.get(i))
            .filter(|f| doi.as_ref().map_or(true, |d| f.doi.as_ref() == Some(d)))
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

    pub fn escrow_contribution(&self, doi: String, reader: AccountId) -> (U128, U64) {
        let doi = normalize_doi(&doi);
        let (a, t) = self.escrow_contrib.get(&format!("{doi}|{reader}")).copied().unwrap_or((0, 0));
        (U128(a), U64(t))
    }
}

impl Citario {
    fn add_reader_balance(&mut self, reader: &AccountId, amount: u128) {
        let bal = self.reader_balance.get(reader).copied().unwrap_or(0);
        self.reader_balance.insert(reader.clone(), bal + amount);
    }

    fn take_attached(&mut self, reader: &AccountId) {
        let d = env::attached_deposit().as_yoctonear();
        if d > 0 {
            self.add_reader_balance(reader, d);
        }
    }

    fn spend(&mut self, reader: &AccountId, amount: u128) {
        let bal = self.reader_balance.get(reader).copied().unwrap_or(0);
        require!(bal >= amount, "reader balance too low; call deposit first");
        self.reader_balance.insert(reader.clone(), bal - amount);
    }

    fn credit_author(&mut self, author: &AccountId, amount: u128) {
        let b = self.author_balance.get(author).copied().unwrap_or(0);
        self.author_balance.insert(author.clone(), b + amount);
        let e = self.author_earned.get(author).copied().unwrap_or(0);
        self.author_earned.insert(author.clone(), e + amount);
    }

    fn count_doi_fee(&mut self, doi: &str, amount: u128) {
        let n = self.doi_fee_count.get(doi).copied().unwrap_or(0);
        self.doi_fee_count.insert(doi.to_string(), n + 1);
        let t = self.doi_fee_total.get(doi).copied().unwrap_or(0);
        self.doi_fee_total.insert(doi.to_string(), t + amount);
    }

    fn record_fee(&mut self, reader: AccountId, doi: Option<String>, article_id: Option<String>, amount: U128, escrowed: bool) -> FeeCitation {
        let f = FeeCitation {
            reader: reader.clone(),
            doi: doi.clone(),
            article_id: article_id.clone(),
            amount,
            escrowed,
            block_height: U64(env::block_height()),
            timestamp_ns: U64(env::block_timestamp()),
        };
        self.fee_citations.push(f.clone());
        emit(
            "cite_fee",
            json!({ "reader": reader, "doi": doi, "article_id": article_id, "amount": amount, "escrowed": escrowed, "block": f.block_height }),
        );
        f
    }
}
