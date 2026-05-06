# Message Flow Diagrams

### Standalone Mode (Docker)

```mermaid
sequenceDiagram
    participant Client
    participant Relayer as Relayer (Docker Container)
    participant MembershipCache as MembershipCache (In-Memory)
    participant MessageStore as Message Storage (In-Memory)
    participant FileStorage
    participant GroupsSDK as Groups SDK (MySo)

    Note over Client,GroupsSDK: Standalone deployment - no TEE attestation

    rect rgb(240, 240, 240)
        Note over Relayer,GroupsSDK: Background: Membership Sync (polling/gRPC)
        GroupsSDK->>Relayer: Events (MemberAdded/Removed, PermissionsGranted/Revoked)
        Relayer->>MembershipCache: Update permissions state
    end

    Client->>Relayer: POST /messages (encrypted_msg, signature, public_key, timestamp)
    Relayer->>Relayer: 1. Validate timestamp (TTL check)
    Relayer->>Relayer: 2. Verify signature (Ed25519/Secp256k1/Secp256r1)
    Relayer->>Relayer: 3. Derive address from public_key (Blake2b-256)
    Relayer->>Relayer: 4. Verify derived == sender_address
    Relayer->>MembershipCache: 5. Check permission (MessagingSender)
    MembershipCache-->>Relayer: has_permission = true
    Relayer->>MessageStore: 6. Store message (status=SYNC_PENDING)
    MessageStore-->>Relayer: message_id
    Relayer-->>Client: 201 Created { message_id }

    rect rgb(240, 240, 240)
        Note over Relayer,FileStorage: Background: File Storage Sync (periodic)
        Relayer->>MessageStore: Get messages where status=SYNC_PENDING
        MessageStore-->>Relayer: [msg1, msg2, msg3]
        Relayer->>FileStorage: Batch upload to Quilt
        FileStorage-->>Relayer: quilt_patch_id
        Relayer->>MessageStore: Update status=SYNCED
    end
```

---

### Authentication Pipeline

```mermaid
flowchart TD
    A[Request Arrives] --> B{Health Check?}
    B -->|Yes| C[Pass Through - No Auth Required]
    B -->|No| D[1. Validate Timestamp]

    D -->|Expired| E[401 Unauthorized<br/>REQUEST_EXPIRED]
    D -->|Valid| F[2. Decode Public Key]

    F -->|Invalid| G[401 Unauthorized<br/>INVALID_PUBLIC_KEY_FORMAT]
    F -->|Valid| H[3. Detect Signature Scheme]

    H --> I{Scheme Flag}
    I -->|0x00| J[Ed25519 - 32 byte key]
    I -->|0x01| K[Secp256k1 - 33 byte key]
    I -->|0x02| L[Secp256r1 - 33 byte key]

    J --> M[4. Verify Signature]
    K --> M
    L --> M

    M -->|Invalid| N[401 Unauthorized<br/>SIGNATURE_VERIFICATION_FAILED]
    M -->|Valid| O[5. Derive MySo Address]

    O --> P[Blake2b-256 of flag + pubkey]
    P --> Q[6. Address Match?]

    Q -->|Mismatch| R[401 Unauthorized<br/>ADDRESS_MISMATCH]
    Q -->|Match| S[7. Check Permission]

    S -->|GET| T0{Has MessagingReader?}
    S -->|POST| T{Has MessagingSender?}
    S -->|PUT| U{Has MessagingEditor?}
    S -->|DELETE| V{Has MessagingDeleter?}

    T0 -->|No| W[403 Forbidden<br/>NOT_GROUP_MEMBER]
    T -->|No| W
    U -->|No| W
    V -->|No| W

    T0 -->|Yes| X[Continue to Handler]
    T -->|Yes| X
    U -->|Yes| Y[Check Ownership]
    V -->|Yes| Y2[Check Ownership]

    Y -->|Not Owner| Z[403 Forbidden<br/>Only original sender can edit]
    Y -->|Is Owner| X
    Y2 -->|Not Owner| Z2[403 Forbidden<br/>Only original sender can delete]
    Y2 -->|Is Owner| X
```

---

### In-Memory Storage Mode 

