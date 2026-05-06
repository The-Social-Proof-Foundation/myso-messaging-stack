/// Module: paid_join_rule
///
/// Example third-party contract demonstrating payment-gated group membership
/// using the `object_*` actor pattern with accumulated funds management.
///
/// ## Pattern Overview
///
/// This pattern enables self-service group joining with payment:
/// 1. Group admin creates a `PaidJoinRule` actor with fee configuration
/// 2. Admin grants the actor's address `ExtensionPermissionsAdmin` permission
/// 3. Users call `join()` to self-serve join by paying the fee
/// 4. Fees accumulate in the rule's `Balance<Token>`
/// 5. Members with `FundsManager` permission can withdraw accumulated funds
///
/// The actor object's UID is passed to `object_grant_permission`, which checks that
/// the actor has `ExtensionPermissionsAdmin` permission before granting `MessagingReader`
/// to the transaction sender (making them a member).
///
/// ## Permissions
///
/// - `FundsManager`: Permission to withdraw accumulated fees from the rule
///
/// ## Usage Flow
///
/// ```move
/// // 1. Admin creates the group
/// let (mut group, encryption_history) = messaging::messaging::create_group(...);
///
/// // 2. Admin creates the paid join rule (generic over token type)
/// let rule = paid_join_rule::new<MYSO>(group_id, 1_000_000_000, ctx); // 1 MYSO fee
/// let rule_address = object::id(&rule).to_address();
///
/// // 3. Admin grants ExtensionPermissionsAdmin to the rule so it can add members
/// group.grant_permission<Messaging, ExtensionPermissionsAdmin>(rule_address, ctx);
///
/// // 4. Admin grants FundsManager permission to themselves or a treasurer
/// group.grant_permission<Messaging, FundsManager>(treasurer, ctx);
///
/// // 5. Share the rule so users can access it
/// transfer::share_object(rule);
///
/// // 6. User self-serves to join (gets MessagingReader permission)
/// paid_join_rule::join<MYSO>(&mut rule, &mut group, &mut payment, ctx);
///
/// // 7. Treasurer withdraws accumulated funds
/// let funds = paid_join_rule::withdraw<MYSO>(&mut rule, &group, amount, ctx);
/// ```
///
module example_app::paid_join_rule;

use myso_groups::permissioned_group::{PermissionedGroup, ExtensionPermissionsAdmin};
use myso_messaging_stack::messaging::{Self, Messaging, MessagingReader, MessagingNamespace};
use myso_messaging_stack::group_manager::GroupManager;
use myso_messaging_stack::version::Version;
use myso::balance::{Self, Balance};
use myso::coin::{Self, Coin};
use myso::vec_set;
use std::string::String;

// === Error Codes ===

const EInsufficientPayment: u64 = 0;
const EInsufficientBalance: u64 = 1;
const EGroupMismatch: u64 = 2;
const ENotPermitted: u64 = 3;

// === Permission Witnesses ===

/// Permission to withdraw accumulated funds from the rule.
/// Must be granted via `group.grant_permission<Messaging, FundsManager>(member, ctx)`.
public struct FundsManager() has drop;

// === Structs ===

/// Actor object that enables paid self-service group joining.
/// Must be granted `ExtensionPermissionsAdmin` permission to add members.
/// Accumulates fees in a `Balance<Token>` that can be withdrawn by `FundsManager`.
public struct PaidJoinRule<phantom Token> has key {
    id: UID,
    /// The group this rule is associated with
    group_id: ID,
    /// Fee in Token's smallest unit required to join
    fee: u64,
    /// Accumulated fees from join payments
    balance: Balance<Token>,
}

// === Public Functions ===

