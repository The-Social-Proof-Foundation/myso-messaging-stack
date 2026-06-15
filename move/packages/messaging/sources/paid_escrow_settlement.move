/// Fee distribution for claimed paid-message escrow (`MYSO`).
///
/// **BPS** match `social_contracts::message` (`PAID_MSG_PLATFORM_FEE_BPS` / `PAID_MSG_TREASURY_FEE_BPS`).
///
/// Uses `transfer::public_transfer` to fee recipients. Credits to the live `Platform` treasury balance
/// require `social_contracts::platform::add_to_treasury` (same-package); see
/// `ref_social_contract/sources/messaging_paid_fee_bridge.move` for a foundation-side helper.
module messaging::paid_escrow_settlement;

use myso::coin::{Self, Coin};
use myso::myso::MYSO;

/// Must match `social_contracts::message::PAID_MSG_PLATFORM_FEE_BPS`.
const PAID_MSG_PLATFORM_FEE_BPS: u64 = 250;
/// Must match `social_contracts::message::PAID_MSG_TREASURY_FEE_BPS`.
const PAID_MSG_TREASURY_FEE_BPS: u64 = 250;

/// Totals from a settled escrow split (for events and testing).
public struct EscrowFeeTotals has copy, drop, store {
    total_amount: u64,
    platform_fee: u64,
    treasury_fee: u64,
    net_amount: u64,
}

public fun total_amount(t: &EscrowFeeTotals): u64 {
    t.total_amount
}

public fun platform_fee(t: &EscrowFeeTotals): u64 {
    t.platform_fee
}

public fun treasury_fee(t: &EscrowFeeTotals): u64 {
    t.treasury_fee
}

public fun net_amount(t: &EscrowFeeTotals): u64 {
    t.net_amount
}

/// Splits `escrow_coin` per paid-message BPS: platform, ecosystem, then `primary_recipient`.
public fun distribute_escrow_to_recipients(
    mut escrow_coin: Coin<MYSO>,
    platform_fee_recipient: address,
    ecosystem_fee_recipient: address,
    primary_recipient: address,
    ctx: &mut TxContext,
): EscrowFeeTotals {
    let total_amount = coin::value(&escrow_coin);
    let platform_fee = (((total_amount as u128) * (PAID_MSG_PLATFORM_FEE_BPS as u128)) / 10000u128) as u64;
    let treasury_fee = (((total_amount as u128) * (PAID_MSG_TREASURY_FEE_BPS as u128)) / 10000u128) as u64;
    let net_amount = total_amount - platform_fee - treasury_fee;

    if (platform_fee > 0) {
        transfer::public_transfer(coin::split(&mut escrow_coin, platform_fee, ctx), platform_fee_recipient);
    };
    if (treasury_fee > 0) {
        transfer::public_transfer(
            coin::split(&mut escrow_coin, treasury_fee, ctx),
            ecosystem_fee_recipient,
        );
    };
    transfer::public_transfer(escrow_coin, primary_recipient);

    EscrowFeeTotals { total_amount, platform_fee, treasury_fee, net_amount }
}
