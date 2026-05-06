# Group Discovery

## Table of Contents

- [Background](#background)
- [Discovery Approaches](#discovery-approaches)
  - [GraphQL Event Queries](#graphql-event-queries-no-infrastructure-required)
  - [Custom Indexer](#custom-indexer-recommended-for-production)
- [UUIDs and Deterministic Addressing](#uuids-and-deterministic-addressing)
  - [How UUIDs Work](#how-uuids-work)
  - [The GroupRef Pattern](#the-groupref-pattern)
  - [Tracking UUIDs](#tracking-uuids)
- [SDK View Helpers](#sdk-view-helpers)
- [Events Reference](#events-reference)

**Documentation:** [Home](./README.md) | [Installation](./Installation.md) | [Setup](./Setup.md) | [API Reference](./APIRef.md) | [Examples](./Examples.md) | [Encryption](./Encryption.md) | [Security](./Security.md) | [Relayer](./Relayer.md) | [Attachments](./Attachments.md) | [Archive & Recovery](./ArchiveRecovery.md) | [Extending](./Extending.md) | [Testing](./Testing.md)

---

This document covers how to discover which groups a user belongs to, and how to track the UUIDs that the SDK uses for deterministic group addressing.

## Background

The alpha SDK used owned `MemberCap` objects: when a user joined a group, they received a `MemberCap` transferred to their address. Clients could query "all objects owned by me of type MemberCap" to discover their groups.

The current architecture uses a permissions-as-membership model: a member exists if and only if they hold at least one permission in the group's on-chain `PermissionsTable`. There is no owned object to query. Instead, all membership changes emit typed events, which can be queried via GraphQL or processed by an indexer.

## Discovery Approaches

### GraphQL Event Queries (no infrastructure required)

The `myso_groups` contract emits `MemberAdded<T>` and `MemberRemoved<T>` events on every membership change. You can query these via MySo GraphQL to compute a user's current group memberships.

```graphql
query DiscoverGroups($eventType: String!, $cursor: String) {
  events(filter: { eventType: $eventType }, first: 50, after: $cursor) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      contents {
        json
      }
    }
  }
}
```

The event type strings are available from the SDK's BCS module:

```typescript
const memberAddedType = client.groups.bcs.MemberAdded.name;
const memberRemovedType = client.groups.bcs.MemberRemoved.name;
```

These produce fully-qualified type names like:
```
0x{packageId}::permissioned_group::MemberAdded<0x{messagingPkgId}::messaging::Messaging>
```

To compute the user's current groups:
1. Paginate through all `MemberAdded` events, filtering for the target address
2. Paginate through all `MemberRemoved` events, filtering for the target address
3. Compute the difference: `activeGroups = addedGroupIds - removedGroupIds`

The reference chat-app implements this pattern in [useGroupDiscovery.ts](../../chat-app/src/hooks/useGroupDiscovery.ts).

**Limitations:**
- Client-side filtering: GraphQL returns all events of the given type, and the client filters by address. For applications with many groups, this requires paginating through a large volume of events.
- No UUID in membership events: `MemberAdded` and `MemberRemoved` contain `group_id` and `member`, but not the UUID. To recover the UUID for discovered groups, make a follow-up call to `client.messaging.view.groupsMetadata({ groupIds })`.
- Eventual consistency: there can be a short delay between a membership change and the event appearing in GraphQL.

### Custom Indexer (recommended for production)

For production applications, build a service that indexes membership events and maintains a queryable database. This is the most robust approach.

**Events to index:**

| Event | Fields | Action |
|-------|--------|--------|
| `MemberAdded<T>` | `group_id`, `member` | Insert membership row |
| `MemberRemoved<T>` | `group_id`, `member` | Delete membership row |
| `PermissionsGranted<T>` | `group_id`, `member`, `permissions[]` | Update permission set |
| `PermissionsRevoked<T>` | `group_id`, `member`, `permissions[]` | Update permission set |
| `EncryptionHistoryCreated` | `encryption_history_id`, `group_id`, `uuid` | Store UUID mapping |
| `GroupCreated<T>` | `group_id`, `creator` | Store group metadata |
| `GroupDeleted<T>` | `group_id`, `deleter` | Mark group as deleted |

A minimal indexer maintains a `(user_address, group_id) -> permissions[]` table and a `group_id -> uuid` mapping. Expose an API like:

```
GET /user/:address/groups -> [{ groupId, uuid, permissions }]
```

The relayer's `MembershipSyncService` already processes these events for permission checking via gRPC checkpoint subscription. A similar pattern can be used for group discovery. See the [relayer README](../../relayer/README.md) for the event processing approach.

## UUIDs and Deterministic Addressing

### How UUIDs Work

Each messaging group is created with a UUID (client-provided or SDK-generated). The UUID is used as a derivation key with `deriveObjectID()` to compute deterministic on-chain addresses for both:

- `PermissionedGroup<Messaging>` (via `PermissionedGroupTag(uuid)`)
- `EncryptionHistory` (via `EncryptionHistoryTag(uuid)`)

Both objects are derived from the shared `MessagingNamespace`, so their addresses are predictable before the creation transaction executes. This enables single-transaction group creation: the group, encryption history, initial DEK, and MyData encryption can all happen in one PTB.

### The GroupRef Pattern

Most SDK methods accept a `GroupRef`, either a UUID or explicit object IDs:

```typescript
// By UUID (recommended): derives both IDs internally
groupRef: { uuid: 'my-group-uuid' }

// By explicit IDs: when you already have the object addresses
groupRef: { groupId: '0x...', encryptionHistoryId: '0x...' }
```

Using UUIDs is simpler because the SDK derives both IDs from the UUID without RPC calls. The derivation is deterministic and produces the same addresses across all clients. See [Setup](./Setup.md) for more on the GroupRef pattern.

### Tracking UUIDs

The UUID is stored on-chain in two places:
- `EncryptionHistory.uuid` field
- `Metadata.uuid` field (readable via `client.messaging.view.groupsMetadata()`)

It is also emitted in the `EncryptionHistoryCreated` event at group creation time.

However, you need to track UUIDs on the client side to avoid extra RPC calls on every operation. Options from simplest to most robust:

**localStorage / local database:** Store the UUID when you create a group. The reference chat-app does this in [group-store.ts](../../chat-app/src/lib/group-store.ts). Simple and sufficient for single-device apps.

**Extend your indexer:** Index `EncryptionHistoryCreated` events to store the `uuid` alongside group membership data. This gives you `GET /user/:address/groups -> [{ groupId, uuid, ... }]` in a single call, and works across devices.

**Extend the relayer:** Store `{ uuid, groupId, name }` tuples. Clients POST on group creation and GET on new device setup.

> **Note:** If you discover groups via events but don't have their UUIDs, you can always recover them from on-chain state:
> ```typescript
> const metadataMap = await client.messaging.view.groupsMetadata({ groupIds: [groupId] });
> const metadata = metadataMap[groupId];
> // metadata.uuid, metadata.name, metadata.creator, metadata.data
> ```
> This batches into a single RPC call for multiple groups.

## SDK View Helpers

Once you know a group's ID, the SDK provides read-only methods for querying membership and permissions:

```typescript
// Check if someone is a member
const isMember = await client.groups.view.isMember({ groupId, member: '0x...' });

// Check a specific permission
const canSend = await client.groups.view.hasPermission({
  groupId,
  member: '0x...',
  permissionType: `${pkgId}::messaging::MessagingSender`,
});

// List all members with their permissions
const { members, hasNextPage, cursor } = await client.groups.view.getMembers({
  groupId,
  exhaustive: true,  // fetch all pages
});

// Get group metadata (name, UUID, creator, custom data)
const metadataMap = await client.messaging.view.groupsMetadata({ groupIds: [groupId] });
const metadata = metadataMap[groupId];
```

See [API Reference](./APIRef.md) for the full list of view methods.

## Events Reference

All events are parameterized by the witness type `T`, scoping them to your application. For the messaging SDK, `T` is `Messaging`.

**Permissioned-groups events:**

| Event | Fields | When |
|-------|--------|------|
| `GroupCreated<T>` | `group_id`, `creator` | Group created |
| `GroupDerived<T, K>` | `group_id`, `creator`, `parent_id`, `derivation_key` | Derived group created |
| `MemberAdded<T>` | `group_id`, `member` | First permission granted to a new member |
| `MemberRemoved<T>` | `group_id`, `member` | All permissions removed from a member |
| `PermissionsGranted<T>` | `group_id`, `member`, `permissions[]` | Permissions granted |
| `PermissionsRevoked<T>` | `group_id`, `member`, `permissions[]` | Permissions revoked |
| `GroupDeleted<T>` | `group_id`, `deleter` | Group deleted |
| `GroupPaused<T>` | `group_id`, `paused_by` | Group paused |
| `GroupUnpaused<T>` | `group_id`, `unpaused_by` | Group unpaused |

**Messaging events:**

| Event | Fields | When |
|-------|--------|------|
| `EncryptionHistoryCreated` | `encryption_history_id`, `group_id`, `uuid`, `initial_encrypted_dek` | Group created |
| `EncryptionKeyRotated` | `encryption_history_id`, `group_id`, `new_key_version`, `new_encrypted_dek` | Key rotated |

---

[Back to table of contents](#table-of-contents)
