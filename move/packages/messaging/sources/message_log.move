/// Per-group **paid message escrow** only (`MYSO`). Free messaging, digests, reactions,
/// pins, and receipts live off-chain (relayer / clients).
///
/// Authorization is enforced in `messaging`; this module holds escrow state and invariants.
module messaging::message_log;

use messaging::paid_escrow_settlement as escrow_fees;
use std::string::String;
use myso::balance::{Self, Balance};
use myso::clock::{Self, Clock};
use myso::coin::{Self, Coin};
use myso::derived_object;
use myso::event;
use myso::myso::MYSO;
use myso::table::{Self, Table};

// === Error codes ===

const EMessageLogExists: u64 = 0;
const EDedupeUsed: u64 = 1;
const ENonceUsed: u64 = 2;
const EForbidden: u64 = 5;
const EInsufficientPayment: u64 = 12;
const EPaidNotFound: u64 = 6;
const EPaymentExpired: u64 = 7;
const EPaymentClaimed: u64 = 8;
const EReplyTooShort: u64 = 9;
const EDedupeKeyTooLong: u64 = 10;
const EVaultEmpty: u64 = 11;

// === Paid messaging ===

const MIN_REPLY_CHARS: u32 = 6;
/// Paid message must be replied to within this wall-clock window (`Clock` ms).
const PAYMENT_EXPIRATION_MS: u64 = 30 * 86400000;

const MAX_DEDUPE_KEY_BYTES: u64 = 256;

// === Derivation ===

public struct MessageLogTag(String) has copy, drop, store;

// === Data ===

public struct PaidMessageEscrow has store {
    payer: address,
    recipient: address,
    amount: u64,
    escrowed_balance: Balance<MYSO>,
    created_at_ms: u64,
    claimed: bool,
}

public struct MessageLog has key, store {
    id: UID,
    group_id: ID,
    uuid: String,
    /// Monotonic id for each paid send (`seq` indexes `paid_msg_escrow`).
    next_seq: u64,
    used_dedupe: Table<vector<u8>, bool>,
    nonces: Table<address, Table<u128, bool>>,
    paid_msg_escrow: Table<u64, PaidMessageEscrow>,
}

// === Events ===

public struct MessageLogCreated has copy, drop {
    message_log_id: ID,
    group_id: ID,
    uuid: String,
}

public struct PaidMessageSent has copy, drop {
    group_id: ID,
    seq: u64,
    payer: address,
    recipient: address,
    amount: u64,
    created_at_ms: u64,
}

public struct PaidMessageReplied has copy, drop {
    group_id: ID,
    paid_msg_seq: u64,
    recipient: address,
    reply_char_count: u32,
}

public struct PaymentClaimed has copy, drop {
    group_id: ID,
    seq: u64,
    recipient: address,
    amount: u64,
    claimed_at_ms: u64,
}

public struct PaymentClaimedSettled has copy, drop {
    group_id: ID,
    seq: u64,
    recipient: address,
    total_amount: u64,
    platform_fee: u64,
    treasury_fee: u64,
    net_amount: u64,
    platform_fee_recipient: address,
    ecosystem_fee_recipient: address,
    claimed_at_ms: u64,
}

public struct PaymentRefunded has copy, drop {
    group_id: ID,
    seq: u64,
    payer: address,
    amount: u64,
    refunded_at_ms: u64,
}

// === Lifecycle ===

public(package) fun new(
    namespace_uid: &mut UID,
    uuid: String,
    group_id: ID,
    ctx: &mut TxContext,
): MessageLog {
    assert!(
        !derived_object::exists(namespace_uid, MessageLogTag(uuid)),
        EMessageLogExists,
    );
    let log = MessageLog {
        id: derived_object::claim(namespace_uid, MessageLogTag(uuid)),
        group_id,
        uuid,
        next_seq: 0,
        used_dedupe: table::new(ctx),
        nonces: table::new(ctx),
        paid_msg_escrow: table::new(ctx),
    };
    event::emit(MessageLogCreated {
        message_log_id: object::id(&log),
        group_id,
        uuid: log.uuid,
    });
    log
}

