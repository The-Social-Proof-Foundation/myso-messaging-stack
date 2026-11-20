ALTER TABLE device_notification_keys
    ADD COLUMN IF NOT EXISTS receipt_public_key TEXT NULL;
