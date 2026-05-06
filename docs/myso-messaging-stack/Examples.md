# Example Patterns

## Contents

- [Create a Group and Send Messages](#create-a-group-and-send-messages)
- [Real-Time Subscription](#real-time-subscription)
- [File Attachments](#file-attachments)
- [Edit and Delete Messages](#edit-and-delete-messages)
- [Member Management and Key Rotation](#member-management-and-key-rotation)
- [Using tx with dapp-kit](#using-tx-with-dapp-kit)
- [Composing with call Thunks](#composing-with-call-thunks)
- [Filtering System Objects from Member Lists](#filtering-system-objects-from-member-lists)
- [Archive a Group](#archive-a-group)
- [Recover Messages from File Storage](#recover-messages-from-file-storage)

---

These examples assume a client has been created via `createMessagingGroupsClient()` and a relayer is running. See [Setup](./Setup.md) for client configuration and [Relayer](./Relayer.md) for running the relayer.

## Create a Group and Send Messages

```typescript
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

const keypair = Ed25519Keypair.generate();

// Create a group with initial members
await client.messaging.createAndShareGroup({
  signer: keypair,
  name: 'Project Chat',
  initialMembers: ['0xAlice...', '0xBob...'],
});

// Send a message
const { messageId } = await client.messaging.sendMessage({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  text: 'Hello team!',
});

// Fetch recent messages
const { messages, hasNext } = await client.messaging.getMessages({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  limit: 50,
});

for (const msg of messages) {
  console.log(`${msg.senderAddress}: ${msg.text} (verified: ${msg.senderVerified})`);
}
```

## Real-Time Subscription

```typescript
const controller = new AbortController();

for await (const msg of client.messaging.subscribe({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  signal: controller.signal,
})) {
  console.log(`[${msg.senderAddress}] ${msg.text}`);

  if (msg.isEdited) {
    console.log('(edited)');
  }
}

// To stop the subscription
controller.abort();

// Disconnect the transport when done (cleans up underlying resources)
client.messaging.disconnect();
```

Resume from a known position by passing `afterOrder`:

```typescript
for await (const msg of client.messaging.subscribe({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  afterOrder: lastSeenOrder,
  signal: controller.signal,
})) {
  // Only messages after lastSeenOrder
}
```

## File Attachments

Requires an `attachments` config with a `StorageAdapter` at client creation. See [Setup](./Setup.md). For the full encryption model, see [Attachments](./Attachments.md).

```typescript
// Send a message with files
const fileData = new TextEncoder().encode('Report content...');

await client.messaging.sendMessage({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  text: 'Here is the report',
  files: [
    { fileName: 'report.txt', mimeType: 'text/plain', data: fileData },
  ],
});

// Download attachments from a received message
for (const attachment of msg.attachments) {
  console.log(`${attachment.fileName} (${attachment.fileSize} bytes)`);
  const bytes = await attachment.data(); // download + decrypt on demand
}
```

## Edit and Delete Messages

```typescript
// Edit a message (only the original sender can edit)
await client.messaging.editMessage({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  messageId: 'abc123',
  text: 'Updated text',
});

// Edit with attachment changes
await client.messaging.editMessage({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  messageId: 'abc123',
  text: 'Updated with new attachment',
  attachments: {
    current: originalMsg.attachments.map(a => a.wire),
    remove: ['old-storage-id'],
    new: [{ fileName: 'new.pdf', mimeType: 'application/pdf', data: pdfBytes }],
  },
});

// Soft-delete a message (only the original sender can delete)
await client.messaging.deleteMessage({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  messageId: 'abc123',
});
```

## Member Management and Key Rotation

```typescript
import { messagingPermissionTypes } from '@socialproof/myso-messaging-stack';

const perms = messagingPermissionTypes(MESSAGING_PACKAGE_ID);

// Add a member with specific permissions (via the groups extension)
await client.groups.grantPermissions({
  signer: keypair,
  groupId: '0x...',
  member: '0xNewMember...',
  permissionTypes: [perms.MessagingSender, perms.MessagingReader],
});

// Remove a member and rotate the encryption key atomically
await client.messaging.removeMembersAndRotateKey({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
  members: ['0xFormerMember...'],
});

// Rotate the key without removing anyone (periodic rotation)
await client.messaging.rotateEncryptionKey({
  signer: keypair,
  groupRef: { uuid: 'project-chat-uuid' },
});
```

See [Security](./Security.md) for why `removeMembersAndRotateKey()` is recommended over standalone member removal.

## Using `tx.*` with dapp-kit

When integrating with `@socialproof/dapp-kit`, use `tx.*` methods to get a `Transaction` object for the wallet to sign:

```typescript
// In a React component using dapp-kit
const { mutate: signAndExecute } = useSignAndExecuteTransaction();

const handleCreateGroup = () => {
  const uuid = crypto.randomUUID();

  const tx = client.messaging.tx.createAndShareGroup({
    name: groupName,
    uuid,
    initialMembers: selectedMembers,
  });

  signAndExecute({ transaction: tx });
};

const handleRotateKey = () => {
  const tx = client.messaging.tx.rotateEncryptionKey({
    uuid: groupUuid,
  });

  signAndExecute({ transaction: tx });
};

const handleRemoveMember = (memberAddress: string) => {
  const tx = client.messaging.tx.removeMembersAndRotateKey({
    uuid: groupUuid,
    members: [memberAddress],
  });

  signAndExecute({ transaction: tx });
};
```

## Composing with `call.*` Thunks

Use `call.*` with `tx.add()` to compose operations into a single PTB. This follows the [MySocial SDK transaction thunks pattern](https://docs.mysocial.network/myso/sdk-building#transaction-thunks).

```typescript
import { Transaction } from '@socialproof/myso/transactions';

const tx = new Transaction();

// Create an unshared group (returns TransactionArguments for the objects)
const [group, encryptionHistory] = tx.add(
  client.messaging.call.createGroup({ name: 'Team Chat' }),
);

// Share both objects
tx.add(client.messaging.call.shareGroup({ group, encryptionHistory }));

await keypair.signAndExecuteTransaction({ transaction: tx, client });
```

For granting extra permissions beyond the initial members, use a separate transaction after the group is created, or pass all initial members via the `initialMembers` parameter.

## Filtering System Objects from Member Lists

Groups contain system actor objects (GroupLeaver, GroupManager) as members. Filter them for user-facing displays:

```typescript
const { members } = await client.groups.view.getMembers({
  groupId: '0x...',
  exhaustive: true,
});

const systemAddresses = client.messaging.derive.systemObjectAddresses();
const humanMembers = members.filter(m => !systemAddresses.has(m.address));
```

## Archive a Group

Permanently freeze a group by pausing it and burning the `UnpauseCap`:

```typescript
await client.messaging.archiveGroup({
  signer: keypair,
  groupId: '0x...',
});

// The group is now permanently paused. No further mutations are possible.
// Existing messages remain readable by members.
```

## Recover Messages from File Storage

Requires a `RecoveryTransport` configured at client creation. See [Archive & Recovery](./ArchiveRecovery.md).

```typescript
const { messages, hasNext } = await client.messaging.recoverMessages({
  groupRef: { uuid: 'project-chat-uuid' },
  limit: 100,
});

for (const msg of messages) {
  // Recovered messages are decrypted and verified like real-time messages
  console.log(`${msg.text} (verified: ${msg.senderVerified})`);
}
```
