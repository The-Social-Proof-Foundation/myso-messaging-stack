# Production: R2 archive on the relayer

## Env

```
STORAGE_TYPE=postgres
DATABASE_URL=postgres://...
ARCHIVE_BACKEND=r2
ARCHIVE_NAMESPACE=mysocial
R2_BUCKET=myso-message-archive
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_REGION=auto
FILE_STORAGE_SYNC_MESSAGE_THRESHOLD=1   # optional smoke
FILE_STORAGE_SYNC_INTERVAL_SECS=60
```

## Smoke

1. Deploy/restart relayer (migration `010_archive_messages` applies automatically).
2. Send a message; wait for sync.
3. Confirm Postgres: `SELECT * FROM archive_messages LIMIT 5;`
4. Confirm R2 object key `{namespace}/groups/{group_id}/msg-{uuid}.json`
5. Chat-app: `VITE_ENABLE_MESSAGE_RECOVERY=true` + matching `VITE_ARCHIVE_NAMESPACE` → Restore / empty-thread fill.
6. Flip `ARCHIVE_BACKEND=file_storage` → R2 idle; File Storage path still valid.

## Flip back to File Storage

```
ARCHIVE_BACKEND=file_storage
# FILE_STORAGE_* as usual
```

No dual-write. Clients using `RelayerArchiveRecoveryTransport` only work while `ARCHIVE_BACKEND=r2`.
