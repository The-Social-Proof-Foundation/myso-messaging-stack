
<a name="messaging_messaging"></a>

# Module `messaging::messaging`

Module: messaging

Public-facing module for the messaging package. All external interactions
should go through this module.

Wraps <code>permissions_group</code> to provide messaging-specific permission management
and <code><a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a></code> for key rotation.


<a name="@Permissions_0"></a>

### Permissions


From groups (auto-granted to creator):
- <code>PermissionsAdmin</code>: Manages core permissions (from permissioned_groups package)
- <code>ExtensionPermissionsAdmin</code>: Manages extension permissions (from other packages)

Messaging-specific:
- <code><a href="../messaging/messaging.md#messaging_messaging_MessagingSender">MessagingSender</a></code>: Send messages
- <code><a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a></code>: Read/decrypt messages
- <code><a href="../messaging/messaging.md#messaging_messaging_MessagingEditor">MessagingEditor</a></code>: Edit messages
- <code><a href="../messaging/messaging.md#messaging_messaging_MessagingDeleter">MessagingDeleter</a></code>: Delete messages
- <code>EncryptionKeyRotator</code>: Rotate encryption keys
- <code><a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a></code>: Manage MySoNS reverse lookups on the group
- <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code>: Edit group metadata (name, data)


<a name="@Security_1"></a>

### Security


