
<a name="messaging_group_leaver"></a>

# Module `messaging::group_leaver`

Module: group_leaver

Actor object that allows group members to leave a <code>PermissionedGroup&lt;T&gt;</code>.

<code><a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a></code> is a derived singleton object from <code>MessagingNamespace</code>.
It is granted <code>PermissionsAdmin</code> on every group created via <code>messaging::create_group</code>,
and exposes a <code><a href="../messaging/group_leaver.md#messaging_group_leaver_leave">leave</a></code> function that calls <code>object_remove_member</code> on behalf of the caller.

This module does NOT import <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code> to avoid a circular dependency.
The generic <code><a href="../messaging/group_leaver.md#messaging_group_leaver_leave">leave</a>&lt;T: drop&gt;</code> is instantiated with the concrete <code>Messaging</code> type
at the call site in <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.

All public entry points are in the <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a></code> module:
- <code>messaging::leave</code> - removes the caller from a group


-  [Struct `GroupLeaver`](#messaging_group_leaver_GroupLeaver)
-  [Constants](#@Constants_0)
-  [Function `new`](#messaging_group_leaver_new)
    -  [Parameters](#@Parameters_1)
    -  [Returns](#@Returns_2)
-  [Function `share`](#messaging_group_leaver_share)
-  [Function `derivation_key`](#messaging_group_leaver_derivation_key)
    -  [Returns](#@Returns_3)
-  [Function `leave`](#messaging_group_leaver_leave)
    -  [Aborts](#@Aborts_4)


<pre><code><b>use</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group">permissioned_groups::permissioned_group</a>;
<b>use</b> <a href="../dependencies/permissioned_groups/permissions_table.md#permissioned_groups_permissions_table">permissioned_groups::permissions_table</a>;
<b>use</b> <a href="../dependencies/permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap">permissioned_groups::unpause_cap</a>;
<b>use</b> <a href="../dependencies/std/address.md#std_address">std::address</a>;
<b>use</b> <a href="../dependencies/std/ascii.md#std_ascii">std::ascii</a>;
<b>use</b> <a href="../dependencies/std/bcs.md#std_bcs">std::bcs</a>;
<b>use</b> <a href="../dependencies/std/option.md#std_option">std::option</a>;
<b>use</b> <a href="../dependencies/std/string.md#std_string">std::string</a>;
<b>use</b> <a href="../dependencies/std/type_name.md#std_type_name">std::type_name</a>;
<b>use</b> <a href="../dependencies/std/vector.md#std_vector">std::vector</a>;
<b>use</b> <a href="../dependencies/myso/accumulator.md#myso_accumulator">myso::accumulator</a>;
<b>use</b> <a href="../dependencies/myso/accumulator_settlement.md#myso_accumulator_settlement">myso::accumulator_settlement</a>;
<b>use</b> <a href="../dependencies/myso/address.md#myso_address">myso::address</a>;
<b>use</b> <a href="../dependencies/myso/bcs.md#myso_bcs">myso::bcs</a>;
<b>use</b> <a href="../dependencies/myso/derived_object.md#myso_derived_object">myso::derived_object</a>;
<b>use</b> <a href="../dependencies/myso/dynamic_field.md#myso_dynamic_field">myso::dynamic_field</a>;
<b>use</b> <a href="../dependencies/myso/event.md#myso_event">myso::event</a>;
<b>use</b> <a href="../dependencies/myso/hash.md#myso_hash">myso::hash</a>;
<b>use</b> <a href="../dependencies/myso/hex.md#myso_hex">myso::hex</a>;
<b>use</b> <a href="../dependencies/myso/object.md#myso_object">myso::object</a>;
<b>use</b> <a href="../dependencies/myso/party.md#myso_party">myso::party</a>;
<b>use</b> <a href="../dependencies/myso/transfer.md#myso_transfer">myso::transfer</a>;
<b>use</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context">myso::tx_context</a>;
<b>use</b> <a href="../dependencies/myso/vec_map.md#myso_vec_map">myso::vec_map</a>;
<b>use</b> <a href="../dependencies/myso/vec_set.md#myso_vec_set">myso::vec_set</a>;
</code></pre>



<a name="messaging_group_leaver_GroupLeaver"></a>

## Struct `GroupLeaver`

Actor object that holds <code>PermissionsAdmin</code> on all messaging groups.
The <code>id</code> field is intentionally private — no UID getter is exposed.
All leave operations go through the package-internal <code><a href="../messaging/group_leaver.md#messaging_group_leaver_leave">leave</a>&lt;T&gt;</code> function.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a> <b>has</b> key
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code>id: <a href="../dependencies/myso/object.md#myso_object_UID">myso::object::UID</a></code>
</dt>
<dd>
</dd>
</dl>


</details>

<a name="@Constants_0"></a>

## Constants


<a name="messaging_group_leaver_GROUP_LEAVER_DERIVATION_KEY"></a>

Fixed derivation key for the singleton <code><a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a></code> derived from <code>MessagingNamespace</code>.


<pre><code><b>const</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_GROUP_LEAVER_DERIVATION_KEY">GROUP_LEAVER_DERIVATION_KEY</a>: vector&lt;u8&gt; = vector[103, 114, 111, 117, 112, 95, 108, 101, 97, 118, 101, 114];
</code></pre>



<a name="messaging_group_leaver_new"></a>

## Function `new`

Creates a new <code><a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a></code> derived from the namespace UID.
Called once during <code>messaging::init</code>.


<a name="@Parameters_1"></a>

### Parameters

- <code>namespace_uid</code>: Mutable reference to the <code>MessagingNamespace</code> UID


<a name="@Returns_2"></a>

### Returns

A new <code><a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a></code> object with a deterministic address.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_new">new</a>(namespace_uid: &<b>mut</b> <a href="../dependencies/myso/object.md#myso_object_UID">myso::object::UID</a>): <a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">messaging::group_leaver::GroupLeaver</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_new">new</a>(namespace_uid: &<b>mut</b> UID): <a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a> {
    <a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a> {
        id: derived_object::claim(namespace_uid, <a href="../messaging/group_leaver.md#messaging_group_leaver_GROUP_LEAVER_DERIVATION_KEY">GROUP_LEAVER_DERIVATION_KEY</a>.to_string()),
    }
}
</code></pre>



</details>

<a name="messaging_group_leaver_share"></a>

## Function `share`

Shares the <code><a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a></code> object on-chain.
Called once during <code>messaging::init</code> after creating the object.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_share">share</a>(self: <a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">messaging::group_leaver::GroupLeaver</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_share">share</a>(self: <a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a>) {
    transfer::share_object(self);
}
</code></pre>



</details>

<a name="messaging_group_leaver_derivation_key"></a>

## Function `derivation_key`

Returns the fixed derivation key string.
Used by <code>messaging::create_group</code> to compute the <code><a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a></code>'s address via
<code>derived_object::derive_address</code> without holding the object.


<a name="@Returns_3"></a>

### Returns

The string key used for address derivation.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_derivation_key">derivation_key</a>(): <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_derivation_key">derivation_key</a>(): String {
    <a href="../messaging/group_leaver.md#messaging_group_leaver_GROUP_LEAVER_DERIVATION_KEY">GROUP_LEAVER_DERIVATION_KEY</a>.to_string()
}
</code></pre>



</details>

<a name="messaging_group_leaver_leave"></a>

## Function `leave`

Removes the caller (<code>ctx.sender()</code>) from the group.
The <code><a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a></code> must have <code>PermissionsAdmin</code> on the group (granted at creation time).

Generic over <code>T: drop</code> so this module does not need to import <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.
Instantiated as <code><a href="../messaging/group_leaver.md#messaging_group_leaver_leave">leave</a>&lt;Messaging&gt;</code> at the call site in <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.


<a name="@Aborts_4"></a>

### Aborts

- <code>ENotPermitted</code>: if this actor doesn't have <code>PermissionsAdmin</code> on the group
- <code>EMemberNotFound</code>: if the caller is not a member of the group
- <code>ELastPermissionsAdmin</code>: if the caller is the last <code>PermissionsAdmin</code>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_leave">leave</a>&lt;T: drop&gt;(self: &<a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">messaging::group_leaver::GroupLeaver</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;T&gt;, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_leaver.md#messaging_group_leaver_leave">leave</a>&lt;T: drop&gt;(
    self: &<a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">GroupLeaver</a>,
    group: &<b>mut</b> PermissionedGroup&lt;T&gt;,
    ctx: &TxContext,
) {
    group.object_remove_member&lt;T&gt;(&self.id, ctx.sender());
}
</code></pre>



</details>