// === Getters ===

public fun group_id(self: &MessageLog): ID {
    self.group_id
}

public fun uuid(self: &MessageLog): String {
    self.uuid
}

public fun next_seq(self: &MessageLog): u64 {
    self.next_seq
}

/// Returns `(payer, recipient)` for a paid message escrow entry.
public(package) fun paid_message_parties(self: &MessageLog, paid_msg_seq: u64): (address, address) {
    let escrow = table::borrow(&self.paid_msg_escrow, paid_msg_seq);
    (escrow.payer, escrow.recipient)
}

// === Dedupe / nonce (replay protection for paid ops) ===

fun consume_dedupe_and_nonce(
    self: &mut MessageLog,
    sender: address,
    dedupe_key: vector<u8>,
    nonce: u128,
    ctx: &mut TxContext,
) {
    assert!(dedupe_key.length() <= MAX_DEDUPE_KEY_BYTES, EDedupeKeyTooLong);
    assert!(!table::contains(&self.used_dedupe, dedupe_key), EDedupeUsed);
    table::add(&mut self.used_dedupe, dedupe_key, true);

    if (!table::contains(&self.nonces, sender)) {
        table::add(&mut self.nonces, sender, table::new(ctx));
    };
    let member_nonces = table::borrow_mut(&mut self.nonces, sender);
    assert!(!table::contains(member_nonces, nonce), ENonceUsed);
    table::add(member_nonces, nonce, true);
}

// === Paid send / reply / refund ===

public(package) fun send_paid_message(
    self: &mut MessageLog,
    sender: address,
    recipient: address,
    mut payment: Coin<MYSO>,
    escrow_amount: u64,
    dedupe_key: vector<u8>,
    nonce: u128,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(coin::value(&payment) >= escrow_amount, EInsufficientPayment);

    consume_dedupe_and_nonce(self, sender, dedupe_key, nonce, ctx);

    let seq = self.next_seq;
    self.next_seq = seq + 1;

    let escrow_payment = coin::split(&mut payment, escrow_amount, ctx);
    let escrow_balance = coin::into_balance(escrow_payment);
    let created_at_ms = clock::timestamp_ms(clock);

    let escrow = PaidMessageEscrow {
        payer: sender,
        recipient,
        amount: escrow_amount,
        escrowed_balance: escrow_balance,
        created_at_ms,
        claimed: false,
    };
    table::add(&mut self.paid_msg_escrow, seq, escrow);

    event::emit(PaidMessageSent {
        group_id: self.group_id,
        seq,
        payer: sender,
        recipient,
        amount: escrow_amount,
        created_at_ms,
    });

    let pv = coin::value(&payment);
    if (pv > 0) {
        transfer::public_transfer(payment, sender);
    } else {
        coin::destroy_zero(payment);
    };
}

