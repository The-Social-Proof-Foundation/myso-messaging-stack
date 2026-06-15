/// Module: custom_mydata_policy
///
/// Example third-party app contract demonstrating subscription-based access control
/// for encrypted messaging content using a custom mydata_approve function.
///
/// ## Pattern Overview
///
/// This pattern implements subscription-based access to encrypted content:
/// - A service owner creates a Service linked to a MessagingGroup
/// - Users purchase time-limited Subscriptions by paying MYSO
/// - The custom mydata_approve validates subscription ownership and expiry
///
/// ## Key Design Points
///
/// 1. **No wrapper needed**: This pattern doesn't wrap MessagingGroup. Instead, it:
///    - References the MessagingGroup by ID (stored in Service)
///    - Uses its own packageId for MyData encryption
///
/// 2. **Standard identity bytes**: Identity bytes are always the standard format
///    `[groupId (32 bytes)][keyVersion (8 bytes LE u64)]`, enforced by the SDK.
///    Custom `mydata_approve` validates these standard bytes via
///    `messaging::mydata_policies::validate_identity()`.
///
/// 3. **TS-SDK integration**: The SDK only needs to know:
///    - This package ID (for mydata_approve calls)
///    - The Service and Subscription object IDs (passed as `TApproveContext`)
///
/// ## Usage Flow
///
/// 1. Create MessagingGroup using `messaging::messaging::create_group()`
/// 2. Create Service via `create_service(group_id, fee, ttl)`
/// 3. Users subscribe via `subscribe(service, payment, clock)`
/// 4. Encrypt content using this package's ID with standard identity bytes
/// 5. `mydata_approve` validates identity + subscription before decryption
///
module example_app::custom_mydata_policy;

use myso_groups::permissioned_group::PermissionedGroup;
use messaging::messaging::Messaging;
use messaging::encryption_history::EncryptionHistory;
use myso::clock::Clock;
use myso::coin::Coin;

// === Error Codes ===

const EInvalidFee: u64 = 0;
const ENoAccess: u64 = 1;

// === Structs ===

/// A subscription service that gates access to a MessagingGroup's encrypted content.
/// The service can be shared so anyone can subscribe.
public struct Service<phantom Token> has key {
    id: UID,
    /// The MessagingGroup this service is associated with (for reference only)
    group_id: ID,
    /// Subscription fee in the Token's smallest unit
    fee: u64,
    /// Time-to-live for subscriptions in milliseconds
    ttl: u64,
    /// Address that receives subscription payments
    owner: address,
}

/// A time-limited subscription to a Service.
/// Only has `key` (no `store`) so it can only be transferred, not wrapped.
public struct Subscription<phantom Token> has key {
    id: UID,
    /// The service this subscription belongs to
    service_id: ID,
    /// Timestamp (ms) when the subscription was created
    created_at: u64,
}

// === Service Management ===

/// Creates a new subscription service for a MessagingGroup.
///
/// # Parameters
/// - `group_id`: The ID of the MessagingGroup this service controls access to
/// - `fee`: Subscription fee in MIST
/// - `ttl`: Subscription duration in milliseconds
/// - `ctx`: Transaction context
///
/// # Returns
/// - A new Service object (should be shared for public access)
public fun create_service<Token: drop>(
    group_id: ID,
    fee: u64,
    ttl: u64,
    ctx: &mut TxContext,
): Service<Token> {
    Service<Token> {
        id: object::new(ctx),
        group_id,
        fee,
        ttl,
        owner: ctx.sender(),
    }
}

/// Creates and shares a new subscription service.
/// Convenience entry function for simpler CLI usage.
entry fun create_service_and_share<Token: drop>(
    group_id: ID,
    fee: u64,
    ttl: u64,
    ctx: &mut TxContext,
) {
    transfer::share_object(create_service<Token>(group_id, fee, ttl, ctx));
}

// === Subscription Management ===

/// Purchases a subscription to the service.
/// The subscription is valid for `service.ttl` milliseconds from creation.
///
/// # Parameters
/// - `service`: Reference to the Service
/// - `payment`: MYSO coin for payment (must equal service.fee)
/// - `clock`: Clock for timestamp
/// - `ctx`: Transaction context
///
/// # Returns
/// - A new Subscription object
///
/// # Aborts
/// - `EInvalidFee`: if payment amount doesn't match service fee
public fun subscribe<Token: drop>(
    service: &Service<Token>,
    payment: Coin<Token>,
    clock: &Clock,
    ctx: &mut TxContext,
): Subscription<Token> {
    assert!(payment.value() == service.fee, EInvalidFee);

    // Transfer payment to service owner
    transfer::public_transfer(payment, service.owner);

    Subscription<Token> {
        id: object::new(ctx),
        service_id: object::id(service),
        created_at: clock.timestamp_ms(),
    }
}

