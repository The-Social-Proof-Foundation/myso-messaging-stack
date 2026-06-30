/// Per-wallet paid DM policy for the messaging package.
///
/// Stored separately from social profiles: keyed by wallet address, sparse table
/// (only wallets that opt in have a row).
module messaging::paid_messaging_policy;

use myso::derived_object;
use myso::event;
use myso::table::{Self, Table};

// === Error codes ===

const EInvalidPolicy: u64 = 0;

// === Derivation ===

const PAID_MESSAGING_REGISTRY_DERIVATION_KEY: vector<u8> = b"paid_messaging_registry";

// === Storage ===

public struct PaidMessagingPolicy has store, copy, drop {
    enabled: bool,
    min_cost: Option<u64>,
}

public struct PaidMessagingRegistry has key {
    id: UID,
    policies: Table<address, PaidMessagingPolicy>,
}

// === Events ===

public struct PaidMessagingPolicyUpdated has copy, drop {
    wallet: address,
    enabled: bool,
    min_cost: Option<u64>,
}

// === Lifecycle ===

public(package) fun new(namespace_uid: &mut UID, ctx: &mut TxContext): PaidMessagingRegistry {
    PaidMessagingRegistry {
        id: derived_object::claim(
            namespace_uid,
            PAID_MESSAGING_REGISTRY_DERIVATION_KEY.to_string(),
        ),
        policies: table::new(ctx),
    }
}

public(package) fun share(self: PaidMessagingRegistry) {
    transfer::share_object(self);
}

// === Owner API ===

/// Sets paid DM policy for the transaction sender's wallet.
///
/// When `enabled` is true, `min_cost` must be set (enforced on stranger 1:1 paid opens).
#[allow(lint(public_entry))]
public entry fun set_paid_messaging_policy(
    registry: &mut PaidMessagingRegistry,
    enabled: bool,
    min_cost: Option<u64>,
    ctx: &TxContext,
) {
    let wallet = ctx.sender();
    if (enabled) {
        assert!(option::is_some(&min_cost), EInvalidPolicy);
    };
    let policy = PaidMessagingPolicy { enabled, min_cost };
    if (table::contains(&registry.policies, wallet)) {
        *table::borrow_mut(&mut registry.policies, wallet) = policy;
    } else {
        table::add(&mut registry.policies, wallet, policy);
    };
    event::emit(PaidMessagingPolicyUpdated { wallet, enabled, min_cost });
}

// === Read API ===

/// Returns `Some(min_cost)` when the recipient requires paid stranger DMs.
public fun requires_payment_from(
    registry: &PaidMessagingRegistry,
    recipient: address,
): Option<u64> {
    if (!table::contains(&registry.policies, recipient)) {
        return option::none()
    };
    let policy = table::borrow(&registry.policies, recipient);
    if (policy.enabled && option::is_some(&policy.min_cost)) {
        policy.min_cost
    } else {
        option::none()
    }
}