public(package) fun reply_to_paid_message_claim_coin(
    self: &mut MessageLog,
    sender: address,
    paid_msg_seq: u64,
    char_count: u32,
    dedupe_key: vector<u8>,
    nonce: u128,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<MYSO> {
    assert!(table::contains(&self.paid_msg_escrow, paid_msg_seq), EPaidNotFound);
    let escrow_ref = table::borrow(&self.paid_msg_escrow, paid_msg_seq);
    assert!(sender == escrow_ref.recipient, EForbidden);
    assert!(!escrow_ref.claimed, EPaymentClaimed);

    let now_ms = clock::timestamp_ms(clock);
    assert!(now_ms - escrow_ref.created_at_ms <= PAYMENT_EXPIRATION_MS, EPaymentExpired);
    assert!(char_count >= MIN_REPLY_CHARS, EReplyTooShort);

    consume_dedupe_and_nonce(self, sender, dedupe_key, nonce, ctx);

    event::emit(PaidMessageReplied {
        group_id: self.group_id,
        paid_msg_seq,
        recipient: sender,
        reply_char_count: char_count,
    });

    let escrow = table::borrow_mut(&mut self.paid_msg_escrow, paid_msg_seq);
    assert!(!escrow.claimed, EPaymentClaimed);
    escrow.claimed = true;

    let total_amount = escrow.amount;
    event::emit(PaymentClaimed {
        group_id: self.group_id,
        seq: paid_msg_seq,
        recipient: escrow.recipient,
        amount: total_amount,
        claimed_at_ms: clock::timestamp_ms(clock),
    });

    let coin = coin::from_balance(balance::withdraw_all(&mut escrow.escrowed_balance), ctx);
    assert!(coin::value(&coin) > 0, EVaultEmpty);
    coin
}

/// Same as [`reply_to_paid_message_claim_coin`], then splits escrow per paid-message BPS to
/// `platform_fee_recipient`, `ecosystem_fee_recipient`, and the original paid-message recipient.
public(package) fun reply_to_paid_message_claim_settled(
    self: &mut MessageLog,
    sender: address,
    paid_msg_seq: u64,
    char_count: u32,
    dedupe_key: vector<u8>,
    nonce: u128,
    clock: &Clock,
    platform_fee_recipient: address,
    ecosystem_fee_recipient: address,
    ctx: &mut TxContext,
) {
    assert!(table::contains(&self.paid_msg_escrow, paid_msg_seq), EPaidNotFound);
    let escrow_ref = table::borrow(&self.paid_msg_escrow, paid_msg_seq);
    assert!(sender == escrow_ref.recipient, EForbidden);
    assert!(!escrow_ref.claimed, EPaymentClaimed);

    let now_ms = clock::timestamp_ms(clock);
    assert!(now_ms - escrow_ref.created_at_ms <= PAYMENT_EXPIRATION_MS, EPaymentExpired);
    assert!(char_count >= MIN_REPLY_CHARS, EReplyTooShort);

    consume_dedupe_and_nonce(self, sender, dedupe_key, nonce, ctx);

    event::emit(PaidMessageReplied {
        group_id: self.group_id,
        paid_msg_seq,
        recipient: sender,
        reply_char_count: char_count,
    });

    let escrow = table::borrow_mut(&mut self.paid_msg_escrow, paid_msg_seq);
    assert!(!escrow.claimed, EPaymentClaimed);
    escrow.claimed = true;

    let primary_recipient = escrow.recipient;
    let total_amount = escrow.amount;

    let coin = coin::from_balance(balance::withdraw_all(&mut escrow.escrowed_balance), ctx);
    assert!(coin::value(&coin) > 0, EVaultEmpty);

    let totals = escrow_fees::distribute_escrow_to_recipients(
        coin,
        platform_fee_recipient,
        ecosystem_fee_recipient,
        primary_recipient,
        ctx,
    );

    event::emit(PaymentClaimedSettled {
        group_id: self.group_id,
        seq: paid_msg_seq,
        recipient: primary_recipient,
        total_amount,
        platform_fee: escrow_fees::platform_fee(&totals),
        treasury_fee: escrow_fees::treasury_fee(&totals),
        net_amount: escrow_fees::net_amount(&totals),
        platform_fee_recipient,
        ecosystem_fee_recipient,
        claimed_at_ms: clock::timestamp_ms(clock),
    });
}

public(package) fun refund_paid_message(
    self: &mut MessageLog,
    sender: address,
    paid_msg_seq: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(table::contains(&self.paid_msg_escrow, paid_msg_seq), EPaidNotFound);
    let escrow = table::borrow_mut(&mut self.paid_msg_escrow, paid_msg_seq);
    assert!(sender == escrow.payer, EForbidden);
    assert!(!escrow.claimed, EPaymentClaimed);

    let now_ms = clock::timestamp_ms(clock);
    assert!(now_ms - escrow.created_at_ms >= PAYMENT_EXPIRATION_MS, EPaymentExpired);

    let refund_amount = escrow.amount;
    let payer = escrow.payer;
    escrow.claimed = true;
    let refund_coin = coin::from_balance(balance::withdraw_all(&mut escrow.escrowed_balance), ctx);

    event::emit(PaymentRefunded {
        group_id: self.group_id,
        seq: paid_msg_seq,
        payer,
        amount: refund_amount,
        refunded_at_ms: now_ms,
    });

    transfer::public_transfer(refund_coin, payer);
}
