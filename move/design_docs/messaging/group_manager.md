
<a name="messaging_group_manager"></a>

# Module `messaging::group_manager`

Module: group_manager

Actor object that provides controlled <code>&<b>mut</b> UID</code> access to <code>PermissionedGroup&lt;T&gt;</code> objects.

<code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> is a derived singleton object from <code>MessagingNamespace</code>.
It is granted <code>ObjectAdmin</code> on every group created via <code>messaging::create_group</code>,
and exposes functions for:
- MySoNS reverse lookup management
- Metadata dynamic field management

This module does NOT import <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code> to avoid a circular dependency.
The generic functions are instantiated with the concrete <code>Messaging</code> type
at the call site in <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.

All public entry points are in the <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a></code> module.


-  [Struct `GroupManager`](#messaging_group_manager_GroupManager)
-  [Constants](#@Constants_0)
-  [Function `new`](#messaging_group_manager_new)
    -  [Parameters](#@Parameters_1)
    -  [Returns](#@Returns_2)
-  [Function `share`](#messaging_group_manager_share)
-  [Function `derivation_key`](#messaging_group_manager_derivation_key)
    -  [Returns](#@Returns_3)
-  [Function `set_reverse_lookup`](#messaging_group_manager_set_reverse_lookup)
    -  [Parameters](#@Parameters_4)
    -  [Aborts](#@Aborts_5)
-  [Function `unset_reverse_lookup`](#messaging_group_manager_unset_reverse_lookup)
    -  [Parameters](#@Parameters_6)
    -  [Aborts](#@Aborts_7)
-  [Function `attach_metadata`](#messaging_group_manager_attach_metadata)
-  [Function `remove_metadata`](#messaging_group_manager_remove_metadata)
-  [Function `borrow_metadata`](#messaging_group_manager_borrow_metadata)
-  [Function `borrow_metadata_mut`](#messaging_group_manager_borrow_metadata_mut)


<pre><code><b>use</b> <a href="../messaging/metadata.md#messaging_metadata">messaging::metadata</a>;
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



<a name="messaging_group_manager_GroupManager"></a>

## Struct `GroupManager`

Actor object that holds <code>ObjectAdmin</code> on all messaging groups.
The <code>id</code> field is intentionally private — no UID getter is exposed.
All operations go through the package-internal functions.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a> <b>has</b> key
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


<a name="messaging_group_manager_GROUP_MANAGER_DERIVATION_KEY"></a>

Fixed derivation key for the singleton <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> derived from <code>MessagingNamespace</code>.


<pre><code><b>const</b> <a href="../messaging/group_manager.md#messaging_group_manager_GROUP_MANAGER_DERIVATION_KEY">GROUP_MANAGER_DERIVATION_KEY</a>: vector&lt;u8&gt; = vector[103, 114, 111, 117, 112, 95, 109, 97, 110, 97, 103, 101, 114];
</code></pre>



<a name="messaging_group_manager_new"></a>

## Function `new`

Creates a new <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> derived from the namespace UID.
Called once during <code>messaging::init</code>.


<a name="@Parameters_1"></a>

### Parameters

- <code>namespace_uid</code>: Mutable reference to the <code>MessagingNamespace</code> UID


<a name="@Returns_2"></a>

### Returns

A new <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> object with a deterministic address.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_new">new</a>(namespace_uid: &<b>mut</b> <a href="../dependencies/myso/object.md#myso_object_UID">myso::object::UID</a>): <a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_new">new</a>(namespace_uid: &<b>mut</b> UID): <a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a> {
    <a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a> {
        id: derived_object::claim(namespace_uid, <a href="../messaging/group_manager.md#messaging_group_manager_GROUP_MANAGER_DERIVATION_KEY">GROUP_MANAGER_DERIVATION_KEY</a>.to_string()),
    }
}
</code></pre>



</details>

<a name="messaging_group_manager_share"></a>

## Function `share`

Shares the <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> object on-chain.
Called once during <code>messaging::init</code> after creating the object.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_share">share</a>(self: <a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_share">share</a>(self: <a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a>) {
    transfer::share_object(self);
}
</code></pre>



</details>

<a name="messaging_group_manager_derivation_key"></a>

## Function `derivation_key`

Returns the fixed derivation key string.
Used by <code>messaging::create_group</code> to compute the <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code>'s address via
<code>derived_object::derive_address</code> without holding the object.


<a name="@Returns_3"></a>

### Returns

The string key used for address derivation.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_derivation_key">derivation_key</a>(): <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_derivation_key">derivation_key</a>(): String {
    <a href="../messaging/group_manager.md#messaging_group_manager_GROUP_MANAGER_DERIVATION_KEY">GROUP_MANAGER_DERIVATION_KEY</a>.to_string()
}
</code></pre>



</details>

<a name="messaging_group_manager_set_reverse_lookup"></a>

## Function `set_reverse_lookup`

Sets a MySoNS reverse lookup on a group.
The <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> must have <code>ObjectAdmin</code> on the group (granted at creation time).

Generic over <code>T: drop</code> so this module does not need to import <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.
Instantiated as <code><a href="../messaging/group_manager.md#messaging_group_manager_set_reverse_lookup">set_reverse_lookup</a>&lt;Messaging&gt;</code> at the call site in <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.


<a name="@Parameters_4"></a>

### Parameters

- <code>self</code>: Reference to the <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> actor
- <code>group</code>: Mutable reference to the group
- <code>mysons</code>: Mutable reference to the MySoNS shared object
- <code>domain_name</code>: The domain name to set as reverse lookup


<a name="@Aborts_5"></a>

### Aborts

- <code>ENotPermitted</code>: if this actor doesn't have <code>ObjectAdmin</code> on the group


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_set_reverse_lookup">set_reverse_lookup</a>&lt;T: drop&gt;(self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;T&gt;, mysons: &<b>mut</b> <a href="../dependencies/mysons/mysons.md#mysons_mysons_MySoNS">mysons::mysons::MySoNS</a>, domain_name: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_set_reverse_lookup">set_reverse_lookup</a>&lt;T: drop&gt;(
    self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a>,
    group: &<b>mut</b> PermissionedGroup&lt;T&gt;,
    mysons: &<b>mut</b> MySoNS,
    domain_name: String,
) {
    <b>let</b> uid = group.object_uid_mut&lt;T&gt;(&self.id);
    controller::set_object_reverse_lookup(mysons, uid, domain_name);
}
</code></pre>



</details>

<a name="messaging_group_manager_unset_reverse_lookup"></a>

## Function `unset_reverse_lookup`

Unsets a MySoNS reverse lookup on a group.
The <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> must have <code>ObjectAdmin</code> on the group (granted at creation time).

Generic over <code>T: drop</code> so this module does not need to import <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.
Instantiated as <code><a href="../messaging/group_manager.md#messaging_group_manager_unset_reverse_lookup">unset_reverse_lookup</a>&lt;Messaging&gt;</code> at the call site in <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a>.<b>move</b></code>.


<a name="@Parameters_6"></a>

### Parameters

- <code>self</code>: Reference to the <code><a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a></code> actor
- <code>group</code>: Mutable reference to the group
- <code>mysons</code>: Mutable reference to the MySoNS shared object


<a name="@Aborts_7"></a>

### Aborts

- <code>ENotPermitted</code>: if this actor doesn't have <code>ObjectAdmin</code> on the group


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_unset_reverse_lookup">unset_reverse_lookup</a>&lt;T: drop&gt;(self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;T&gt;, mysons: &<b>mut</b> <a href="../dependencies/mysons/mysons.md#mysons_mysons_MySoNS">mysons::mysons::MySoNS</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_unset_reverse_lookup">unset_reverse_lookup</a>&lt;T: drop&gt;(
    self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a>,
    group: &<b>mut</b> PermissionedGroup&lt;T&gt;,
    mysons: &<b>mut</b> MySoNS,
) {
    <b>let</b> uid = group.object_uid_mut&lt;T&gt;(&self.id);
    controller::unset_object_reverse_lookup(mysons, uid);
}
</code></pre>



</details>

<a name="messaging_group_manager_attach_metadata"></a>

## Function `attach_metadata`

Attaches Metadata as a dynamic field on the group.
Called during <code>messaging::create_group</code>.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_attach_metadata">attach_metadata</a>&lt;T: drop&gt;(self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;T&gt;, m: <a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_attach_metadata">attach_metadata</a>&lt;T: drop&gt;(
    self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a>,
    group: &<b>mut</b> PermissionedGroup&lt;T&gt;,
    m: Metadata,
) {
    <b>let</b> uid = group.object_uid_mut&lt;T&gt;(&self.id);
    dynamic_field::add(uid, <a href="../messaging/metadata.md#messaging_metadata_key">metadata::key</a>(), m);
}
</code></pre>



</details>

<a name="messaging_group_manager_remove_metadata"></a>

## Function `remove_metadata`

Removes and returns Metadata from the group.
Used when archiving/destroying a group to preserve metadata.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_remove_metadata">remove_metadata</a>&lt;T: drop&gt;(self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;T&gt;): <a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_remove_metadata">remove_metadata</a>&lt;T: drop&gt;(
    self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a>,
    group: &<b>mut</b> PermissionedGroup&lt;T&gt;,
): Metadata {
    <b>let</b> uid = group.object_uid_mut&lt;T&gt;(&self.id);
    dynamic_field::remove(uid, <a href="../messaging/metadata.md#messaging_metadata_key">metadata::key</a>())
}
</code></pre>



</details>

<a name="messaging_group_manager_borrow_metadata"></a>

## Function `borrow_metadata`

Returns an immutable reference to the group's Metadata.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_borrow_metadata">borrow_metadata</a>&lt;T: drop&gt;(self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;T&gt;): &<a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_borrow_metadata">borrow_metadata</a>&lt;T: drop&gt;(
    self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a>,
    group: &PermissionedGroup&lt;T&gt;,
): &Metadata {
    <b>let</b> uid = group.object_uid&lt;T&gt;(&self.id);
    dynamic_field::borrow(uid, <a href="../messaging/metadata.md#messaging_metadata_key">metadata::key</a>())
}
</code></pre>



</details>

<a name="messaging_group_manager_borrow_metadata_mut"></a>

## Function `borrow_metadata_mut`

Returns a mutable reference to the group's Metadata.
Used by messaging.move to expose field-level setters with permission checks.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_borrow_metadata_mut">borrow_metadata_mut</a>&lt;T: drop&gt;(self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;T&gt;): &<b>mut</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/group_manager.md#messaging_group_manager_borrow_metadata_mut">borrow_metadata_mut</a>&lt;T: drop&gt;(
    self: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">GroupManager</a>,
    group: &<b>mut</b> PermissionedGroup&lt;T&gt;,
): &<b>mut</b> Metadata {
    <b>let</b> uid = group.object_uid_mut&lt;T&gt;(&self.id);
    dynamic_field::borrow_mut(uid, <a href="../messaging/metadata.md#messaging_metadata_key">metadata::key</a>())
}
</code></pre>



</details>
