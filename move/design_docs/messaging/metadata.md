
<a name="messaging_metadata"></a>

# Module `messaging::metadata`

Module: metadata

Metadata associated with a messaging group.
Stored as a dynamic field on the <code>PermissionedGroup&lt;Messaging&gt;</code> object
via the <code>GroupManager</code> actor.

Immutable fields (set at creation, never changed):
- <code><a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a></code>: Client-provided UUID
- <code><a href="../messaging/metadata.md#messaging_metadata_creator">creator</a></code>: Address of the group creator

Mutable fields (editable by <code>MetadataAdmin</code> holders):
- <code><a href="../messaging/metadata.md#messaging_metadata_name">name</a></code>: Human-readable group name
- <code><a href="../messaging/metadata.md#messaging_metadata_data">data</a></code>: Key-value map for arbitrary extension data


-  [Struct `MetadataKey`](#messaging_metadata_MetadataKey)
-  [Struct `Metadata`](#messaging_metadata_Metadata)
-  [Constants](#@Constants_0)
-  [Function `key`](#messaging_metadata_key)
-  [Function `new`](#messaging_metadata_new)
    -  [Parameters](#@Parameters_1)
    -  [Aborts](#@Aborts_2)
-  [Function `name`](#messaging_metadata_name)
-  [Function `uuid`](#messaging_metadata_uuid)
-  [Function `creator`](#messaging_metadata_creator)
-  [Function `data`](#messaging_metadata_data)
-  [Function `set_name`](#messaging_metadata_set_name)
    -  [Aborts](#@Aborts_3)
-  [Function `insert_data`](#messaging_metadata_insert_data)
    -  [Aborts](#@Aborts_4)
-  [Function `remove_data`](#messaging_metadata_remove_data)
    -  [Returns](#@Returns_5)


<pre><code><b>use</b> <a href="../dependencies/std/ascii.md#std_ascii">std::ascii</a>;
<b>use</b> <a href="../dependencies/std/option.md#std_option">std::option</a>;
<b>use</b> <a href="../dependencies/std/string.md#std_string">std::string</a>;
<b>use</b> <a href="../dependencies/std/vector.md#std_vector">std::vector</a>;
<b>use</b> <a href="../dependencies/myso/vec_map.md#myso_vec_map">myso::vec_map</a>;
</code></pre>



<a name="messaging_metadata_MetadataKey"></a>

## Struct `MetadataKey`

Dynamic field key for Metadata on a PermissionedGroup<Messaging>.
Versioned by schema version — bumped when the Metadata struct changes.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/metadata.md#messaging_metadata_MetadataKey">MetadataKey</a> <b>has</b> <b>copy</b>, drop, store
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code>0: u64</code>
</dt>
<dd>
</dd>
</dl>


</details>

<a name="messaging_metadata_Metadata"></a>

## Struct `Metadata`

Metadata associated with a messaging group.


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a> <b>has</b> <b>copy</b>, drop, store
</code></pre>



<details>
<summary>Fields</summary>


<dl>
<dt>
<code><a href="../messaging/metadata.md#messaging_metadata_name">name</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a></code>
</dt>
<dd>
</dd>
<dt>
<code><a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a></code>
</dt>
<dd>
</dd>
<dt>
<code><a href="../messaging/metadata.md#messaging_metadata_creator">creator</a>: <b>address</b></code>
</dt>
<dd>
</dd>
<dt>
<code><a href="../messaging/metadata.md#messaging_metadata_data">data</a>: <a href="../dependencies/myso/vec_map.md#myso_vec_map_VecMap">myso::vec_map::VecMap</a>&lt;<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>&gt;</code>
</dt>
<dd>
</dd>
</dl>


</details>

<a name="@Constants_0"></a>

## Constants


<a name="messaging_metadata_ENameTooLong"></a>

Group name exceeds the maximum allowed length.


<pre><code><b>const</b> <a href="../messaging/metadata.md#messaging_metadata_ENameTooLong">ENameTooLong</a>: u64 = 0;
</code></pre>



<a name="messaging_metadata_EDataKeyTooLong"></a>

Data key exceeds the maximum allowed length.


<pre><code><b>const</b> <a href="../messaging/metadata.md#messaging_metadata_EDataKeyTooLong">EDataKeyTooLong</a>: u64 = 1;
</code></pre>



<a name="messaging_metadata_EDataValueTooLong"></a>

Data value exceeds the maximum allowed length.


<pre><code><b>const</b> <a href="../messaging/metadata.md#messaging_metadata_EDataValueTooLong">EDataValueTooLong</a>: u64 = 2;
</code></pre>



<a name="messaging_metadata_METADATA_SCHEMA_VERSION"></a>

Schema version for the Metadata struct. Bumped when the struct changes.


<pre><code><b>const</b> <a href="../messaging/metadata.md#messaging_metadata_METADATA_SCHEMA_VERSION">METADATA_SCHEMA_VERSION</a>: u64 = 1;
</code></pre>



<a name="messaging_metadata_MAX_NAME_LENGTH"></a>

Maximum length for the group name (in bytes).


<pre><code><b>const</b> <a href="../messaging/metadata.md#messaging_metadata_MAX_NAME_LENGTH">MAX_NAME_LENGTH</a>: u64 = 128;
</code></pre>



<a name="messaging_metadata_MAX_DATA_KEY_LENGTH"></a>

Maximum length for a data key (in bytes).


<pre><code><b>const</b> <a href="../messaging/metadata.md#messaging_metadata_MAX_DATA_KEY_LENGTH">MAX_DATA_KEY_LENGTH</a>: u64 = 64;
</code></pre>



<a name="messaging_metadata_MAX_DATA_VALUE_LENGTH"></a>

Maximum length for a data value (in bytes).


<pre><code><b>const</b> <a href="../messaging/metadata.md#messaging_metadata_MAX_DATA_VALUE_LENGTH">MAX_DATA_VALUE_LENGTH</a>: u64 = 256;
</code></pre>



<a name="messaging_metadata_key"></a>

## Function `key`

Returns the dynamic field key for the current schema version.


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_key">key</a>(): <a href="../messaging/metadata.md#messaging_metadata_MetadataKey">messaging::metadata::MetadataKey</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_key">key</a>(): <a href="../messaging/metadata.md#messaging_metadata_MetadataKey">MetadataKey</a> { <a href="../messaging/metadata.md#messaging_metadata_MetadataKey">MetadataKey</a>(<a href="../messaging/metadata.md#messaging_metadata_METADATA_SCHEMA_VERSION">METADATA_SCHEMA_VERSION</a>) }
</code></pre>



</details>

<a name="messaging_metadata_new"></a>

## Function `new`

Creates a new Metadata instance.


<a name="@Parameters_1"></a>

### Parameters

- <code><a href="../messaging/metadata.md#messaging_metadata_name">name</a></code>: Human-readable group name
- <code><a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a></code>: Client-provided UUID
- <code><a href="../messaging/metadata.md#messaging_metadata_creator">creator</a></code>: Address of the group creator


<a name="@Aborts_2"></a>

### Aborts

- <code><a href="../messaging/metadata.md#messaging_metadata_ENameTooLong">ENameTooLong</a></code>: if name exceeds MAX_NAME_LENGTH


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_new">new</a>(<a href="../messaging/metadata.md#messaging_metadata_name">name</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, <a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, <a href="../messaging/metadata.md#messaging_metadata_creator">creator</a>: <b>address</b>): <a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_new">new</a>(
    <a href="../messaging/metadata.md#messaging_metadata_name">name</a>: String,
    <a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a>: String,
    <a href="../messaging/metadata.md#messaging_metadata_creator">creator</a>: <b>address</b>,
): <a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a> {
    <b>assert</b>!(<a href="../messaging/metadata.md#messaging_metadata_name">name</a>.length() &lt;= <a href="../messaging/metadata.md#messaging_metadata_MAX_NAME_LENGTH">MAX_NAME_LENGTH</a>, <a href="../messaging/metadata.md#messaging_metadata_ENameTooLong">ENameTooLong</a>);
    <a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a> { <a href="../messaging/metadata.md#messaging_metadata_name">name</a>, <a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a>, <a href="../messaging/metadata.md#messaging_metadata_creator">creator</a>, <a href="../messaging/metadata.md#messaging_metadata_data">data</a>: vec_map::empty() }
}
</code></pre>



</details>

<a name="messaging_metadata_name"></a>

## Function `name`



<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_name">name</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>): &<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_name">name</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a>): &String { &self.<a href="../messaging/metadata.md#messaging_metadata_name">name</a> }
</code></pre>



</details>

<a name="messaging_metadata_uuid"></a>

## Function `uuid`



<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>): &<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a>): &String { &self.<a href="../messaging/metadata.md#messaging_metadata_uuid">uuid</a> }
</code></pre>



</details>

<a name="messaging_metadata_creator"></a>

## Function `creator`



<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_creator">creator</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>): <b>address</b>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_creator">creator</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a>): <b>address</b> { self.<a href="../messaging/metadata.md#messaging_metadata_creator">creator</a> }
</code></pre>



</details>

<a name="messaging_metadata_data"></a>

## Function `data`



<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_data">data</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>): &<a href="../dependencies/myso/vec_map.md#myso_vec_map_VecMap">myso::vec_map::VecMap</a>&lt;<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>&gt;
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_data">data</a>(self: &<a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a>): &VecMap&lt;String, String&gt; { &self.<a href="../messaging/metadata.md#messaging_metadata_data">data</a> }
</code></pre>



</details>

<a name="messaging_metadata_set_name"></a>

## Function `set_name`

Sets the group name.


<a name="@Aborts_3"></a>

### Aborts

- <code><a href="../messaging/metadata.md#messaging_metadata_ENameTooLong">ENameTooLong</a></code>: if name exceeds MAX_NAME_LENGTH


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_set_name">set_name</a>(self: &<b>mut</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>, <a href="../messaging/metadata.md#messaging_metadata_name">name</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_set_name">set_name</a>(self: &<b>mut</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a>, <a href="../messaging/metadata.md#messaging_metadata_name">name</a>: String) {
    <b>assert</b>!(<a href="../messaging/metadata.md#messaging_metadata_name">name</a>.length() &lt;= <a href="../messaging/metadata.md#messaging_metadata_MAX_NAME_LENGTH">MAX_NAME_LENGTH</a>, <a href="../messaging/metadata.md#messaging_metadata_ENameTooLong">ENameTooLong</a>);
    self.<a href="../messaging/metadata.md#messaging_metadata_name">name</a> = <a href="../messaging/metadata.md#messaging_metadata_name">name</a>;
}
</code></pre>



</details>

<a name="messaging_metadata_insert_data"></a>

## Function `insert_data`

Inserts a key-value pair into the data map.


<a name="@Aborts_4"></a>

### Aborts

- <code><a href="../messaging/metadata.md#messaging_metadata_EDataKeyTooLong">EDataKeyTooLong</a></code>: if key exceeds MAX_DATA_KEY_LENGTH
- <code><a href="../messaging/metadata.md#messaging_metadata_EDataValueTooLong">EDataValueTooLong</a></code>: if value exceeds MAX_DATA_VALUE_LENGTH


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_insert_data">insert_data</a>(self: &<b>mut</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>, <a href="../messaging/metadata.md#messaging_metadata_key">key</a>: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, value: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_insert_data">insert_data</a>(self: &<b>mut</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a>, <a href="../messaging/metadata.md#messaging_metadata_key">key</a>: String, value: String) {
    <b>assert</b>!(<a href="../messaging/metadata.md#messaging_metadata_key">key</a>.length() &lt;= <a href="../messaging/metadata.md#messaging_metadata_MAX_DATA_KEY_LENGTH">MAX_DATA_KEY_LENGTH</a>, <a href="../messaging/metadata.md#messaging_metadata_EDataKeyTooLong">EDataKeyTooLong</a>);
    <b>assert</b>!(value.length() &lt;= <a href="../messaging/metadata.md#messaging_metadata_MAX_DATA_VALUE_LENGTH">MAX_DATA_VALUE_LENGTH</a>, <a href="../messaging/metadata.md#messaging_metadata_EDataValueTooLong">EDataValueTooLong</a>);
    self.<a href="../messaging/metadata.md#messaging_metadata_data">data</a>.insert(<a href="../messaging/metadata.md#messaging_metadata_key">key</a>, value);
}
</code></pre>



</details>

<a name="messaging_metadata_remove_data"></a>

## Function `remove_data`

Removes a key-value pair from the data map.


<a name="@Returns_5"></a>

### Returns

The removed (key, value) tuple.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_remove_data">remove_data</a>(self: &<b>mut</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">messaging::metadata::Metadata</a>, <a href="../messaging/metadata.md#messaging_metadata_key">key</a>: &<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>): (<a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/metadata.md#messaging_metadata_remove_data">remove_data</a>(self: &<b>mut</b> <a href="../messaging/metadata.md#messaging_metadata_Metadata">Metadata</a>, <a href="../messaging/metadata.md#messaging_metadata_key">key</a>: &String): (String, String) {
    self.<a href="../messaging/metadata.md#messaging_metadata_data">data</a>.remove(<a href="../messaging/metadata.md#messaging_metadata_key">key</a>)
}
</code></pre>



</details>