/// Creates a new PaidJoinRule actor.
/// The returned object should be shared after the admin grants it `ExtensionPermissionsAdmin`
/// permission.
///
/// # Type Parameters
/// - `Token`: The coin type accepted for payment (e.g., `MYSO`)
///
/// # Parameters
/// - `group_id`: The ID of the group this rule controls access to
/// - `fee`: Join fee in Token's smallest unit
/// - `ctx`: Transaction context
///
/// # Returns
/// A new `PaidJoinRule<Token>` object.
public fun new<Token: drop>(
    group_id: ID,
    fee: u64,
    ctx: &mut TxContext,
): PaidJoinRule<Token> {
    PaidJoinRule {
        id: object::new(ctx),
        group_id,
        fee,
        balance: balance::zero(),
    }
}

/// Shares the PaidJoinRule object.
/// Call this after creating the rule and obtaining its address for permission setup.
///
/// # Parameters
/// - `rule`: The PaidJoinRule to share
public fun share<Token: drop>(rule: PaidJoinRule<Token>) {
    transfer::share_object(rule);
}

/// Creates a new PaidJoinRule and shares it immediately.
/// Note: Use `new` + `share` separately if you need the rule's address before sharing
/// (e.g., for granting `ExtensionPermissionsAdmin` permission).
entry fun new_and_share<Token: drop>(
    group_id: ID,
    fee: u64,
    ctx: &mut TxContext,
) {
    share(new<Token>(group_id, fee, ctx));
}

/// Creates a messaging group with a PaidJoinRule in a single atomic transaction.
///
/// This handles the full setup:
/// 1. Creates the group via `messaging::create_group`
/// 2. Creates a `PaidJoinRule<Token>` actor with the specified fee
/// 3. Grants `ExtensionPermissionsAdmin` to the rule (so it can add members)
/// 4. Grants `FundsManager` to the caller (so they can withdraw fees)
/// 5. Shares the group, encryption history, and the rule
///
/// # Type Parameters
/// - `Token`: The coin type accepted for payment (e.g., `MYSO`)
///
/// # Parameters
/// - `version`: Reference to the Version shared object
/// - `namespace`: Mutable reference to the MessagingNamespace
/// - `group_manager`: Reference to the shared GroupManager actor
/// - `name`: Human-readable group name
/// - `uuid`: Client-provided UUID for deterministic address derivation
/// - `initial_encrypted_dek`: Initial MyData-encrypted DEK bytes
/// - `fee`: Join fee in Token's smallest unit
/// - `ctx`: Transaction context
#[allow(lint(share_owned))]
entry fun create_token_gated_group<Token: drop>(
    version: &Version,
    namespace: &mut MessagingNamespace,
    group_manager: &GroupManager,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector<u8>,
    fee: u64,
    ctx: &mut TxContext,
) {
    let (mut group, encryption_history) = messaging::create_group(
        version,
        namespace,
        group_manager,
        name,
        uuid,
        initial_encrypted_dek,
        vec_set::empty(),
        ctx,
    );

    // Create rule and get its address before sharing
    let rule = new<Token>(object::id(&group), fee, ctx);
    let rule_address = object::id(&rule).to_address();

    // Grant ExtensionPermissionsAdmin to the rule so it can add members via join()
    group.grant_permission<Messaging, ExtensionPermissionsAdmin>(rule_address, ctx);

    // Grant FundsManager to the caller so they can withdraw accumulated fees
    group.grant_permission<Messaging, FundsManager>(ctx.sender(), ctx);

    transfer::public_share_object(group);
    transfer::public_share_object(encryption_history);
    share(rule);
}

/// Allows the transaction sender to join the group by paying the required fee.
/// The sender is granted `MessagingReader` permission (making them a member).
/// Fees accumulate in the rule's balance for later withdrawal.
///
/// # Type Parameters
/// - `Token`: The coin type for payment
///
/// # Parameters
/// - `rule`: Mutable reference to the PaidJoinRule actor
/// - `group`: Mutable reference to the PermissionedGroup
/// - `payment`: Mutable reference to Coin for payment (fee is deducted in place)
/// - `ctx`: Transaction context
///
/// # Aborts
/// - `EInsufficientPayment`: if payment is less than the required fee
/// - `EGroupMismatch`: if group doesn't match rule's group_id
/// - `ENotPermitted` (from `permissions_group`): if rule doesn't have `ExtensionPermissionsAdmin`
/// permission
public fun join<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &mut PermissionedGroup<Messaging>,
    payment: &mut Coin<Token>,
    ctx: &TxContext,
) {
    assert!(payment.value() >= rule.fee, EInsufficientPayment);
    assert!(object::id(group) == rule.group_id, EGroupMismatch);

    // Split exact fee from payment and add to balance
    let fee_balance = payment.balance_mut().split(rule.fee);
    rule.balance.join(fee_balance);

    // Grant MessagingReader permission to sender via the actor object
    group.object_grant_permission<Messaging, MessagingReader>(&rule.id, ctx.sender());
}