- Membership is defined by having at least one permission
- Granting a permission implicitly adds the member if they don't exist
- Revoking the last permission automatically removes the member


    -  [Permissions](#@Permissions_0)
    -  [Security](#@Security_1)
-  [Struct `MESSAGING`](#messaging_messaging_MESSAGING)
-  [Struct `Messaging`](#messaging_messaging_Messaging)
-  [Struct `MessagingSender`](#messaging_messaging_MessagingSender)
-  [Struct `MessagingReader`](#messaging_messaging_MessagingReader)
-  [Struct `MessagingDeleter`](#messaging_messaging_MessagingDeleter)
-  [Struct `MessagingEditor`](#messaging_messaging_MessagingEditor)
-  [Struct `MySoNsAdmin`](#messaging_messaging_MySoNsAdmin)
-  [Struct `MetadataAdmin`](#messaging_messaging_MetadataAdmin)
-  [Struct `MessagingNamespace`](#messaging_messaging_MessagingNamespace)
-  [Constants](#@Constants_2)
-  [Function `init`](#messaging_messaging_init)
-  [Function `create_group`](#messaging_messaging_create_group)
    -  [Parameters](#@Parameters_3)
    -  [Returns](#@Returns_4)
    -  [Note](#@Note_5)
    -  [Aborts](#@Aborts_6)
-  [Function `create_and_share_group`](#messaging_messaging_create_and_share_group)
    -  [Parameters](#@Parameters_7)
    -  [Note](#@Note_8)
-  [Function `rotate_encryption_key`](#messaging_messaging_rotate_encryption_key)
    -  [Parameters](#@Parameters_9)
    -  [Aborts](#@Aborts_10)
-  [Function `leave`](#messaging_messaging_leave)
    -  [Parameters](#@Parameters_11)
    -  [Aborts](#@Aborts_12)
-  [Function `archive_group`](#messaging_messaging_archive_group)
    -  [Aborts](#@Aborts_13)
    -  [Note](#@Note_14)
-  [Function `set_mysons_reverse_lookup`](#messaging_messaging_set_mysons_reverse_lookup)
    -  [Parameters](#@Parameters_15)
    -  [Aborts](#@Aborts_16)
-  [Function `unset_mysons_reverse_lookup`](#messaging_messaging_unset_mysons_reverse_lookup)
    -  [Parameters](#@Parameters_17)
    -  [Aborts](#@Aborts_18)
-  [Function `set_group_name`](#messaging_messaging_set_group_name)
    -  [Aborts](#@Aborts_19)
-  [Function `insert_group_data`](#messaging_messaging_insert_group_data)
    -  [Aborts](#@Aborts_20)
-  [Function `remove_group_data`](#messaging_messaging_remove_group_data)
    -  [Returns](#@Returns_21)
    -  [Aborts](#@Aborts_22)
-  [Function `grant_all_messaging_permissions`](#messaging_messaging_grant_all_messaging_permissions)


<pre><code><b>use</b> <a href="../messaging/encryption_history.md#messaging_encryption_history">messaging::encryption_history</a>;
<b>use</b> <a href="../messaging/group_leaver.md#messaging_group_leaver">messaging::group_leaver</a>;
<b>use</b> <a href="../messaging/group_manager.md#messaging_group_manager">messaging::group_manager</a>;
<b>use</b> <a href="../messaging/metadata.md#messaging_metadata">messaging::metadata</a>;
<b>use</b> <a href="../messaging/version.md#messaging_version">messaging::version</a>;
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



<a name="messaging_messaging_MESSAGING"></a>

## Struct `MESSAGING`

One-Time Witness for claiming Publisher.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MESSAGING">MESSAGING</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_Messaging"></a>

## Struct `Messaging`

Package witness for <code>PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;</code>.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_MessagingSender"></a>

## Struct `MessagingSender`

Permission to send messages to the group.
Separate from <code><a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a></code> to enable mute functionality.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingSender">MessagingSender</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_MessagingReader"></a>

## Struct `MessagingReader`

Permission to read/decrypt messages from the group.
Separate from <code><a href="../messaging/messaging.md#messaging_messaging_MessagingSender">MessagingSender</a></code> to enable read-only or write-only access.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_MessagingDeleter"></a>

## Struct `MessagingDeleter`

Permission to delete messages in the group.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingDeleter">MessagingDeleter</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_MessagingEditor"></a>

## Struct `MessagingEditor`

Permission to edit messages in the group.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingEditor">MessagingEditor</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_MySoNsAdmin"></a>

## Struct `MySoNsAdmin`

Permission to manage MySoNS reverse lookups on the group.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_MetadataAdmin"></a>

## Struct `MetadataAdmin`

Permission to edit group metadata (name, data).


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_messaging_MessagingNamespace"></a>

## Struct `MessagingNamespace`

Shared object used as namespace for deriving group and encryption history addresses.
One per package deployment.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingNamespace">MessagingNamespace</a> <b>has</b> key
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

<a name="@Constants_2"></a>

## Constants


<a name="messaging_messaging_ENotPermitted"></a>

Caller lacks the required permission for the operation.


<pre><code><b>const</b> <a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a>: u64 = 0;
</code></pre>



<a name="messaging_messaging_EGroupArchived"></a>

The group is archived (paused) and cannot be mutated.


<pre><code><b>const</b> <a href="../messaging/messaging.md#messaging_messaging_EGroupArchived">EGroupArchived</a>: u64 = 1;
</code></pre>



<a name="messaging_messaging_init"></a>

## Function `init`



<pre><code><b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_init">init</a>(otw: <a href="../messaging/messaging.md#messaging_messaging_MESSAGING">messaging::messaging::MESSAGING</a>, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_init">init</a>(otw: <a href="../messaging/messaging.md#messaging_messaging_MESSAGING">MESSAGING</a>, ctx: &<b>mut</b> TxContext) {
    package::claim_and_keep(otw, ctx);
    <b>let</b> <b>mut</b> namespace = <a href="../messaging/messaging.md#messaging_messaging_MessagingNamespace">MessagingNamespace</a> {
        id: object::new(ctx),
    };
    <b>let</b> <a href="../messaging/group_leaver.md#messaging_group_leaver">group_leaver</a> = <a href="../messaging/group_leaver.md#messaging_group_leaver_new">group_leaver::new</a>(&<b>mut</b> namespace.id);
    <b>let</b> <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a> = <a href="../messaging/group_manager.md#messaging_group_manager_new">group_manager::new</a>(&<b>mut</b> namespace.id);
    transfer::share_object(namespace);
    <a href="../messaging/group_leaver.md#messaging_group_leaver_share">group_leaver::share</a>(<a href="../messaging/group_leaver.md#messaging_group_leaver">group_leaver</a>);
    <a href="../messaging/group_manager.md#messaging_group_manager_share">group_manager::share</a>(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>);
}
</code></pre>



</details>

<a name="messaging_messaging_create_group"></a>

## Function `create_group`

Creates a new messaging group with encryption.
The transaction sender (<code>ctx.sender()</code>) automatically becomes the creator with all permissions.


<a name="@Parameters_3"></a>

### Parameters

- <code><a href="../messaging/version.md#messaging_version">version</a></code>: Reference to the Version shared object
- <code>namespace</code>: Mutable reference to the MessagingNamespace
- <code><a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a></code>: Reference to the shared GroupManager actor
- <code>name</code>: Human-readable group name
- <code>uuid</code>: Client-provided UUID for deterministic address derivation
- <code>initial_encrypted_dek</code>: Initial MyData-encrypted DEK bytes
- <code>initial_members</code>: Addresses to grant <code><a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a></code> permission (should not include
creator)
- <code>ctx</code>: Transaction context


<a name="@Returns_4"></a>

### Returns

Tuple of <code>(PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;, EncryptionHistory)</code>.


<a name="@Note_5"></a>

### Note

If <code>initial_members</code> contains the creator's address, it is silently skipped (no abort).
This handles the common case where the creator might be mistakenly included in the initial
members list.


<a name="@Aborts_6"></a>

### Aborts

- <code>EInvalidVersion</code> (from <code><a href="../messaging/version.md#messaging_version">version</a></code>): if package version doesn't match
- If the UUID has already been used (duplicate derivation)


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_create_group">create_group</a>(<a href="../messaging/version.md#messaging_version">version</a>: &<a href="../messaging/version.md#messaging_version_Version">messaging::version::Version</a>, namespace: &<b>mut</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingNamespace">messaging::messaging::MessagingNamespace</a>, <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, name: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, uuid: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, initial_encrypted_dek: vector&lt;u8&gt;, initial_members: <a href="../dependencies/myso/vec_set.md#myso_vec_set_VecSet">myso::vec_set::VecSet</a>&lt;<b>address</b>&gt;, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>): (<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_create_group">create_group</a>(
    <a href="../messaging/version.md#messaging_version">version</a>: &Version,
    namespace: &<b>mut</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingNamespace">MessagingNamespace</a>,
    <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &GroupManager,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector&lt;u8&gt;,
    initial_members: VecSet&lt;<b>address</b>&gt;,
    ctx: &<b>mut</b> TxContext,
): (PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;, EncryptionHistory) {
    <a href="../messaging/version.md#messaging_version">version</a>.validate_version();
    <b>let</b> <b>mut</b> group: PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt; = permissioned_group::new_derived&lt;
        <a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>,
        <a href="../messaging/encryption_history.md#messaging_encryption_history_PermissionedGroupTag">encryption_history::PermissionedGroupTag</a>,
    &gt;(
        <a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>(),
        &<b>mut</b> namespace.id,
        <a href="../messaging/encryption_history.md#messaging_encryption_history_permissions_group_tag">encryption_history::permissions_group_tag</a>(uuid),
        ctx,
    );
    <b>let</b> creator = ctx.sender();
    <a href="../messaging/messaging.md#messaging_messaging_grant_all_messaging_permissions">grant_all_messaging_permissions</a>(&<b>mut</b> group, creator, ctx);
    // Grant PermissionsAdmin to the GroupLeaver actor so it can remove members on behalf of
    // callers.
    // The <b>address</b> is derived deterministically from the namespace — no need to pass the object.
    <b>let</b> group_leaver_address = <a href="../dependencies/myso/derived_object.md#myso_derived_object_derive_address">myso::derived_object::derive_address</a>(
        object::id(namespace),
        <a href="../messaging/group_leaver.md#messaging_group_leaver_derivation_key">group_leaver::derivation_key</a>(),
    );
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, PermissionsAdmin&gt;(group_leaver_address, ctx);
    // Grant ObjectAdmin to the GroupManager actor so it can access the group UID
    // <b>for</b> MySoNS reverse lookups and <a href="../messaging/metadata.md#messaging_metadata">metadata</a> management.
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, ObjectAdmin&gt;(
        object::id(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>).to_address(),
        ctx,
    );
    // Attach Metadata via GroupManager
    <b>let</b> m = <a href="../messaging/metadata.md#messaging_metadata_new">metadata::new</a>(name, uuid, creator);
    <a href="../messaging/group_manager.md#messaging_group_manager_attach_metadata">group_manager::attach_metadata</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>, &<b>mut</b> group, m);
    // Grant <a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a> permission to initial members (skip creator)
    initial_members.into_keys().do!(|member| {
        <b>if</b> (member != creator) {
            group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a>&gt;(member, ctx);
        };
    });
    <b>let</b> <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a> = <a href="../messaging/encryption_history.md#messaging_encryption_history_new">encryption_history::new</a>(
        &<b>mut</b> namespace.id,
        uuid,
        object::id(&group),
        initial_encrypted_dek,
        ctx,
    );
    (group, <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>)
}
</code></pre>



</details>

<a name="messaging_messaging_create_and_share_group"></a>

## Function `create_and_share_group`

Creates a new messaging group and shares both objects.


<a name="@Parameters_7"></a>

### Parameters

- <code><a href="../messaging/version.md#messaging_version">version</a></code>: Reference to the Version shared object
- <code>namespace</code>: Mutable reference to the MessagingNamespace
- <code><a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a></code>: Reference to the shared GroupManager actor
- <code>name</code>: Human-readable group name
- <code>uuid</code>: Client-provided UUID for deterministic address derivation
- <code>initial_encrypted_dek</code>: Initial MyData-encrypted DEK bytes
- <code>initial_members</code>: Set of addresses to grant <code><a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a></code> permission
- <code>ctx</code>: Transaction context


<a name="@Note_8"></a>

### Note

See <code><a href="../messaging/messaging.md#messaging_messaging_create_group">create_group</a></code> for details on creator permissions and initial member handling.


<pre><code><b>entry</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_create_and_share_group">create_and_share_group</a>(<a href="../messaging/version.md#messaging_version">version</a>: &<a href="../messaging/version.md#messaging_version_Version">messaging::version::Version</a>, namespace: &<b>mut</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingNamespace">messaging::messaging::MessagingNamespace</a>, <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, name: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, uuid: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, initial_encrypted_dek: vector&lt;u8&gt;, initial_members: vector&lt;<b>address</b>&gt;, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>entry</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_create_and_share_group">create_and_share_group</a>(
    <a href="../messaging/version.md#messaging_version">version</a>: &Version,
    namespace: &<b>mut</b> <a href="../messaging/messaging.md#messaging_messaging_MessagingNamespace">MessagingNamespace</a>,
    <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &GroupManager,
    name: String,
    uuid: String,
    initial_encrypted_dek: vector&lt;u8&gt;,
    initial_members: vector&lt;<b>address</b>&gt;,
    ctx: &<b>mut</b> TxContext,
) {
    <b>let</b> (group, <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>) = <a href="../messaging/messaging.md#messaging_messaging_create_group">create_group</a>(
        <a href="../messaging/version.md#messaging_version">version</a>,
        namespace,
        <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>,
        name,
        uuid,
        initial_encrypted_dek,
        vec_set::from_keys(initial_members),
        ctx,
    );
    transfer::public_share_object(group);
    transfer::public_share_object(<a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>);
}
</code></pre>



</details>

<a name="messaging_messaging_rotate_encryption_key"></a>

## Function `rotate_encryption_key`

Rotates the encryption key for a group.


<a name="@Parameters_9"></a>

### Parameters

- <code><a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a></code>: Mutable reference to the group's EncryptionHistory
- <code>group</code>: Reference to the PermissionedGroup<Messaging>
- <code>new_encrypted_dek</code>: New MyData-encrypted DEK bytes
- <code>ctx</code>: Transaction context


<a name="@Aborts_10"></a>

### Aborts

- <code>EInvalidVersion</code> (from <code><a href="../messaging/version.md#messaging_version">version</a></code>): if package version doesn't match
- <code><a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code>EncryptionKeyRotator</code> permission


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_rotate_encryption_key">rotate_encryption_key</a>(<a href="../messaging/version.md#messaging_version">version</a>: &<a href="../messaging/version.md#messaging_version_Version">messaging::version::Version</a>, <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>: &<b>mut</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>, group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, new_encrypted_dek: vector&lt;u8&gt;, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_rotate_encryption_key">rotate_encryption_key</a>(
    <a href="../messaging/version.md#messaging_version">version</a>: &Version,
    <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>: &<b>mut</b> EncryptionHistory,
    group: &PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    new_encrypted_dek: vector&lt;u8&gt;,
    ctx: &TxContext,
) {
    <a href="../messaging/version.md#messaging_version">version</a>.validate_version();
    <b>assert</b>!(!group.is_paused(), <a href="../messaging/messaging.md#messaging_messaging_EGroupArchived">EGroupArchived</a>);
    <b>assert</b>!(group.has_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, EncryptionKeyRotator&gt;(ctx.sender()), <a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a>);
    <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>.rotate_key(new_encrypted_dek);
}
</code></pre>



</details>

<a name="messaging_messaging_leave"></a>

## Function `leave`

Removes the caller from a messaging group.
The <code>GroupLeaver</code> actor holds <code>PermissionsAdmin</code> on all groups and calls
<code>object_remove_member</code> on behalf of the caller.


<a name="@Parameters_11"></a>

### Parameters

- <code><a href="../messaging/group_leaver.md#messaging_group_leaver">group_leaver</a></code>: Reference to the shared <code>GroupLeaver</code> object
- <code>group</code>: Mutable reference to the <code>PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;</code>
- <code>ctx</code>: Transaction context


<a name="@Aborts_12"></a>

### Aborts

- <code>EMemberNotFound</code> (from <code>permissioned_group</code>): if the caller is not a member
- <code>ELastPermissionsAdmin</code> (from <code>permissioned_group</code>): if the caller is the last
<code>PermissionsAdmin</code> holder (including actor objects)

NOTE: Because <code>GroupLeaver</code> itself holds <code>PermissionsAdmin</code> on every group, a human
admin can always leave — leaving <code>GroupLeaver</code> as the sole remaining admin. A group in
that state has no human admins. To promote a new human admin from that state, a
dedicated actor-object wrapper over <code>object_grant_permission</code> would be needed.


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_leave">leave</a>(<a href="../messaging/group_leaver.md#messaging_group_leaver">group_leaver</a>: &<a href="../messaging/group_leaver.md#messaging_group_leaver_GroupLeaver">messaging::group_leaver::GroupLeaver</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_leave">leave</a>(
    <a href="../messaging/group_leaver.md#messaging_group_leaver">group_leaver</a>: &GroupLeaver,
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    ctx: &TxContext,
) {
    <a href="../messaging/group_leaver.md#messaging_group_leaver_leave">group_leaver::leave</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(<a href="../messaging/group_leaver.md#messaging_group_leaver">group_leaver</a>, group, ctx);
}
</code></pre>



</details>

<a name="messaging_messaging_archive_group"></a>

## Function `archive_group`

Permanently archives a messaging group.

Pauses the group and burns the <code>UnpauseCap</code>, making it impossible to unpause.
After this call, <code>is_paused()</code> returns <code><b>true</b></code> and all mutations are blocked.

The caller must have <code>PermissionsAdmin</code> permission (enforced by <code>pause()</code>).


<a name="@Aborts_13"></a>

### Aborts

- <code><a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a></code> (from <code>pause</code>): if caller doesn't have <code>PermissionsAdmin</code>
- <code>EAlreadyPaused</code> (from <code>pause</code>): if the group is already paused


<a name="@Note_14"></a>

### Note

Alternative to burning: <code>transfer::public_freeze_object(cap)</code> makes the cap immutable
and un-passable by value, also preventing unpause without destroying the object.


<pre><code><b>entry</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_archive_group">archive_group</a>(<a href="../messaging/version.md#messaging_version">version</a>: &<a href="../messaging/version.md#messaging_version_Version">messaging::version::Version</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>entry</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_archive_group">archive_group</a>(
    <a href="../messaging/version.md#messaging_version">version</a>: &Version,
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    ctx: &<b>mut</b> TxContext,
) {
    <a href="../messaging/version.md#messaging_version">version</a>.validate_version();
    <b>let</b> cap = group.pause&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(ctx);
    cap.burn();
}
</code></pre>



</details>

<a name="messaging_messaging_set_mysons_reverse_lookup"></a>

## Function `set_mysons_reverse_lookup`

Sets a MySoNS reverse lookup on a messaging group.
The caller must have <code><a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a></code> permission on the group.
The <code>GroupManager</code> actor internally holds <code>ObjectAdmin</code> to access the group UID.


<a name="@Parameters_15"></a>

### Parameters

- <code><a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a></code>: Reference to the shared <code>GroupManager</code> actor
- <code>group</code>: Mutable reference to the <code>PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;</code>
- <code>mysons</code>: Mutable reference to the MySoNS shared object
- <code>domain_name</code>: The domain name to set as reverse lookup
- <code>ctx</code>: Transaction context


<a name="@Aborts_16"></a>

### Aborts

- <code><a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code><a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a></code>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_set_mysons_reverse_lookup">set_mysons_reverse_lookup</a>(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, mysons: &<b>mut</b> <a href="../dependencies/mysons/mysons.md#mysons_mysons_MySoNS">mysons::mysons::MySoNS</a>, domain_name: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_set_mysons_reverse_lookup">set_mysons_reverse_lookup</a>(
    <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &GroupManager,
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    mysons: &<b>mut</b> MySoNS,
    domain_name: String,
    ctx: &TxContext,
) {
    <b>assert</b>!(group.has_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a>&gt;(ctx.sender()), <a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a>);
    <a href="../messaging/group_manager.md#messaging_group_manager_set_reverse_lookup">group_manager::set_reverse_lookup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>, group, mysons, domain_name);
}
</code></pre>



</details>

<a name="messaging_messaging_unset_mysons_reverse_lookup"></a>

## Function `unset_mysons_reverse_lookup`

Unsets a MySoNS reverse lookup on a messaging group.
The caller must have <code><a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a></code> permission on the group.
The <code>GroupManager</code> actor internally holds <code>ObjectAdmin</code> to access the group UID.


<a name="@Parameters_17"></a>

### Parameters

- <code><a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a></code>: Reference to the shared <code>GroupManager</code> actor
- <code>group</code>: Mutable reference to the <code>PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;</code>
- <code>mysons</code>: Mutable reference to the MySoNS shared object
- <code>ctx</code>: Transaction context


<a name="@Aborts_18"></a>

### Aborts

- <code><a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code><a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a></code>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_unset_mysons_reverse_lookup">unset_mysons_reverse_lookup</a>(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, mysons: &<b>mut</b> <a href="../dependencies/mysons/mysons.md#mysons_mysons_MySoNS">mysons::mysons::MySoNS</a>, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_unset_mysons_reverse_lookup">unset_mysons_reverse_lookup</a>(
    <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &GroupManager,
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    mysons: &<b>mut</b> MySoNS,
    ctx: &TxContext,
) {
    <b>assert</b>!(group.has_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a>&gt;(ctx.sender()), <a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a>);
    <a href="../messaging/group_manager.md#messaging_group_manager_unset_reverse_lookup">group_manager::unset_reverse_lookup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>, group, mysons);
}
</code></pre>



</details>

<a name="messaging_messaging_set_group_name"></a>

## Function `set_group_name`

Sets the group name.
Caller must have <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code> permission.


<a name="@Aborts_19"></a>

### Aborts

- <code><a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code>
- <code>ENameTooLong</code> (from <code><a href="../messaging/metadata.md#messaging_metadata">metadata</a></code>): if name exceeds limit


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_set_group_name">set_group_name</a>(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, name: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_set_group_name">set_group_name</a>(
    <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &GroupManager,
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    name: String,
    ctx: &TxContext,
) {
    <b>assert</b>!(group.has_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a>&gt;(ctx.sender()), <a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a>);
    <b>let</b> m = <a href="../messaging/group_manager.md#messaging_group_manager_borrow_metadata_mut">group_manager::borrow_metadata_mut</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>, group);
    m.set_name(name);
}
</code></pre>



</details>

<a name="messaging_messaging_insert_group_data"></a>

## Function `insert_group_data`

Inserts a key-value pair into the group's metadata data map.
Caller must have <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code> permission.


<a name="@Aborts_20"></a>

### Aborts

- <code><a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code>
- <code>EDataKeyTooLong</code> (from <code><a href="../messaging/metadata.md#messaging_metadata">metadata</a></code>): if key exceeds limit
- <code>EDataValueTooLong</code> (from <code><a href="../messaging/metadata.md#messaging_metadata">metadata</a></code>): if value exceeds limit


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_insert_group_data">insert_group_data</a>(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, key: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, value: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_insert_group_data">insert_group_data</a>(
    <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &GroupManager,
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    key: String,
    value: String,
    ctx: &TxContext,
) {
    <b>assert</b>!(group.has_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a>&gt;(ctx.sender()), <a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a>);
    <b>let</b> m = <a href="../messaging/group_manager.md#messaging_group_manager_borrow_metadata_mut">group_manager::borrow_metadata_mut</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>, group);
    m.insert_data(key, value);
}
</code></pre>



</details>

<a name="messaging_messaging_remove_group_data"></a>

## Function `remove_group_data`

Removes a key-value pair from the group's metadata data map.
Caller must have <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code> permission.


<a name="@Returns_21"></a>

### Returns

The removed (key, value) tuple.


<a name="@Aborts_22"></a>

### Aborts

- <code><a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_remove_group_data">remove_group_data</a>(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &<a href="../messaging/group_manager.md#messaging_group_manager_GroupManager">messaging::group_manager::GroupManager</a>, group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, key: &<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>): (<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_remove_group_data">remove_group_data</a>(
    <a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>: &GroupManager,
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    key: &String,
    ctx: &TxContext,
): (String, String) {
    <b>assert</b>!(group.has_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a>&gt;(ctx.sender()), <a href="../messaging/messaging.md#messaging_messaging_ENotPermitted">ENotPermitted</a>);
    <b>let</b> m = <a href="../messaging/group_manager.md#messaging_group_manager_borrow_metadata_mut">group_manager::borrow_metadata_mut</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;(<a href="../messaging/group_manager.md#messaging_group_manager">group_manager</a>, group);
    m.remove_data(key)
}
</code></pre>



</details>

<a name="messaging_messaging_grant_all_messaging_permissions"></a>

## Function `grant_all_messaging_permissions`

Grants all messaging permissions to a member.
Includes: <code><a href="../messaging/messaging.md#messaging_messaging_MessagingSender">MessagingSender</a></code>, <code><a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a></code>, <code><a href="../messaging/messaging.md#messaging_messaging_MessagingEditor">MessagingEditor</a></code>,
<code><a href="../messaging/messaging.md#messaging_messaging_MessagingDeleter">MessagingDeleter</a></code>, <code>EncryptionKeyRotator</code>, <code><a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a></code>, <code><a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a></code>.


<pre><code><b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_grant_all_messaging_permissions">grant_all_messaging_permissions</a>(group: &<b>mut</b> <a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, member: <b>address</b>, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>fun</b> <a href="../messaging/messaging.md#messaging_messaging_grant_all_messaging_permissions">grant_all_messaging_permissions</a>(
    group: &<b>mut</b> PermissionedGroup&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>&gt;,
    member: <b>address</b>,
    ctx: &TxContext,
) {
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MessagingSender">MessagingSender</a>&gt;(member, ctx);
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MessagingReader">MessagingReader</a>&gt;(member, ctx);
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MessagingEditor">MessagingEditor</a>&gt;(member, ctx);
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MessagingDeleter">MessagingDeleter</a>&gt;(member, ctx);
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, EncryptionKeyRotator&gt;(member, ctx);
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MySoNsAdmin">MySoNsAdmin</a>&gt;(member, ctx);
    group.grant_permission&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">Messaging</a>, <a href="../messaging/messaging.md#messaging_messaging_MetadataAdmin">MetadataAdmin</a>&gt;(member, ctx);
}
</code></pre>



</details>