```mermaid
sequenceDiagram
    participant Client
    participant Relayer
    participant MembershipCache as MembershipCache (In-Memory)
    participant Memory as In-Memory Message Storage
    participant FileStorage

    Note over Client,FileStorage: POST /messages - Create Message

    Client->>Relayer: POST /messages (encrypted_msg, signature, public_key, timestamp)
    Relayer->>Relayer: 1. Validate timestamp (within TTL)
    Relayer->>Relayer: 2. Verify signature
    Relayer->>Relayer: 3. Derive & verify address
    Relayer->>MembershipCache: 4. Check permission (group_id, sender_address, MessagingSender)
    MembershipCache-->>Relayer: has_permission = true
    Relayer->>Memory: 5. get_max_order(group_id)
    Memory-->>Relayer: max_order = 5
    Relayer->>Memory: 6. Store message (order=6, status=SYNC_PENDING)
    Memory-->>Relayer: message_id
    Relayer-->>Client: 201 Created { message_id }

    Note over Memory,FileStorage: RISK WINDOW: Message only in RAM until File Storage sync

    Note over Relayer,FileStorage: Background Worker (periodic) - Planned

    loop Every N minutes or X messages
        Relayer->>Memory: Get messages where status=SYNC_PENDING
        Memory-->>Relayer: [msg1, msg2, msg3]
        Relayer->>FileStorage: Batch upload to Quilt
        FileStorage-->>Relayer: quilt_patch_id
        Relayer->>Memory: Update status=SYNCED, set quilt_patch_id
    end

    Note over Memory,FileStorage: Messages now durable in FileStorage
```

---

### Permanent Storage Mode with DB (Optional)

```mermaid
sequenceDiagram
    participant Client
    participant Relayer
    participant MembershipCache as MembershipCache (In-Memory)
    participant Postgres as PostgreSQL Message Storage
    participant FileStorage

    Note over Client,FileStorage: POST /messages - Create Message

    Client->>Relayer: POST /messages (encrypted_msg, signature, public_key, timestamp)
    Relayer->>Relayer: 1. Validate timestamp (within TTL)
    Relayer->>Relayer: 2. Verify signature
    Relayer->>Relayer: 3. Derive & verify address
    Relayer->>MembershipCache: 4. Check permission (group_id, sender_address, MessagingSender)
    MembershipCache-->>Relayer: has_permission = true
    Relayer->>Postgres: 5. BEGIN TRANSACTION
    Relayer->>Postgres: 6. SELECT MAX(order) FROM messages WHERE group_id=?
    Postgres-->>Relayer: max_order = 5
    Relayer->>Postgres: 7. INSERT message (order=6, status=SYNC_PENDING)
    Relayer->>Postgres: 8. COMMIT
    Postgres-->>Relayer: message_id
    Relayer-->>Client: 201 Created { message_id }

    Note over Postgres,FileStorage: Message durable immediately in PostgreSQL

    Note over Relayer,FileStorage: Background Worker (periodic - disaster recovery)

    loop Every N minutes or X messages
        Relayer->>Postgres: SELECT * FROM messages WHERE status=SYNC_PENDING
        Postgres-->>Relayer: [msg1, msg2, msg3]
        Relayer->>FileStorage: Batch upload to Quilt (backup)
        FileStorage-->>Relayer: quilt_patch_id
        Relayer->>Postgres: UPDATE status=SYNCED, quilt_patch_id=?
    end

    Note over Postgres,FileStorage: Messages backed up to File Storage (ready for recovery)
```

---

### Membership Sync

```mermaid
sequenceDiagram
    participant GroupsSDK as Groups SDK (MySo)
    participant Relayer
    participant MembershipCache as MembershipCache (In-Memory)

    Note over GroupsSDK,MembershipCache: On Relayer Startup

    Relayer->>GroupsSDK: Subscribe to Groups SDK events (polling or gRPC)

    Note over GroupsSDK,MembershipCache: Continuous Event Processing

    loop On MemberAdded event
        GroupsSDK->>Relayer: MemberAdded { group_id, address }
        Relayer->>MembershipCache: add_member(group_id, address, permissions)
    end

    loop On MemberRemoved event
        GroupsSDK->>Relayer: MemberRemoved { group_id, address }
        Relayer->>MembershipCache: remove_member(group_id, address)
    end

    loop On PermissionsGranted event
        GroupsSDK->>Relayer: PermissionsGranted { group_id, address, permissions }
        Relayer->>MembershipCache: grant_permissions(group_id, address, permissions)
    end

    loop On PermissionsRevoked event
        GroupsSDK->>Relayer: PermissionsRevoked { group_id, address, permissions }
        Relayer->>MembershipCache: revoke_permissions(group_id, address, permissions)
    end

    Note over MembershipCache: Always up-to-date permission state
```

---

### Message Edit Flow

```mermaid
sequenceDiagram
    participant Client
    participant Relayer
    participant MembershipCache as MembershipCache
    participant MessageStore as Message Storage

    Note over Client,MessageStore: PUT /messages - Edit Message (Owner Only)

    Client->>Relayer: PUT /messages (message_id, group_id, sender_address, encrypted_text, signature)
    Relayer->>Relayer: 1. Auth middleware (timestamp, signature, address)
    Relayer->>MembershipCache: 2. Check permission (MessagingEditor)
    MembershipCache-->>Relayer: has_permission = true
    Relayer->>MessageStore: 3. Fetch existing message
    MessageStore-->>Relayer: message { sender_wallet_addr, ... }
    Relayer->>Relayer: 4. Ownership check: sender_address == message.sender_wallet_addr?

    alt Not Owner
        Relayer-->>Client: 403 Forbidden "Only the original sender can edit this message"
    else Is Owner
        Relayer->>MessageStore: 5. Update message (new encrypted_text, status=UPDATE_PENDING)
        MessageStore-->>Relayer: success
        Relayer-->>Client: 200 OK {}
    end
```