/// Purchases a subscription and transfers it to the sender.
/// Convenience entry function for simpler CLI usage.
entry fun subscribe_entry<Token: drop>(
    service: &Service<Token>,
    payment: Coin<Token>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sub = subscribe<Token>(service, payment, clock, ctx);
    transfer::transfer(sub, ctx.sender());
}

/// Transfers a subscription to another address.
/// This allows gifting or selling subscriptions.
public fun transfer_subscription<Token: drop>(sub: Subscription<Token>, to: address) {
    transfer::transfer(sub, to);
}

// === Getters ===

/// Returns the fee for this service.
public fun fee<Token: drop>(service: &Service<Token>): u64 {
    service.fee
}

/// Returns the TTL for this service.
public fun ttl<Token: drop>(service: &Service<Token>): u64 {
    service.ttl
}

/// Returns the MessagingGroup ID this service is associated with.
public fun group_id<Token: drop>(service: &Service<Token>): ID {
    service.group_id
}

/// Returns the service ID this subscription belongs to.
public fun subscription_service_id<Token: drop>(sub: &Subscription<Token>): ID {
    sub.service_id
}

/// Returns when this subscription was created.
public fun created_at<Token: drop>(sub: &Subscription<Token>): u64 {
    sub.created_at
}

/// Checks if a subscription is still valid (not expired).
public fun is_subscription_valid<Token: drop>(
    sub: &Subscription<Token>,
    service: &Service<Token>,
    clock: &Clock,
): bool {
    if (object::id(service) != sub.service_id) {
        return false
    };
    clock.timestamp_ms() <= sub.created_at + service.ttl
}

// === MyData Approve ===

/// Checks subscription-specific conditions for mydata approval.
///
/// # Parameters
/// - `sub`: Reference to the user's Subscription
/// - `service`: Reference to the Service
/// - `group`: Reference to the PermissionedGroup<Messaging>
/// - `clock`: Clock for expiry validation
/// - `ctx`: Transaction context for sender verification
///
/// # Returns
/// `true` if all conditions pass (group matches, caller is member,
/// subscription belongs to service, not expired), `false` otherwise.
fun check_policy<Token: drop>(
    sub: &Subscription<Token>,
    service: &Service<Token>,
    group: &PermissionedGroup<Messaging>,
    clock: &Clock,
    ctx: &TxContext,
): bool {
    // Check if group matches the service's group_id
    if (object::id(group) != service.group_id) {
        return false
    };

    // Check if caller is a member of the group
    if (!group.is_member(ctx.sender())) {
        return false
    };

    // Check if subscription belongs to this service
    if (object::id(service) != sub.service_id) {
        return false
    };

    // Check if subscription has expired
    if (clock.timestamp_ms() > sub.created_at + service.ttl) {
        return false
    };

    true
}

/// Custom mydata_approve for subscription-based access.
/// Called by MyData key servers (via dry-run) to authorize decryption.
///
/// Identity bytes use the standard format `[groupId (32)][keyVersion (8 LE u64)]`,
/// validated by `messaging::mydata_policies::validate_identity()`.
///
/// # Parameters
/// - `id`: MyData identity bytes `[group_id (32 bytes)][key_version (8 bytes LE u64)]`
/// - `sub`: The user's Subscription object
/// - `service`: The Service being accessed
/// - `group`: The MessagingGroup (must match service.group_id)
/// - `encryption_history`: The EncryptionHistory (must belong to group)
/// - `clock`: Clock for expiry validation
/// - `ctx`: Transaction context for sender verification
///
/// # Aborts
/// - `ENoAccess`: if subscription-specific checks fail
/// - via `validate_identity`: if identity bytes are malformed, group_id mismatch,
///   encryption_history mismatch, or key_version doesn't exist
entry fun mydata_approve<Token: drop>(
    id: vector<u8>,
    sub: &Subscription<Token>,
    service: &Service<Token>,
    group: &PermissionedGroup<Messaging>,
    encryption_history: &EncryptionHistory,
    clock: &Clock,
    ctx: &TxContext,
) {
    // Reuse standard identity validation (groupId, keyVersion, encHistory match)
    messaging::mydata_policies::validate_identity(group, encryption_history, id);

    // Custom checks: subscription + service + membership
    assert!(check_policy(sub, service, group, clock, ctx), ENoAccess);
}

// === Tests ===
// Tests moved to tests/custom_mydata_policy_tests.move