/// Entry version of `join` for CLI usage.
entry fun join_entry<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &mut PermissionedGroup<Messaging>,
    payment: &mut Coin<Token>,
    ctx: &TxContext,
) {
    join(rule, group, payment, ctx);
}

/// Withdraws accumulated funds from the rule.
/// Only callable by members with `FundsManager` permission on the group.
///
/// # Type Parameters
/// - `Token`: The coin type to withdraw
///
/// # Parameters
/// - `rule`: Mutable reference to the PaidJoinRule
/// - `group`: Reference to the PermissionedGroup (for permission check)
/// - `amount`: Amount to withdraw in Token's smallest unit
/// - `ctx`: Transaction context
///
/// # Returns
/// A `Coin<Token>` containing the withdrawn amount.
///
/// # Aborts
/// - `EGroupMismatch`: if group doesn't match rule's group_id
/// - `ENotPermitted`: if caller doesn't have `FundsManager` permission
/// - `EInsufficientBalance`: if rule balance is less than requested amount
public fun withdraw<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &PermissionedGroup<Messaging>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Token> {
    assert!(object::id(group) == rule.group_id, EGroupMismatch);
    assert!(group.has_permission<Messaging, FundsManager>(ctx.sender()), ENotPermitted);
    assert!(rule.balance.value() >= amount, EInsufficientBalance);

    coin::from_balance(rule.balance.split(amount), ctx)
}

/// Entry version of `withdraw` that transfers directly to sender.
entry fun withdraw_entry<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &PermissionedGroup<Messaging>,
    amount: u64,
    ctx: &mut TxContext,
) {
    let coin = withdraw(rule, group, amount, ctx);
    transfer::public_transfer(coin, ctx.sender());
}

/// Withdraws all accumulated funds from the rule.
/// Only callable by members with `FundsManager` permission on the group.
///
/// # Type Parameters
/// - `Token`: The coin type to withdraw
///
/// # Parameters
/// - `rule`: Mutable reference to the PaidJoinRule
/// - `group`: Reference to the PermissionedGroup (for permission check)
/// - `ctx`: Transaction context
///
/// # Returns
/// A `Coin<Token>` containing all accumulated funds.
///
/// # Aborts
/// - `EGroupMismatch`: if group doesn't match rule's group_id
/// - `ENotPermitted`: if caller doesn't have `FundsManager` permission
public fun withdraw_all<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &PermissionedGroup<Messaging>,
    ctx: &mut TxContext,
): Coin<Token> {
    let amount = rule.balance.value();
    withdraw(rule, group, amount, ctx)
}

/// Entry version of `withdraw_all` that transfers directly to sender.
entry fun withdraw_all_entry<Token: drop>(
    rule: &mut PaidJoinRule<Token>,
    group: &PermissionedGroup<Messaging>,
    ctx: &mut TxContext,
) {
    let coin = withdraw_all(rule, group, ctx);
    transfer::public_transfer(coin, ctx.sender());
}

// === Getters ===

/// Returns the join fee.
public fun fee<Token: drop>(rule: &PaidJoinRule<Token>): u64 {
    rule.fee
}

/// Returns the group ID this rule is associated with.
public fun group_id<Token: drop>(rule: &PaidJoinRule<Token>): ID {
    rule.group_id
}

/// Returns the current accumulated balance.
public fun balance_value<Token: drop>(rule: &PaidJoinRule<Token>): u64 {
    rule.balance.value()
}

