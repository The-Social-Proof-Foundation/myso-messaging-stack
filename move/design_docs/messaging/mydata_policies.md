
<a name="messaging_mydata_policies"></a>

# Module `messaging::mydata_policies`

Module: mydata_policies

Default <code>mydata_approve</code> functions for MyData encryption access control.
Called by MyData key servers (via dry-run) to authorize decryption.


<a name="@Identity_Bytes_Format_0"></a>

### Identity Bytes Format


Identity bytes: <code>[group_id (32 bytes)][key_version (8 bytes LE u64)]</code>
Total: 40 bytes

- <code>group_id</code>: The PermissionedGroup<Messaging> object ID
- <code>key_version</code>: The encryption key version (supports key rotation)


<a name="@Custom_Policies_1"></a>

### Custom Policies


Apps can implement custom <code>mydata_approve</code> with different logic:
- Subscription-based, time-limited, NFT-gated access, etc.
- Must be in the same package used during <code>mydata.encrypt</code>.


    -  [Identity Bytes Format](#@Identity_Bytes_Format_0)
    -  [Custom Policies](#@Custom_Policies_1)
-  [Constants](#@Constants_2)
-  [Function `validate_identity`](#messaging_mydata_policies_validate_identity)
    -  [Parameters](#@Parameters_3)
    -  [Aborts](#@Aborts_4)
-  [Function `mydata_approve_reader`](#messaging_mydata_policies_mydata_approve_reader)
    -  [Parameters](#@Parameters_5)
    -  [Aborts](#@Aborts_6)


<pre><code><b>use</b> <a href="../messaging/encryption_history.md#messaging_encryption_history">messaging::encryption_history</a>;
<b>use</b> <a href="../messaging/group_leaver.md#messaging_group_leaver">messaging::group_leaver</a>;
<b>use</b> <a href="../messaging/group_manager.md#messaging_group_manager">messaging::group_manager</a>;
<b>use</b> <a href="../messaging/messaging.md#messaging_messaging">messaging::messaging</a>;
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



<a name="@Constants_2"></a>

## Constants


<a name="messaging_mydata_policies_EInvalidIdentity"></a>

Identity bytes are malformed (wrong length or mismatched group ID).


<pre><code><b>const</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidIdentity">EInvalidIdentity</a>: u64 = 0;
</code></pre>



<a name="messaging_mydata_policies_ENotPermitted"></a>

Caller lacks the required <code>MessagingReader</code> permission.


<pre><code><b>const</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_ENotPermitted">ENotPermitted</a>: u64 = 1;
</code></pre>



<a name="messaging_mydata_policies_EInvalidKeyVersion"></a>

Requested key version does not exist in the encryption history.


<pre><code><b>const</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidKeyVersion">EInvalidKeyVersion</a>: u64 = 2;
</code></pre>



<a name="messaging_mydata_policies_EEncryptionHistoryMismatch"></a>

The provided <code>EncryptionHistory</code> does not belong to the given group.


<pre><code><b>const</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_EEncryptionHistoryMismatch">EEncryptionHistoryMismatch</a>: u64 = 3;
</code></pre>



<a name="messaging_mydata_policies_IDENTITY_BYTES_LENGTH"></a>

Expected identity bytes length: 32 (group_id) + 8 (key_version) = 40 bytes


<pre><code><b>const</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_IDENTITY_BYTES_LENGTH">IDENTITY_BYTES_LENGTH</a>: u64 = 40;
</code></pre>



<a name="messaging_mydata_policies_validate_identity"></a>

## Function `validate_identity`

Validates identity bytes format and extracts components.

Expected format: <code>[group_id (32 bytes)][key_version (8 bytes LE u64)]</code>

Custom <code>mydata_approve</code> functions in external packages should call this
to reuse the standard identity validation logic instead of duplicating it.


<a name="@Parameters_3"></a>

### Parameters

- <code>group</code>: Reference to the PermissionedGroup<Messaging>
- <code><a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a></code>: Reference to the EncryptionHistory
- <code>id</code>: The MyData identity bytes to validate


<a name="@Aborts_4"></a>

### Aborts

- <code><a href="../messaging/mydata_policies.md#messaging_mydata_policies_EEncryptionHistoryMismatch">EEncryptionHistoryMismatch</a></code>: if encryption_history doesn't belong to this group
- <code><a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidIdentity">EInvalidIdentity</a></code>: if length != 40 or group_id doesn't match
- <code><a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidKeyVersion">EInvalidKeyVersion</a></code>: if key_version > current_key_version


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_validate_identity">validate_identity</a>(group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>, id: vector&lt;u8&gt;)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_validate_identity">validate_identity</a>(
    group: &PermissionedGroup&lt;Messaging&gt;,
    <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>: &EncryptionHistory,
    id: vector&lt;u8&gt;,
) {
    // Verify <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a> belongs to this group
    <b>assert</b>!(<a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>.group_id() == object::id(group), <a href="../messaging/mydata_policies.md#messaging_mydata_policies_EEncryptionHistoryMismatch">EEncryptionHistoryMismatch</a>);
    // Must be exactly 40 bytes: 32 (group_id) + 8 (key_version)
    <b>assert</b>!(id.length() == <a href="../messaging/mydata_policies.md#messaging_mydata_policies_IDENTITY_BYTES_LENGTH">IDENTITY_BYTES_LENGTH</a>, <a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidIdentity">EInvalidIdentity</a>);
    // Use BCS to parse the identity bytes
    <b>let</b> <b>mut</b> bcs_bytes = bcs::new(id);
    // Parse group_id (32 bytes <b>as</b> <b>address</b>)
    <b>let</b> parsed_group_id = bcs_bytes.peel_address();
    // Verify group_id matches
    <b>assert</b>!(object::id_to_address(&object::id(group)) == parsed_group_id, <a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidIdentity">EInvalidIdentity</a>);
    // Parse key_version (u64, little-endian)
    <b>let</b> key_version = bcs_bytes.peel_u64();
    // Key <a href="../messaging/version.md#messaging_version">version</a> must exist (be &lt;= current <a href="../messaging/version.md#messaging_version">version</a>)
    <b>assert</b>!(key_version &lt;= <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>.current_key_version(), <a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidKeyVersion">EInvalidKeyVersion</a>);
}
</code></pre>



</details>

<a name="messaging_mydata_policies_mydata_approve_reader"></a>

## Function `mydata_approve_reader`

Default mydata_approve that checks <code>MessagingReader</code> permission.


<a name="@Parameters_5"></a>

### Parameters

- <code>id</code>: MyData identity bytes <code>[group_id (32 bytes)][key_version (8 bytes LE u64)]</code>
- <code>group</code>: Reference to the PermissionedGroup<Messaging>
- <code><a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a></code>: Reference to the EncryptionHistory
- <code>ctx</code>: Transaction context


<a name="@Aborts_6"></a>

### Aborts

- <code><a href="../messaging/mydata_policies.md#messaging_mydata_policies_EEncryptionHistoryMismatch">EEncryptionHistoryMismatch</a></code>: if encryption_history doesn't belong to this group
- <code><a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidIdentity">EInvalidIdentity</a></code>: if identity bytes are malformed or group_id doesn't match
- <code><a href="../messaging/mydata_policies.md#messaging_mydata_policies_EInvalidKeyVersion">EInvalidKeyVersion</a></code>: if key_version doesn't exist
- <code><a href="../messaging/mydata_policies.md#messaging_mydata_policies_ENotPermitted">ENotPermitted</a></code>: if caller doesn't have <code>MessagingReader</code> permission


<pre><code><b>entry</b> <b>fun</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_mydata_approve_reader">mydata_approve_reader</a>(id: vector&lt;u8&gt;, <a href="../messaging/version.md#messaging_version">version</a>: &<a href="../messaging/version.md#messaging_version_Version">messaging::version::Version</a>, group: &<a href="../dependencies/permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_PermissionedGroup">permissioned_groups::permissioned_group::PermissionedGroup</a>&lt;<a href="../messaging/messaging.md#messaging_messaging_Messaging">messaging::messaging::Messaging</a>&gt;, <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>, ctx: &<a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>entry</b> <b>fun</b> <a href="../messaging/mydata_policies.md#messaging_mydata_policies_mydata_approve_reader">mydata_approve_reader</a>(
    id: vector&lt;u8&gt;,
    <a href="../messaging/version.md#messaging_version">version</a>: &Version,
    group: &PermissionedGroup&lt;Messaging&gt;,
    <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>: &EncryptionHistory,
    ctx: &TxContext,
) {
    <a href="../messaging/version.md#messaging_version">version</a>.validate_version();
    <a href="../messaging/mydata_policies.md#messaging_mydata_policies_validate_identity">validate_identity</a>(group, <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>, id);
    <b>assert</b>!(group.has_permission&lt;Messaging, MessagingReader&gt;(ctx.sender()), <a href="../messaging/mydata_policies.md#messaging_mydata_policies_ENotPermitted">ENotPermitted</a>);
}
</code></pre>



</details>
