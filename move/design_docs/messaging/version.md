
<a name="messaging_version"></a>

# Module `messaging::version`



-  [Struct `VERSION`](#messaging_version_VERSION)
-  [Struct `Version`](#messaging_version_Version)
-  [Constants](#@Constants_0)
-  [Function `init`](#messaging_version_init)
-  [Function `version`](#messaging_version_version)
-  [Function `package_version`](#messaging_version_package_version)
-  [Function `validate_version`](#messaging_version_validate_version)


<pre><code><b>use</b> <a href="../dependencies/std/address.md#std_address">std::address</a>;
<b>use</b> <a href="../dependencies/std/ascii.md#std_ascii">std::ascii</a>;
<b>use</b> <a href="../dependencies/std/bcs.md#std_bcs">std::bcs</a>;
<b>use</b> <a href="../dependencies/std/option.md#std_option">std::option</a>;
<b>use</b> <a href="../dependencies/std/string.md#std_string">std::string</a>;
<b>use</b> <a href="../dependencies/std/type_name.md#std_type_name">std::type_name</a>;
<b>use</b> <a href="../dependencies/std/vector.md#std_vector">std::vector</a>;
<b>use</b> <a href="../dependencies/myso/address.md#myso_address">myso::address</a>;
<b>use</b> <a href="../dependencies/myso/hex.md#myso_hex">myso::hex</a>;
<b>use</b> <a href="../dependencies/myso/object.md#myso_object">myso::object</a>;
<b>use</b> <a href="../dependencies/myso/package.md#myso_package">myso::package</a>;
<b>use</b> <a href="../dependencies/myso/party.md#myso_party">myso::party</a>;
<b>use</b> <a href="../dependencies/myso/transfer.md#myso_transfer">myso::transfer</a>;
<b>use</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context">myso::tx_context</a>;
<b>use</b> <a href="../dependencies/myso/types.md#myso_types">myso::types</a>;
<b>use</b> <a href="../dependencies/myso/vec_map.md#myso_vec_map">myso::vec_map</a>;
</code></pre>



<a name="messaging_version_VERSION"></a>

## Struct `VERSION`



<pre><code><b>public</b> <b>struct</b> <a href="../messaging/version.md#messaging_version_VERSION">VERSION</a> <b>has</b> drop
</code></pre>



<details>
<summary>Fields</summary>


<dl>
</dl>


</details>

<a name="messaging_version_Version"></a>

## Struct `Version`

Shared object that keeps track of the package version


<pre><code><b>public</b> <b>struct</b> <a href="../messaging/version.md#messaging_version_Version">Version</a> <b>has</b> key
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
<code><a href="../messaging/version.md#messaging_version">version</a>: u64</code>
</dt>
<dd>
</dd>
</dl>


</details>

<a name="@Constants_0"></a>

## Constants


<a name="messaging_version_EInvalidVersion"></a>



<pre><code><b>const</b> <a href="../messaging/version.md#messaging_version_EInvalidVersion">EInvalidVersion</a>: u64 = 0;
</code></pre>



<a name="messaging_version_PACKAGE_VERSION"></a>

Current version of the package, starting from version 1


<pre><code><b>const</b> <a href="../messaging/version.md#messaging_version_PACKAGE_VERSION">PACKAGE_VERSION</a>: u64 = 1;
</code></pre>



<a name="messaging_version_init"></a>

## Function `init`



<pre><code><b>fun</b> <a href="../messaging/version.md#messaging_version_init">init</a>(otw: <a href="../messaging/version.md#messaging_version_VERSION">messaging::version::VERSION</a>, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>fun</b> <a href="../messaging/version.md#messaging_version_init">init</a>(otw: <a href="../messaging/version.md#messaging_version_VERSION">VERSION</a>, ctx: &<b>mut</b> TxContext) {
    package::claim_and_keep(otw, ctx);
    transfer::share_object(<a href="../messaging/version.md#messaging_version_Version">Version</a> {
        id: object::new(ctx),
        <a href="../messaging/version.md#messaging_version">version</a>: <a href="../messaging/version.md#messaging_version_PACKAGE_VERSION">PACKAGE_VERSION</a>,
    });
}
</code></pre>



</details>

<a name="messaging_version_version"></a>

## Function `version`



<pre><code><b>public</b> <b>fun</b> <a href="../messaging/version.md#messaging_version">version</a>(self: &<a href="../messaging/version.md#messaging_version_Version">messaging::version::Version</a>): u64
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/version.md#messaging_version">version</a>(self: &<a href="../messaging/version.md#messaging_version_Version">Version</a>): u64 {
    self.<a href="../messaging/version.md#messaging_version">version</a>
}
</code></pre>



</details>

<a name="messaging_version_package_version"></a>

## Function `package_version`



<pre><code><b>public</b> <b>fun</b> <a href="../messaging/version.md#messaging_version_package_version">package_version</a>(): u64
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../messaging/version.md#messaging_version_package_version">package_version</a>(): u64 {
    <a href="../messaging/version.md#messaging_version_PACKAGE_VERSION">PACKAGE_VERSION</a>
}
</code></pre>



</details>

<a name="messaging_version_validate_version"></a>

## Function `validate_version`



<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/version.md#messaging_version_validate_version">validate_version</a>(self: &<a href="../messaging/version.md#messaging_version_Version">messaging::version::Version</a>)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../messaging/version.md#messaging_version_validate_version">validate_version</a>(self: &<a href="../messaging/version.md#messaging_version_Version">Version</a>) {
    <b>assert</b>!(self.<a href="../messaging/version.md#messaging_version">version</a> == <a href="../messaging/version.md#messaging_version_PACKAGE_VERSION">PACKAGE_VERSION</a>, <a href="../messaging/version.md#messaging_version_EInvalidVersion">EInvalidVersion</a>);
}
</code></pre>



</details>