---

### Message Delete Flow

```mermaid
sequenceDiagram
    participant Client
    participant Relayer
    participant MembershipCache as MembershipCache
    participant MessageStore as Message Storage

    Note over Client,MessageStore: DELETE /messages/:id - Soft Delete (Owner Only)

    Client->>Relayer: DELETE /messages/:message_id (headers: X-Signature, X-Public-Key, X-Sender-Address, X-Timestamp, X-Group-Id)
    Relayer->>Relayer: 1. Auth middleware (timestamp, signature, address)
    Relayer->>MembershipCache: 2. Check permission (MessagingDeleter)
    MembershipCache-->>Relayer: has_permission = true
    Relayer->>MessageStore: 3. Fetch existing message
    MessageStore-->>Relayer: message { sender_wallet_addr, ... }
    Relayer->>Relayer: 4. Ownership check: sender_address == message.sender_wallet_addr?

    alt Not Owner
        Relayer-->>Client: 403 Forbidden "Only the original sender can delete this message"
    else Is Owner
        Relayer->>MessageStore: 5. Soft delete (status=DELETE_PENDING)
        MessageStore-->>Relayer: success
        Relayer-->>Client: 200 OK {}
    end

    Note over MessageStore: Message becomes tombstone (is_deleted=true)
```

---

### Get Messages Flow

```mermaid
sequenceDiagram
    participant Client
    participant Relayer
    participant MessageStore as Message Storage

    Note over Client,MessageStore: GET /messages - Auth Required (MessagingReader)

    alt Get Single Message
        Client->>Relayer: GET /messages?message_id=uuid (headers: X-Signature, X-Public-Key, X-Sender-Address, X-Timestamp, X-Group-Id)
        Relayer->>Relayer: Auth middleware (verify signature, check MessagingReader permission)
        Relayer->>MessageStore: get_message(message_id)
        MessageStore-->>Relayer: message
        Relayer-->>Client: 200 OK { message_id, encrypted_text, is_edited, is_deleted, ... }
    else Get Paginated List
        Client->>Relayer: GET /messages?group_id=xxx&after_order=10&limit=50
        Relayer->>MessageStore: get_messages_by_group(group_id, after_order, before_order, limit+1)
        MessageStore-->>Relayer: [messages]
        Relayer->>Relayer: Check if hasNext (len > limit)
        Relayer-->>Client: 200 OK { messages: [...], hasNext: true/false }
    end

    Note over Client: Client decrypts messages using DEK from MyData
```

---

## Future: TEE Enclave Mode (Nautilus on AWS Nitro)


```mermaid
sequenceDiagram
    participant Client
    participant Relayer as Relayer (inside Nautilus Enclave)
    participant MySo as MySo Blockchain
    participant MembershipCache as MembershipCache
    participant MessageStore as Message Storage
    participant FileStorage
    participant GroupsSDK as Groups SDK (MySo)

    Note over Client,GroupsSDK: ONE-TIME: Enclave Registration

    Relayer->>Relayer: Generate ephemeral Ed25519 keypair on boot
    Relayer->>Relayer: Request attestation from AWS Nitro NSM
    Note over Relayer: Attestation contains: PCRs + public key<br/>Signed by AWS root CA
    Relayer->>MySo: register_enclave(attestation_document)
    MySo->>MySo: Verify attestation signature (AWS root CA)
    MySo->>MySo: Compare PCRs with EnclaveConfig
    MySo->>MySo: Extract & store enclave public key
    Note over MySo: Enclave object created with verified public key

    Note over Client,GroupsSDK: RUNTIME: Message Flow (with response signing)

    Client->>Relayer: POST /messages (encrypted_msg, signature)
    Relayer->>Relayer: Auth pipeline (timestamp, signature, address, permission)
    Relayer->>MessageStore: Store message (status=SYNC_PENDING)
    MessageStore-->>Relayer: message_id
    Relayer->>Relayer: Sign response (enclave ephemeral key)
    Relayer-->>Client: { message_id, signature }

    Note over Client,MySo: Client can optionally verify on-chain

    Client->>MySo: verify_signature(enclave, payload, signature)
    MySo->>MySo: Verify using stored enclave.pk
    MySo-->>Client: valid = true
```
