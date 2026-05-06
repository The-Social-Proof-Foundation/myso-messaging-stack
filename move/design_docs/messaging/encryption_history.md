
<a name="messaging_encryption_history"></a>

# Module `messaging::encryption_history`

Module: encryption_history

Internal module for envelope encryption key management.
Stores encrypted DEKs (Data Encryption Keys) with version tracking for key rotation.

<code><a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a></code> is a derived object from <code>MessagingNamespace</code>, enabling
deterministic address derivation for MyData encryption namespacing.

Uses client-provided UUIDs for derivation, enabling predictable group IDs
for single-transaction encryption with MyData.

All public entry points are in the <code><a href="../messaging/messaging.md#messaging_messaging">messaging</a></code> module:
- <code>messaging::create_group</code> - creates group with encryption
- <code>messaging::rotate_encryption_key</code> - rotates keys


-  [Struct `EncryptionHistoryTag`](#messaging_encryption_history_EncryptionHistoryTag)
-  [Struct `PermissionedGroupTag`](#messaging_encryption_history_PermissionedGroupTag)
-  [Struct `EncryptionKeyRotator`](#messaging_encryption_history_EncryptionKeyRotator)
-  [Struct `EncryptionHistory`](#messaging_encryption_history_EncryptionHistory)
-  [Struct `EncryptionHistoryCreated`](#messaging_encryption_history_EncryptionHistoryCreated)
-  [Struct `EncryptionKeyRotated`](#messaging_encryption_history_EncryptionKeyRotated)
-  [Constants](#@Constants_0)
-  [Function `new`](#messaging_encryption_history_new)
    -  [Parameters](#@Parameters_1)
    -  [Returns](#@Returns_2)
    -  [Aborts](#@Aborts_3)
-  [Function `rotate_key`](#messaging_encryption_history_rotate_key)
    -  [Parameters](#@Parameters_4)
    -  [Aborts](#@Aborts_5)
-  [Function `permissions_group_tag`](#messaging_encryption_history_permissions_group_tag)
    -  [Parameters](#@Parameters_6)
    -  [Returns](#@Returns_7)
-  [Function `group_id`](#messaging_encryption_history_group_id)
    -  [Parameters](#@Parameters_8)
    -  [Returns](#@Returns_9)
-  [Function `uuid`](#messaging_encryption_history_uuid)
    -  [Parameters](#@Parameters_10)
    -  [Returns](#@Returns_11)
-  [Function `current_key_version`](#messaging_encryption_history_current_key_version)
    -  [Parameters](#@Parameters_12)
    -  [Returns](#@Returns_13)
-  [Function `encrypted_key`](#messaging_encryption_history_encrypted_key)
    -  [Parameters](#@Parameters_14)
    -  [Returns](#@Returns_15)
    -  [Aborts](#@Aborts_16)
-  [Function `current_encrypted_key`](#messaging_encryption_history_current_encrypted_key)
    -  [Parameters](#@Parameters_17)
    -  [Returns](#@Returns_18)


<pre><code><b>use</b> <a href="../dependencies/std/address.md#std_address">std::address</a>;
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
<b>use</b> <a href="../dependencies/myso/table.md#myso_table">myso::table</a>;
<b>use</b> <a href="../dependencies/myso/table_vec.md#myso_table_vec">myso::table_vec</a>;
<b>use</b> <a href="../dependencies/myso/transfer.md#myso_transfer">myso::transfer</a>;
<b>use</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context">myso::tx_context</a>;
<b>use</b> <a href="../dependencies/myso/vec_map.md#myso_vec_map">myso::vec_map</a>;
</code></pre>



<a name="messaging_encryption_history_EncryptionHistoryTag"></a>

## Struct `EncryptionHistoryTag`

Key for deriving <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a></code> address from <code>MessagingNamespace</code>.
Uses client-provided UUID (String) for predictable address derivation.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistoryTag">EncryptionHistoryTag</a> <b>has</b> <b>copy</b>, drop, store
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code>0: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a></code>
</dt>
<dd>
</dd>
</dl>


</details>

<a name="messaging_encryption_history_PermissionedGroupTag"></a>

## Struct `PermissionedGroupTag`

Key for deriving <code>PermissionedGroup&lt;Messaging&gt;</code> address from <code>MessagingNamespace</code>.
Uses client-provided UUID (String) for predictable address derivation.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_PermissionedGroupTag">PermissionedGroupTag</a> <b>has</b> <b>copy</b>, drop, store
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code>0: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a></code>
</dt>
<dd>
</dd>
</dl>


</details>

<a name="messaging_encryption_history_EncryptionKeyRotator"></a>

## Struct `EncryptionKeyRotator`

Permission to rotate encryption keys. Auto-granted to group creator.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionKeyRotator">EncryptionKeyRotator</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_encryption_history_EncryptionHistory"></a>

## Struct `EncryptionHistory`

Encrypted key history for a messaging group.
Derived object from <code>MessagingNamespace</code> with 1:1 relationship to <code>PermissionedGroup&lt;Messaging&gt;</code>.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a> <b>has</b> key, store
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
<code><a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a></code>
</dt>
<dd>
 Associated <code>PermissionedGroup&lt;Messaging&gt;</code> ID.
</dd>
<dt>
<code><a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a></code>
</dt>
<dd>
 UUID used for derivation.
</dd>
<dt>
<code>encrypted_keys: <a href="../dependencies/myso/table_vec.md#myso_table_vec_TableVec">myso::table_vec::TableVec</a>&lt;vector&lt;u8&gt;&gt;</code>
</dt>
<dd>
 Versioned encrypted DEKs. Index = version number.
 Each entry is MyData <code>EncryptedObject</code> bytes.
</dd>
</dl>


</details>

<a name="messaging_encryption_history_EncryptionHistoryCreated"></a>

## Struct `EncryptionHistoryCreated`

Emitted when a new EncryptionHistory is created.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistoryCreated">EncryptionHistoryCreated</a> <b>has</b> <b>copy</b>, drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code>encryption_history_id: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a></code>
</dt>
<dd>
 ID of the created EncryptionHistory.
</dd>
<dt>
<code><a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a></code>
</dt>
<dd>
 ID of the associated PermissionedGroup<Messaging>.
</dd>
<dt>
<code><a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a></code>
</dt>
<dd>
 UUID used for derivation.
</dd>
<dt>
<code>initial_encrypted_dek: vector&lt;u8&gt;</code>
</dt>
<dd>
 Initial encrypted DEK bytes.
</dd>
</dl>


</details>

<a name="messaging_encryption_history_EncryptionKeyRotated"></a>

## Struct `EncryptionKeyRotated`

Emitted when an encryption key is rotated.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionKeyRotated">EncryptionKeyRotated</a> <b>has</b> <b>copy</b>, drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code>encryption_history_id: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a></code>
</dt>
<dd>
 ID of the EncryptionHistory.
</dd>
<dt>
<code><a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a></code>
</dt>
<dd>
 ID of the associated PermissionedGroup<Messaging>.
</dd>
<dt>
<code>new_key_version: u64</code>
</dt>
<dd>
 New key version (0-indexed).
</dd>
<dt>
<code>new_encrypted_dek: vector&lt;u8&gt;</code>
</dt>
<dd>
 New encrypted DEK bytes.
</dd>
</dl>


</details>

<a name="@Constants_0"></a>

## Constants


<a name="messaging_encryption_history_EEncryptionHistoryAlreadyExists"></a>



<pre><code><b>const</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptionHistoryAlreadyExists">EEncryptionHistoryAlreadyExists</a>: u64 = 0;
</code></pre>



<a name="messaging_encryption_history_EKeyVersionNotFound"></a>



<pre><code><b>const</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EKeyVersionNotFound">EKeyVersionNotFound</a>: u64 = 1;
</code></pre>



<a name="messaging_encryption_history_EEncryptedDEKTooLarge"></a>



<pre><code><b>const</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptedDEKTooLarge">EEncryptedDEKTooLarge</a>: u64 = 2;
</code></pre>



<a name="messaging_encryption_history_MAX_ENCRYPTED_DEK_BYTES"></a>

Maximum allowed size for encrypted DEK bytes.

Accommodates a BCS-serialized MyData EncryptedObject containing:
- AES-256-GCM key (32 bytes) encrypted with AES-256-GCM will result in 48 bytes
- potentially AAD (additional authenticated data) - variable size, typically 16-32 bytes
- MyData package ID (32 bytes)
- Identity bytes: Creator's MySo address (32 bytes) + nonce (up to 32 bytes)
- services: vector((address (32 bytes), weight (1 byte))) - typically 2-3 entries
- Encrypted key shares - {
nonce(96 bytes),
encryptedShares (vector(32 bytes each)),
encryptedRandomness (32 bytes)
}


<pre><code><b>const</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_MAX_ENCRYPTED_DEK_BYTES">MAX_ENCRYPTED_DEK_BYTES</a>: u64 = 1024;
</code></pre>



<a name="messaging_encryption_history_new"></a>

## Function `new`

Creates a new <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a></code> derived from the namespace.
Uses <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistoryTag">EncryptionHistoryTag</a>(<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>)</code> as the derivation key.


<a name="@Parameters_1"></a>

### Parameters

- <code>namespace_uid</code>: Mutable reference to the MessagingNamespace UID
- <code><a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a></code>: Client-provided UUID for deterministic address derivation
- <code><a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a></code>: ID of the associated PermissionedGroup<Messaging>
- <code>initial_encrypted_dek</code>: Initial MyData-encrypted DEK bytes
- <code>ctx</code>: Transaction context


<a name="@Returns_2"></a>

### Returns

A new <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a></code> object.


<a name="@Aborts_3"></a>

### Aborts

- <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptionHistoryAlreadyExists">EEncryptionHistoryAlreadyExists</a></code>: if derived address is already claimed (duplicate UUID)
- <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptedDEKTooLarge">EEncryptedDEKTooLarge</a></code>: if the initial DEK exceeds maximum size


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_new">new</a>(namespace_uid: &<b>mut</b> <a href="../dependencies/myso/object.md#myso_object_UID">myso::object::UID</a>, <a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, <a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a>, initial_encrypted_dek: vector&lt;u8&gt;, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>): <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_new">new</a>(
    namespace_uid: &<b>mut</b> UID,
    <a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>: String,
    <a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>: ID,
    initial_encrypted_dek: vector&lt;u8&gt;,
    ctx: &<b>mut</b> TxContext,
): <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a> {
    <b>assert</b>!(
        !derived_object::exists(namespace_uid, <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistoryTag">EncryptionHistoryTag</a>(<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>)),
        <a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptionHistoryAlreadyExists">EEncryptionHistoryAlreadyExists</a>,
    );
    <b>assert</b>!(initial_encrypted_dek.length() &lt;= <a href="../messaging/encryption_history.md#messaging_encryption_history_MAX_ENCRYPTED_DEK_BYTES">MAX_ENCRYPTED_DEK_BYTES</a>, <a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptedDEKTooLarge">EEncryptedDEKTooLarge</a>);
    <b>let</b> <b>mut</b> encrypted_keys = table_vec::empty&lt;vector&lt;u8&gt;&gt;(ctx);
    encrypted_keys.push_back(initial_encrypted_dek);
    <b>let</b> <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a> = <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a> {
        id: derived_object::claim(
            namespace_uid,
            <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistoryTag">EncryptionHistoryTag</a>(<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>),
        ),
        <a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>,
        <a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>,
        encrypted_keys,
    };
    event::emit(<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistoryCreated">EncryptionHistoryCreated</a> {
        encryption_history_id: object::id(&<a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>),
        <a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>,
        <a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>: <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>.<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>,
        initial_encrypted_dek,
    });
    <a href="../messaging/encryption_history.md#messaging_encryption_history">encryption_history</a>
}
</code></pre>



</details>

<a name="messaging_encryption_history_rotate_key"></a>

## Function `rotate_key`

Appends a new encrypted DEK. Caller must verify permissions.


<a name="@Parameters_4"></a>

### Parameters

- <code>self</code>: Mutable reference to the EncryptionHistory
- <code>new_encrypted_dek</code>: New MyData-encrypted DEK bytes


<a name="@Aborts_5"></a>

### Aborts

- <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptedDEKTooLarge">EEncryptedDEKTooLarge</a></code>: if the new DEK exceeds maximum size


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_rotate_key">rotate_key</a>(self: &<b>mut</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>, new_encrypted_dek: vector&lt;u8&gt;)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_rotate_key">rotate_key</a>(self: &<b>mut</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a>, new_encrypted_dek: vector&lt;u8&gt;) {
    <b>assert</b>!(new_encrypted_dek.length() &lt;= <a href="../messaging/encryption_history.md#messaging_encryption_history_MAX_ENCRYPTED_DEK_BYTES">MAX_ENCRYPTED_DEK_BYTES</a>, <a href="../messaging/encryption_history.md#messaging_encryption_history_EEncryptedDEKTooLarge">EEncryptedDEKTooLarge</a>);
    self.encrypted_keys.push_back(new_encrypted_dek);
    event::emit(<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionKeyRotated">EncryptionKeyRotated</a> {
        encryption_history_id: object::id(self),
        <a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>: self.<a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>,
        new_key_version: self.encrypted_keys.length() - 1,
        new_encrypted_dek,
    });
}
</code></pre>



</details>

<a name="messaging_encryption_history_permissions_group_tag"></a>

## Function `permissions_group_tag`

Returns the <code><a href="../messaging/encryption_history.md#messaging_encryption_history_PermissionedGroupTag">PermissionedGroupTag</a></code> for address derivation.


<a name="@Parameters_6"></a>

### Parameters

- <code><a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a></code>: Client-provided UUID for deterministic address derivation


<a name="@Returns_7"></a>

### Returns

A <code><a href="../messaging/encryption_history.md#messaging_encryption_history_PermissionedGroupTag">PermissionedGroupTag</a></code> wrapping the UUID.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_permissions_group_tag">permissions_group_tag</a>(<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>): <a href="../messaging/encryption_history.md#messaging_encryption_history_PermissionedGroupTag">messaging::encryption_history::PermissionedGroupTag</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_permissions_group_tag">permissions_group_tag</a>(<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>: String): <a href="../messaging/encryption_history.md#messaging_encryption_history_PermissionedGroupTag">PermissionedGroupTag</a> {
    <a href="../messaging/encryption_history.md#messaging_encryption_history_PermissionedGroupTag">PermissionedGroupTag</a>(<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>)
}
</code></pre>



</details>

<a name="messaging_encryption_history_group_id"></a>

## Function `group_id`

Returns the associated <code>PermissionedGroup&lt;Messaging&gt;</code> ID.


<a name="@Parameters_8"></a>

### Parameters

- <code>self</code>: Reference to the EncryptionHistory


<a name="@Returns_9"></a>

### Returns

The group ID.


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>): <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a>): ID {
    self.<a href="../messaging/encryption_history.md#messaging_encryption_history_group_id">group_id</a>
}
</code></pre>



</details>

<a name="messaging_encryption_history_uuid"></a>

## Function `uuid`

Returns the UUID used for derivation.


<a name="@Parameters_10"></a>

### Parameters

- <code>self</code>: Reference to the EncryptionHistory


<a name="@Returns_11"></a>

### Returns

The UUID string.


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>): <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a>): String {
    self.<a href="../messaging/encryption_history.md#messaging_encryption_history_uuid">uuid</a>
}
</code></pre>



</details>

<a name="messaging_encryption_history_current_key_version"></a>

## Function `current_key_version`

Returns the current key version (0-indexed).


<a name="@Parameters_12"></a>

### Parameters

- <code>self</code>: Reference to the EncryptionHistory


<a name="@Returns_13"></a>

### Returns

The current (latest) key version.


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_current_key_version">current_key_version</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>): u64
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_current_key_version">current_key_version</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a>): u64 {
    self.encrypted_keys.length() - 1
}
</code></pre>



</details>

<a name="messaging_encryption_history_encrypted_key"></a>

## Function `encrypted_key`

Returns the encrypted DEK for a specific version.


<a name="@Parameters_14"></a>

### Parameters

- <code>self</code>: Reference to the EncryptionHistory
- <code><a href="../messaging/version.md#messaging_version">version</a></code>: The key version to retrieve (0-indexed)


<a name="@Returns_15"></a>

### Returns

Reference to the encrypted DEK bytes.


<a name="@Aborts_16"></a>

### Aborts

- <code><a href="../messaging/encryption_history.md#messaging_encryption_history_EKeyVersionNotFound">EKeyVersionNotFound</a></code>: if the version doesn't exist


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_encrypted_key">encrypted_key</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>, <a href="../messaging/version.md#messaging_version">version</a>: u64): &vector&lt;u8&gt;
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_encrypted_key">encrypted_key</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a>, <a href="../messaging/version.md#messaging_version">version</a>: u64): &vector&lt;u8&gt; {
    <b>assert</b>!(<a href="../messaging/version.md#messaging_version">version</a> &lt; self.encrypted_keys.length(), <a href="../messaging/encryption_history.md#messaging_encryption_history_EKeyVersionNotFound">EKeyVersionNotFound</a>);
    self.encrypted_keys.borrow(<a href="../messaging/version.md#messaging_version">version</a>)
}
</code></pre>



</details>

<a name="messaging_encryption_history_current_encrypted_key"></a>

## Function `current_encrypted_key`

Returns the encrypted DEK for the current (latest) version.


<a name="@Parameters_17"></a>

### Parameters

- <code>self</code>: Reference to the EncryptionHistory


<a name="@Returns_18"></a>

### Returns

Reference to the current encrypted DEK bytes.


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_current_encrypted_key">current_encrypted_key</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">messaging::encryption_history::EncryptionHistory</a>): &vector&lt;u8&gt;
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/encryption_history.md#messaging_encryption_history_current_encrypted_key">current_encrypted_key</a>(self: &<a href="../messaging/encryption_history.md#messaging_encryption_history_EncryptionHistory">EncryptionHistory</a>): &vector&lt;u8&gt; {
    self.<a href="../messaging/encryption_history.md#messaging_encryption_history_encrypted_key">encrypted_key</a>(self.<a href="../messaging/encryption_history.md#messaging_encryption_history_current_key_version">current_key_version</a>())
}
</code></pre>



</details>
