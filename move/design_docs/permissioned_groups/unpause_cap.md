
<a name="permissioned_groups_unpause_cap"></a>

# Module `permissioned_groups::unpause_cap`

Module: unpause_cap

Capability required to unpause a <code>PermissionedGroup&lt;T&gt;</code>.
Returned by <code><a href="../permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_pause">permissioned_group::pause</a>()</code>.

The phantom <code>T</code> scopes the cap to the group's package type —
a cap from one package's group cannot unpause a different package's group.


<a name="@Usage_0"></a>

### Usage


**Emergency fix pattern (PTB):**
```
let cap = group.pause(ctx);
// fix permissions in the same PTB
group.unpause(cap, ctx);
```

**Archive pattern (messaging layer):**
```
// get uid before pausing
let uid = group.object_uid_mut(&group_manager.id);
// attach ArchiveStamp as a permanent marker
dynamic_field::add(uid, ArchiveStamp(), true);
// pause and immediately burn the cap — unpause is now impossible
let cap = group.pause(ctx);
unpause_cap::burn(cap);
// Alternative: transfer::public_freeze_object(cap)
//   — makes the cap immutable and un-passable by value
```


    -  [Usage](#@Usage_0)
-  [Struct `UnpauseCap`](#permissioned_groups_unpause_cap_UnpauseCap)
-  [Function `new`](#permissioned_groups_unpause_cap_new)
-  [Function `group_id`](#permissioned_groups_unpause_cap_group_id)
-  [Function `delete`](#permissioned_groups_unpause_cap_delete)
-  [Function `burn`](#permissioned_groups_unpause_cap_burn)


<pre><code><b>use</b> <a href="../dependencies/std/ascii.md#std_ascii">std::ascii</a>;
<b>use</b> <a href="../dependencies/std/bcs.md#std_bcs">std::bcs</a>;
<b>use</b> <a href="../dependencies/std/option.md#std_option">std::option</a>;
<b>use</b> <a href="../dependencies/std/string.md#std_string">std::string</a>;
<b>use</b> <a href="../dependencies/std/vector.md#std_vector">std::vector</a>;
<b>use</b> <a href="../dependencies/myso/address.md#myso_address">myso::address</a>;
<b>use</b> <a href="../dependencies/myso/hex.md#myso_hex">myso::hex</a>;
<b>use</b> <a href="../dependencies/myso/object.md#myso_object">myso::object</a>;
<b>use</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context">myso::tx_context</a>;
</code></pre>



<a name="permissioned_groups_unpause_cap_UnpauseCap"></a>

## Struct `UnpauseCap`

Owned capability required to unpause a <code>PermissionedGroup&lt;T&gt;</code>.
Has <code>store</code> so it can be wrapped or stored as a dynamic object field.


<pre><code><b>public</b> <b>struct</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a>&lt;<b>phantom</b> T&gt; <b>has</b> key, store
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
<code><a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a></code>
</dt>
<dd>
 ID of the group this cap belongs to.
 Checked in <code><a href="../permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_unpause">permissioned_group::unpause</a>()</code> to prevent cross-group misuse.
</dd>
</dl>


</details>

<a name="permissioned_groups_unpause_cap_new"></a>

## Function `new`

Creates a new <code><a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a></code> for the given group.
Called exclusively by <code><a href="../permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_pause">permissioned_group::pause</a>()</code>.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_new">new</a>&lt;T&gt;(<a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_group_id">group_id</a>: <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a>, ctx: &<b>mut</b> <a href="../dependencies/myso/tx_context.md#myso_tx_context_TxContext">myso::tx_context::TxContext</a>): <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">permissioned_groups::unpause_cap::UnpauseCap</a>&lt;T&gt;
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_new">new</a>&lt;T&gt;(<a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_group_id">group_id</a>: ID, ctx: &<b>mut</b> TxContext): <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a>&lt;T&gt; {
    <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a> { id: object::new(ctx), <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_group_id">group_id</a> }
}
</code></pre>



</details>

<a name="permissioned_groups_unpause_cap_group_id"></a>

## Function `group_id`

Returns the group ID this cap belongs to.
Used by <code><a href="../permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_unpause">permissioned_group::unpause</a>()</code> for mismatch check.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_group_id">group_id</a>&lt;T&gt;(cap: &<a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">permissioned_groups::unpause_cap::UnpauseCap</a>&lt;T&gt;): <a href="../dependencies/myso/object.md#myso_object_ID">myso::object::ID</a>
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_group_id">group_id</a>&lt;T&gt;(cap: &<a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a>&lt;T&gt;): ID {
    cap.<a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_group_id">group_id</a>
}
</code></pre>



</details>

<a name="permissioned_groups_unpause_cap_delete"></a>

## Function `delete`

Deletes the cap's UID, consuming it without unpausing.
Package-internal: only <code><a href="../permissioned_groups/permissioned_group.md#permissioned_groups_permissioned_group_unpause">permissioned_group::unpause</a>()</code> should call this.


<pre><code><b>public</b>(package) <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_delete">delete</a>&lt;T&gt;(cap: <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">permissioned_groups::unpause_cap::UnpauseCap</a>&lt;T&gt;)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b>(package) <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_delete">delete</a>&lt;T&gt;(cap: <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a>&lt;T&gt;) {
    <b>let</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a> { id, .. } = cap;
    id.<a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_delete">delete</a>();
}
</code></pre>



</details>

<a name="permissioned_groups_unpause_cap_burn"></a>

## Function `burn`

Burns the cap, making the group's pause permanent.
Call this to archive a group — once burned, unpause is impossible.

Alternative: <code>transfer::public_freeze_object(cap)</code> — makes the cap immutable
(cannot be passed by value to <code>unpause()</code>), also preventing unpause without destroying it.


<pre><code><b>public</b> <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_burn">burn</a>&lt;T&gt;(cap: <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">permissioned_groups::unpause_cap::UnpauseCap</a>&lt;T&gt;)
</code></pre>



<details>
<summary>Implementation</summary>


<pre><code><b>public</b> <b>fun</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_burn">burn</a>&lt;T&gt;(cap: <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a>&lt;T&gt;) {
    <b>let</b> <a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_UnpauseCap">UnpauseCap</a> { id, .. } = cap;
    id.<a href="../permissioned_groups/unpause_cap.md#permissioned_groups_unpause_cap_delete">delete</a>();
}
</code></pre>



</details>
