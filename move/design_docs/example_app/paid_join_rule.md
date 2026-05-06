
<a name="example_app_paid_join_rule"></a>

# Module `example_app::paid_join_rule`

Module: paid_join_rule

Example third-party contract demonstrating payment-gated group membership
using the <code>object_*</code> actor pattern with accumulated funds management.


<a name="@Pattern_Overview_0"></a>

### Pattern Overview


This pattern enables self-service group joining with payment:
1. Group admin creates a <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a></code> actor with fee configuration
2. Admin grants the actor's address <code>ExtensionPermissionsAdmin</code> permission
3. Users call <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join">join</a>()</code> to self-serve join by paying the fee
4. Fees accumulate in the rule's <code>Balance&lt;Token&gt;</code>
5. Members with <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a></code> permission can withdraw accumulated funds

The actor object's UID is passed to <code>object_grant_permission</code>, which checks that
the actor has <code>ExtensionPermissionsAdmin</code> permission before granting <code>MessagingReader</code>
to the transaction sender (making them a member).


<a name="@Permissions_1"></a>

### Permissions


- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a></code>: Permission to withdraw accumulated fees from the rule


<a name="@Usage_Flow_2"></a>

### Usage Flow


```move
// 1. Admin creates the group
let (mut group, encryption_history) = messaging::messaging::create_group(...);

// 2. Admin creates the paid join rule (generic over token type)
let rule = paid_join_rule::new<MYSO>(group_id, 1_000_000_000, ctx); // 1 MYSO fee
let rule_address = object::id(&rule).to_address();

// 3. Admin grants ExtensionPermissionsAdmin to the rule so it can add members
group.grant_permission<Messaging, ExtensionPermissionsAdmin>(rule_address, ctx);

// 4. Admin grants FundsManager permission to themselves or a treasurer
group.grant_permission<Messaging, FundsManager>(treasurer, ctx);

// 5. Share the rule so users can access it
transfer::share_object(rule);

// 6. User self-serves to join (gets MessagingReader permission)
paid_join_rule::join<MYSO>(&mut rule, &mut group, &mut payment, ctx);

// 7. Treasurer withdraws accumulated funds
let funds = paid_join_rule::withdraw<MYSO>(&mut rule, &group, amount, ctx);
```


    -  [Pattern Overview](#@Pattern_Overview_0)
    -  [Permissions](#@Permissions_1)
    -  [Usage Flow](#@Usage_Flow_2)
-  [Struct `FundsManager`](#example_app_paid_join_rule_FundsManager)
-  [Struct `PaidJoinRule`](#example_app_paid_join_rule_PaidJoinRule)
-  [Constants](#@Constants_3)
-  [Function `new`](#example_app_paid_join_rule_new)
    -  [Type Parameters](#@Type_Parameters_4)
    -  [Parameters](#@Parameters_5)
    -  [Returns](#@Returns_6)
-  [Function `share`](#example_app_paid_join_rule_share)
    -  [Parameters](#@Parameters_7)
-  [Function `new_and_share`](#example_app_paid_join_rule_new_and_share)
-  [Function `join`](#example_app_paid_join_rule_join)
    -  [Type Parameters](#@Type_Parameters_8)
    -  [Parameters](#@Parameters_9)
    -  [Aborts](#@Aborts_10)
-  [Function `join_entry`](#example_app_paid_join_rule_join_entry)
-  [Function `withdraw`](#example_app_paid_join_rule_withdraw)
    -  [Type Parameters](#@Type_Parameters_11)
    -  [Parameters](#@Parameters_12)
    -  [Returns](#@Returns_13)
    -  [Aborts](#@Aborts_14)
-  [Function `withdraw_entry`](#example_app_paid_join_rule_withdraw_entry)
-  [Function `withdraw_all`](#example_app_paid_join_rule_withdraw_all)
    -  [Type Parameters](#@Type_Parameters_15)
    -  [Parameters](#@Parameters_16)
    -  [Returns](#@Returns_17)
    -  [Aborts](#@Aborts_18)
-  [Function `withdraw_all_entry`](#example_app_paid_join_rule_withdraw_all_entry)
-  [Function `fee`](#example_app_paid_join_rule_fee)
-  [Function `group_id`](#example_app_paid_join_rule_group_id)
-  [Function `balance_value`](#example_app_paid_join_rule_balance_value)


<pre><code><b>use</b> <a href="../dependencies/messaging/encryption_history.md#messaging_encryption_history">messaging::encryption_history</a>;
<b>use</b> <a href="../dependencies/messaging/group_leaver.md#messaging_group_leaver">messaging::group_leaver</a>;
<b>use</b> <a href="../dependencies/messaging/group_manager.md#messaging_group_manager">messaging::group_manager</a>;
<b>use</b> <a href="../dependencies/messaging/messaging.md#messaging_messaging">messaging::messaging</a>;
<b>use</b> <a href="../dependencies/messaging/metadata.md#messaging_metadata">messaging::metadata</a>;
<b>use</b> <a href="../dependencies/messaging/version.md#messaging_version">messaging::version</a>;
<b>use</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group">permissioned_groups::permissioned_group</a>;
<b>use</b> <a href="../dependencies/permissioned_groups/permissions_table.md#permissioned_groups_permissions_table">permissioned_groups::permissions_table</a>;
<b>use</b> <a href="../dependencies/permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap">permissioned_groups::unpause_cap</a>;
<b>use</b> <a href="../dependencies/std/address.md#std_address">std::address</a>;
<b>use</b> <a href="../dependencies/std/ascii.md#std_ascii">std::ascii</a>;
<b>use</b> <a href="../dependencies/std/bcs.md#std_bcs">std::bcs</a>;
<b>use</b> <a href="../dependencies/std/internal.md#std_internal">std::internal</a>;
<b>use</b> <a href="../dependencies/std/option.md#std_option">std::option</a>;
<b>use</b> <a href="../dependencies/std/string.md#std_string">std::string</a>;
<b>use</b> <a href="../dependencies/std/type_name.md#std_type_name">std::type_name</a>;
<b>use</b> <a href="../dependencies/std/u128.md#std_u128">std::u128</a>;
<b>use</b> <a href="../dependencies/std/vector.md#std_vector">std::vector</a>;
<b>use</b> <a href="../dependencies/myso/accumulator.md#myso_accumulator">myso::accumulator</a>;
<b>use</b> <a href="../dependencies/myso/accumulator_settlement.md#myso_accumulator_settlement">myso::accumulator_settlement</a>;
<b>use</b> <a href="../dependencies/myso/address.md#myso_address">myso::address</a>;
<b>use</b> <a href="../dependencies/myso/bag.md#myso_bag">myso::bag</a>;
<b>use</b> <a href="../dependencies/myso/balance.md#myso_balance">myso::balance</a>;
<b>use</b> <a href="../dependencies/myso/bcs.md#myso_bcs">myso::bcs</a>;
<b>use</b> <a href="../dependencies/myso/clock.md#myso_clock">myso::clock</a>;
<b>use</b> <a href="../dependencies/myso/coin.md#myso_coin">myso::coin</a>;
<b>use</b> <a href="../dependencies/myso/config.md#myso_config">myso::config</a>;
<b>use</b> <a href="../dependencies/myso/deny_list.md#myso_deny_list">myso::deny_list</a>;
<b>use</b> <a href="../dependencies/myso/derived_object.md#myso_derived_object">myso::derived_object</a>;
<b>use</b> <a href="../dependencies/myso/dynamic_field.md#myso_dynamic_field">myso::dynamic_field</a>;
<b>use</b> <a href="../dependencies/myso/dynamic_object_field.md#myso_dynamic_object_field">myso::dynamic_object_field</a>;
<b>use</b> <a href="../dependencies/myso/event.md#myso_event">myso::event</a>;
<b>use</b> <a href="../dependencies/myso/funds_accumulator.md#myso_funds_accumulator">myso::funds_accumulator</a>;
<b>use</b> <a href="../dependencies/myso/hash.md#myso_hash">myso::hash</a>;
<b>use</b> <a href="../dependencies/myso/hex.md#myso_hex">myso::hex</a>;
<b>use</b> <a href="../dependencies/myso/object.md#myso_object">myso::object</a>;
<b>use</b> <a href="../dependencies/myso/package.md#myso_package">myso::package</a>;
<b>use</b> <a href="../dependencies/myso/party.md#myso_party">myso::party</a>;
<b>use</b> <a href="../dependencies/myso/protocol_config.md#myso_protocol_config">myso::protocol_config</a>;
<b>use</b> <a href="../dependencies/myso/myso.md#myso_myso">myso::myso</a>;
<b>use</b> <a href="../dependencies/myso/table.md#myso_table">myso::table</a>;
<b>use</b> <a href="../dependencies/myso/table_vec.md#myso_table_vec">myso::table_vec</a>;
<b>use</b> <a href="../dependencies/myso/transfer.md#myso_transfer">myso::transfer</a>;
<b>use</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context">myso::tx_context</a>;
<b>use</b> <a href="../dependencies/myso/types.md#myso_types">myso::types</a>;
<b>use</b> <a href="../dependencies/myso/url.md#myso_url">myso::url</a>;
<b>use</b> <a href="../dependencies/myso/vec_map.md#myso_vec_map">myso::vec_map</a>;
<b>use</b> <a href="../dependencies/myso/vec_set.md#myso_vec_set">myso::vec_set</a>;
<b>use</b> <a href="../dependencies/mysons/constants.md#mysons_constants">mysons::constants</a>;
<b>use</b> <a href="../dependencies/mysons/controller.md#mysons_controller">mysons::controller</a>;
<b>use</b> <a href="../dependencies/mysons/domain.md#mysons_domain">mysons::domain</a>;
<b>use</b> <a href="../dependencies/mysons/name_record.md#mysons_name_record">mysons::name_record</a>;
<b>use</b> <a href="../dependencies/mysons/registry.md#mysons_registry">mysons::registry</a>;
<b>use</b> <a href="../dependencies/mysons/subdomain_registration.md#mysons_subdomain_registration">mysons::subdomain_registration</a>;
<b>use</b> <a href="../dependencies/mysons/mysons.md#mysons_mysons">mysons::mysons</a>;
<b>use</b> <a href="../dependencies/mysons/mysons_registration.md#mysons_mysons_registration">mysons::mysons_registration</a>;
</code></pre>



<a name="example_app_paid_join_rule_FundsManager"></a>

## Struct `FundsManager`

Permission to withdraw accumulated funds from the rule.
Must be granted via <code>group.grant_permission&lt;Messaging, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a>&gt;(member, ctx)</code>.


<pre><code><b>public</b> <b>struct</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="example_app_paid_join_rule_PaidJoinRule"></a>

## Struct `PaidJoinRule`

Actor object that enables paid self-service group joining.
Must be granted <code>ExtensionPermissionsAdmin</code> permission to add members.
Accumulates fees in a <code>Balance&lt;Token&gt;</code> that can be withdrawn by <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a></code>.


<pre><code><b>public</b> <b>struct</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;<b>phantom</b> Token&gt; <b>has</b> key
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code>id: <a href="../dependencies/myso/object.md#myso_object_UID">myso::object::UID</a></code>
</dt>
<dd>
</dd>
<dt>
<code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a></code>
</dt>
<dd>
 The group this rule is associated with
</dd>
<dt>
<code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>: u64</code>
</dt>
<dd>
 Fee in Token's smallest unit required to join
</dd>
<dt>
<code>balance: <a href="../dependencies/myso/balance.md#myso_balance_Balance">myso::balance::Balance</a>&lt;Token&gt;</code>
</dt>
<dd>
 Accumulated fees from join payments
</dd>
</dl>


</details>

<a name="@Constants_3"></a>

## Constants


<a name="example_app_paid_join_rule_EInsufficientPayment"></a>



<pre><code><b>const</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EInsufficientPayment">EInsufficientPayment</a>: u64 = 0;
</code></pre>



<a name="example_app_paid_join_rule_EInsufficientBalance"></a>



<pre><code><b>const</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EInsufficientBalance">EInsufficientBalance</a>: u64 = 1;
</code></pre>



<a name="example_app_paid_join_rule_EGroupMismatch"></a>



<pre><code><b>const</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EGroupMismatch">EGroupMismatch</a>: u64 = 2;
</code></pre>



<a name="example_app_paid_join_rule_ENotPermitted"></a>



<pre><code><b>const</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_ENotPermitted">ENotPermitted</a>: u64 = 3;
</code></pre>



<a name="example_app_paid_join_rule_new"></a>

## Function `new`

Creates a new PaidJoinRule actor.
The returned object should be shared after the admin grants it <code>ExtensionPermissionsAdmin</code>
permission.


<a name="@Type_Parameters_4"></a>

### Type Parameters

- <code>Token</code>: The coin type accepted for payment (e.g., <code>MYSO</code>)


<a name="@Parameters_5"></a>

### Parameters

- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a></code>: The ID of the group this rule controls access to
- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a></code>: Join fee in Token's smallest unit
- <code>ctx</code>: Transaction context


<a name="@Returns_6"></a>

### Returns

A new <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;</code> object.


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_new">new</a>&lt;Token: drop&gt;(<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a>, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>: u64, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>): <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_new">new</a>&lt;Token: drop&gt;(
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>: ID,
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>: u64,
    ctx: &<b>mut</b> TxContext,
): <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt; {
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a> {
        id: object::new(ctx),
        <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>,
        <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>,
        balance: balance::zero(),
    }
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_share"></a>

## Function `share`

Shares the PaidJoinRule object.
Call this after creating the rule and obtaining its address for permission setup.


<a name="@Parameters_7"></a>

### Parameters

- <code>rule</code>: The PaidJoinRule to share


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_share">share</a>&lt;Token: drop&gt;(rule: <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_share">share</a>&lt;Token: drop&gt;(rule: <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;) {
    transfer::share_object(rule);
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_new_and_share"></a>

## Function `new_and_share`

Creates a new PaidJoinRule and shares it immediately.
Note: Use <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_new">new</a></code> + <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_share">share</a></code> separately if you need the rule's address before sharing
(e.g., for granting <code>ExtensionPermissionsAdmin</code> permission).


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_new_and_share">new_and_share</a>&lt;Token: drop&gt;(<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a>, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>: u64, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_new_and_share">new_and_share</a>&lt;Token: drop&gt;(
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>: ID,
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>: u64,
    ctx: &<b>mut</b> TxContext,
) {
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_share">share</a>(<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_new">new</a>&lt;Token&gt;(<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>, ctx));
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_join"></a>

## Function `join`

Allows the transaction sender to join the group by paying the required fee.
The sender is granted <code>MessagingReader</code> permission (making them a member).
Fees accumulate in the rule's balance for later withdrawal.


<a name="@Type_Parameters_8"></a>

### Type Parameters

- <code>Token</code>: The coin type for payment


<a name="@Parameters_9"></a>

### Parameters

- <code>rule</code>: Mutable reference to the PaidJoinRule actor
- <code>group</code>: Mutable reference to the PermissionedGroup
- <code>payment</code>: Mutable reference to Coin for payment (fee is deducted in place)
- <code>ctx</code>: Transaction context


<a name="@Aborts_10"></a>

### Aborts

- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EInsufficientPayment">EInsufficientPayment</a></code>: if payment is less than the required fee
- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EGroupMismatch">EGroupMismatch</a></code>: if group doesn't match rule's group_id
- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_ENotPermitted">ENotPermitted</a></code> (from <code>permissions_group</code>): if rule doesn't have <code>ExtensionPermissionsAdmin</code>
permission


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join">join</a>&lt;Token: drop&gt;(rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../dependencies/messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, payment: &<b>mut</b> <a href="../dependencies/myso/coin.md#myso_coin_Coin">myso::coin::Coin</a>&lt;Token&gt;, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join">join</a>&lt;Token: drop&gt;(
    rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;,
    group: &<b>mut</b> PermissionedGroup&lt;Messaging&gt;,
    payment: &<b>mut</b> Coin&lt;Token&gt;,
    ctx: &TxContext,
) {
    <b>assert</b>!(payment.value() &gt;= rule.<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EInsufficientPayment">EInsufficientPayment</a>);
    <b>assert</b>!(object::id(group) == rule.<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EGroupMismatch">EGroupMismatch</a>);
    // Split exact <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a> from payment and add to balance
    <b>let</b> fee_balance = payment.balance_mut().split(rule.<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>);
    rule.balance.<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join">join</a>(fee_balance);
    // Grant MessagingReader permission to sender via the actor object
    group.object_grant_permission&lt;Messaging, MessagingReader&gt;(&rule.id, ctx.sender());
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_join_entry"></a>

## Function `join_entry`

Entry version of <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join">join</a></code> for CLI usage.


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join_entry">join_entry</a>&lt;Token: drop&gt;(rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../dependencies/messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, payment: &<b>mut</b> <a href="../dependencies/myso/coin.md#myso_coin_Coin">myso::coin::Coin</a>&lt;Token&gt;, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join_entry">join_entry</a>&lt;Token: drop&gt;(
    rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;,
    group: &<b>mut</b> PermissionedGroup&lt;Messaging&gt;,
    payment: &<b>mut</b> Coin&lt;Token&gt;,
    ctx: &TxContext,
) {
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_join">join</a>(rule, group, payment, ctx);
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_withdraw"></a>

## Function `withdraw`

Withdraws accumulated funds from the rule.
Only callable by members with <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a></code> permission on the group.


<a name="@Type_Parameters_11"></a>

### Type Parameters

- <code>Token</code>: The coin type to withdraw


<a name="@Parameters_12"></a>

### Parameters

- <code>rule</code>: Mutable reference to the PaidJoinRule
- <code>group</code>: Reference to the PermissionedGroup (for permission check)
- <code>amount</code>: Amount to withdraw in Token's smallest unit
- <code>ctx</code>: Transaction context


<a name="@Returns_13"></a>

### Returns

A <code>Coin&lt;Token&gt;</code> containing the withdrawn amount.


<a name="@Aborts_14"></a>

### Aborts

- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EGroupMismatch">EGroupMismatch</a></code>: if group doesn't match rule's group_id
- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a></code> permission
- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EInsufficientBalance">EInsufficientBalance</a></code>: if rule balance is less than requested amount


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw">withdraw</a>&lt;Token: drop&gt;(rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;, group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../dependencies/messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, amount: u64, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>): <a href="../dependencies/myso/coin.md#myso_coin_Coin">myso::coin::Coin</a>&lt;Token&gt;
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw">withdraw</a>&lt;Token: drop&gt;(
    rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;,
    group: &PermissionedGroup&lt;Messaging&gt;,
    amount: u64,
    ctx: &<b>mut</b> TxContext,
): Coin&lt;Token&gt; {
    <b>assert</b>!(object::id(group) == rule.<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EGroupMismatch">EGroupMismatch</a>);
    <b>assert</b>!(group.has_permission&lt;Messaging, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a>&gt;(ctx.sender()), <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_ENotPermitted">ENotPermitted</a>);
    <b>assert</b>!(rule.balance.value() &gt;= amount, <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EInsufficientBalance">EInsufficientBalance</a>);
    coin::from_balance(rule.balance.split(amount), ctx)
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_withdraw_entry"></a>

## Function `withdraw_entry`

Entry version of <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw">withdraw</a></code> that transfers directly to sender.


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_entry">withdraw_entry</a>&lt;Token: drop&gt;(rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;, group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../dependencies/messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, amount: u64, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_entry">withdraw_entry</a>&lt;Token: drop&gt;(
    rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;,
    group: &PermissionedGroup&lt;Messaging&gt;,
    amount: u64,
    ctx: &<b>mut</b> TxContext,
) {
    <b>let</b> coin = <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw">withdraw</a>(rule, group, amount, ctx);
    transfer::public_transfer(coin, ctx.sender());
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_withdraw_all"></a>

## Function `withdraw_all`

Withdraws all accumulated funds from the rule.
Only callable by members with <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a></code> permission on the group.


<a name="@Type_Parameters_15"></a>

### Type Parameters

- <code>Token</code>: The coin type to withdraw


<a name="@Parameters_16"></a>

### Parameters

- <code>rule</code>: Mutable reference to the PaidJoinRule
- <code>group</code>: Reference to the PermissionedGroup (for permission check)
- <code>ctx</code>: Transaction context


<a name="@Returns_17"></a>

### Returns

A <code>Coin&lt;Token&gt;</code> containing all accumulated funds.


<a name="@Aborts_18"></a>

### Aborts

- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_EGroupMismatch">EGroupMismatch</a></code>: if group doesn't match rule's group_id
- <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_FundsManager">FundsManager</a></code> permission


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_all">withdraw_all</a>&lt;Token: drop&gt;(rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;, group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../dependencies/messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>): <a href="../dependencies/myso/coin.md#myso_coin_Coin">myso::coin::Coin</a>&lt;Token&gt;
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_all">withdraw_all</a>&lt;Token: drop&gt;(
    rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;,
    group: &PermissionedGroup&lt;Messaging&gt;,
    ctx: &<b>mut</b> TxContext,
): Coin&lt;Token&gt; {
    <b>let</b> amount = rule.balance.value();
    <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw">withdraw</a>(rule, group, amount, ctx)
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_withdraw_all_entry"></a>

## Function `withdraw_all_entry`

Entry version of <code><a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_all">withdraw_all</a></code> that transfers directly to sender.


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_all_entry">withdraw_all_entry</a>&lt;Token: drop&gt;(rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;, group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../dependencies/messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>entry</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_all_entry">withdraw_all_entry</a>&lt;Token: drop&gt;(
    rule: &<b>mut</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;,
    group: &PermissionedGroup&lt;Messaging&gt;,
    ctx: &<b>mut</b> TxContext,
) {
    <b>let</b> coin = <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_withdraw_all">withdraw_all</a>(rule, group, ctx);
    transfer::public_transfer(coin, ctx.sender());
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_fee"></a>

## Function `fee`

Returns the join fee.


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>&lt;Token: drop&gt;(rule: &<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;): u64
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>&lt;Token: drop&gt;(rule: &<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;): u64 {
    rule.<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_fee">fee</a>
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_group_id"></a>

## Function `group_id`

Returns the group ID this rule is associated with.


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>&lt;Token: drop&gt;(rule: &<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;): <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>&lt;Token: drop&gt;(rule: &<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;): ID {
    rule.<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_group_id">group_id</a>
}
</code></pre>



</details>

<a name="example_app_paid_join_rule_balance_value"></a>

## Function `balance_value`

Returns the current accumulated balance.


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_balance_value">balance_value</a>&lt;Token: drop&gt;(rule: &<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">example_app::paid_join_rule::PaidJoinRule</a>&lt;Token&gt;): u64
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_balance_value">balance_value</a>&lt;Token: drop&gt;(rule: &<a href="../example_app/paid_join_rule.md#example_app_paid_join_rule_PaidJoinRule">PaidJoinRule</a>&lt;Token&gt;): u64 {
    rule.balance.value()
}
</code></pre>



</details>
