
<a name="permissioned_groups_display"></a>

# Module `permissioned_groups::display`

Module: display

Display support for <code>PermissionedGroup&lt;T&gt;</code> types.

Since <code>PermissionedGroup&lt;T&gt;</code> is defined in <code>permissioned_groups</code>, extending
packages cannot directly create <code>Display&lt;PermissionedGroup&lt;T&gt;&gt;</code>.


<a name="@Solution_0"></a>

### Solution


This module provides a shared <code><a href="../permissioned_groups/display.md#permissioned_groups_display_PermissionedGroupPublisher">PermissionedGroupPublisher</a></code> that holds the
<code>permissioned_groups</code> Publisher. Extending packages can call <code><a href="../permissioned_groups/display.md#permissioned_groups_display_setup_display">setup_display</a>&lt;T&gt;</code>
with their own Publisher to create <code>Display&lt;PermissionedGroup&lt;T&gt;&gt;</code>.


<a name="@Usage_1"></a>

### Usage


```move
module my_package::my_module;

use permissioned_groups::display::{Self, PermissionedGroupPublisher};
use myso::package::{Self, Publisher};

public struct MY_MODULE() has drop;
public struct MyWitness() has drop;

fun init(otw: MY_MODULE, ctx: &mut TxContext) {
let publisher = package::claim(otw, ctx);
// Transfer publisher to sender for later use with setup_display
transfer::public_transfer(publisher, ctx.sender());
}

/// Call this after init to set up Display for PermissionedGroup<MyWitness>.
public fun setup_group_display(
pg_publisher: &PermissionedGroupPublisher,
publisher: &Publisher,
ctx: &mut TxContext,
) {
display::setup_display<MyWitness>(
pg_publisher,
publisher,
b"My Group".to_string(),
b"A permissioned group".to_string(),
b"https://example.com/image.png".to_string(),
b"https://example.com".to_string(),
b"https://example.com/group/{id}".to_string(),
ctx,
);
}
```


    -  [Solution](#@Solution_0)
    -  [Usage](#@Usage_1)
-  [Struct `DISPLAY`](#permissioned_groups_display_DISPLAY)
-  [Struct `PermissionedGroupPublisher`](#permissioned_groups_display_PermissionedGroupPublisher)
-  [Constants](#@Constants_2)
-  [Function `init`](#permissioned_groups_display_init)
-  [Function `setup_display`](#permissioned_groups_display_setup_display)
    -  [Type Parameters](#@Type_Parameters_3)
    -  [Parameters](#@Parameters_4)
    -  [Aborts](#@Aborts_5)


<pre><code><b>use</b> <a href="../permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group">permissioned_groups::permissioned_group</a>;
<b>use</b> <a href="../permissioned_groups/permissions_table.md#permissioned_groups_permissions_table">permissioned_groups::permissions_table</a>;
<b>use</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap">permissioned_groups::unpause_cap</a>;
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
<b>use</b> <a href="../dependencies/myso/display.md#myso_display">myso::display</a>;
<b>use</b> <a href="../dependencies/myso/dynamic_field.md#myso_dynamic_field">myso::dynamic_field</a>;
<b>use</b> <a href="../dependencies/myso/event.md#myso_event">myso::event</a>;
<b>use</b> <a href="../dependencies/myso/hash.md#myso_hash">myso::hash</a>;
<b>use</b> <a href="../dependencies/myso/hex.md#myso_hex">myso::hex</a>;
<b>use</b> <a href="../dependencies/myso/object.md#myso_object">myso::object</a>;
<b>use</b> <a href="../dependencies/myso/package.md#myso_package">myso::package</a>;
<b>use</b> <a href="../dependencies/myso/party.md#myso_party">myso::party</a>;
<b>use</b> <a href="../dependencies/myso/transfer.md#myso_transfer">myso::transfer</a>;
<b>use</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context">myso::tx_context</a>;
<b>use</b> <a href="../dependencies/myso/types.md#myso_types">myso::types</a>;
<b>use</b> <a href="../dependencies/myso/vec_map.md#myso_vec_map">myso::vec_map</a>;
<b>use</b> <a href="../dependencies/myso/vec_set.md#myso_vec_set">myso::vec_set</a>;
</code></pre>



<a name="permissioned_groups_display_DISPLAY"></a>

## Struct `DISPLAY`

OTW for claiming Publisher and initializing PermissionedGroupPublisher.


<pre><code><b>public</b> <b>struct</b> <a href="../permissioned_groups/display.md#permissioned_groups_display_DISPLAY">DISPLAY</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="permissioned_groups_display_PermissionedGroupPublisher"></a>

## Struct `PermissionedGroupPublisher`

Shared object holding the <code>permissioned_groups</code> Publisher.
Used by extending packages to create <code>Display&lt;PermissionedGroup&lt;T&gt;&gt;</code>.


<pre><code><b>public</b> <b>struct</b> <a href="../permissioned_groups/display.md#permissioned_groups_display_PermissionedGroupPublisher">PermissionedGroupPublisher</a> <b>has</b> key
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
<code>publisher: <a href="../dependencies/myso/package.md#myso_package_Publisher">myso::package::Publisher</a></code>
</dt>
<dd>
</dd>
</dl>


</details>

<a name="@Constants_2"></a>

## Constants


<a name="permissioned_groups_display_ETypeNotFromModule"></a>

Type T is not from the same module as the publisher


<pre><code><b>const</b> <a href="../permissioned_groups/display.md#permissioned_groups_display_ETypeNotFromModule">ETypeNotFromModule</a>: u64 = 0;
</code></pre>



<a name="permissioned_groups_display_init"></a>

## Function `init`



<pre><code><b>fun</b> <a href="../permissioned_groups/display.md#permissioned_groups_display_init">init</a>(otw: <a href="../permissioned_groups/display.md#permissioned_groups_display_DISPLAY">permissioned_groups::display::DISPLAY</a>, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>fun</b> <a href="../permissioned_groups/display.md#permissioned_groups_display_init">init</a>(otw: <a href="../permissioned_groups/display.md#permissioned_groups_display_DISPLAY">DISPLAY</a>, ctx: &<b>mut</b> TxContext) {
    transfer::share_object(<a href="../permissioned_groups/display.md#permissioned_groups_display_PermissionedGroupPublisher">PermissionedGroupPublisher</a> {
        id: object::new(ctx),
        publisher: package::claim(otw, ctx),
    });
}
</code></pre>



</details>

<a name="permissioned_groups_display_setup_display"></a>

## Function `setup_display`

Creates a <code>Display&lt;PermissionedGroup&lt;T&gt;&gt;</code> using the shared publisher.
The caller must provide their own Publisher to prove they own the module
that defines type T. The Display is transferred to the transaction sender.


<a name="@Type_Parameters_3"></a>

### Type Parameters

- <code>T</code>: The witness type used with <code>PermissionedGroup&lt;T&gt;</code>


<a name="@Parameters_4"></a>

### Parameters

- <code>pg_publisher</code>: Reference to the shared PermissionedGroupPublisher
- <code>publisher</code>: Reference to the extending package's Publisher (proves ownership of T)
- <code>name</code>: Display name template
- <code>description</code>: Description template
- <code>image_url</code>: Static image URL for all groups of this type
- <code>project_url</code>: Project website URL
- <code>link</code>: Link template for viewing objects, use <code>{id}</code> for object ID interpolation
- <code>ctx</code>: Transaction context


<a name="@Aborts_5"></a>

### Aborts

- <code><a href="../permissioned_groups/display.md#permissioned_groups_display_ETypeNotFromModule">ETypeNotFromModule</a></code>: if type T is not from the same module as the publisher


<pre><code><b>public</b> <b>fun</b> <a href="../permissioned_groups/display.md#permissioned_groups_display_setup_display">setup_display</a>&lt;T: drop&gt;(pg_publisher: &<a href="../permissioned_groups/display.md#permissioned_groups_display_PermissionedGroupPublisher">permissioned_groups::display::PermissionedGroupPublisher</a>, publisher: &<a href="../dependencies/myso/package.md#myso_package_Publisher">myso::package::Publisher</a>, name: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, description: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, image_url: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, project_url: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, link: <a href="../dependencies/std/string.md#std_string_String">std::string::String</a>, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../permissioned_groups/display.md#permissioned_groups_display_setup_display">setup_display</a>&lt;T: drop&gt;(
    pg_publisher: &<a href="../permissioned_groups/display.md#permissioned_groups_display_PermissionedGroupPublisher">PermissionedGroupPublisher</a>,
    publisher: &Publisher,
    name: String,
    description: String,
    image_url: String,
    project_url: String,
    link: String,
    ctx: &<b>mut</b> TxContext,
) {
    <b>assert</b>!(publisher.from_module&lt;T&gt;(), <a href="../permissioned_groups/display.md#permissioned_groups_display_ETypeNotFromModule">ETypeNotFromModule</a>);
    <b>let</b> <b>mut</b> <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a> = display::new&lt;PermissionedGroup&lt;T&gt;&gt;(&pg_publisher.publisher, ctx);
    <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>.add(b"name".to_string(), name);
    <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>.add(b"description".to_string(), description);
    <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>.add(b"creator".to_string(), b"{creator}".to_string());
    <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>.add(b"image_url".to_string(), image_url);
    <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>.add(b"project_url".to_string(), project_url);
    <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>.add(b"link".to_string(), link);
    <a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>.update_version();
    transfer::public_transfer(<a href="../permissioned_groups/display.md#permissioned_groups_display">display</a>, ctx.sender());
}
</code></pre>



</details>
