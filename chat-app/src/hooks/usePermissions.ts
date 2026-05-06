/**
 * Hook for checking the current user's permissions within a group.
 *
 * Fetches and caches permission checks for:
 * - PermissionsAdmin (core admin)
 * - MessagingSender, MessagingReader, MessagingEditor, MessagingDeleter
 * - EncryptionKeyRotator, MetadataAdmin
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useCurrentAccount } from '@socialproof/dapp-kit';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';

export interface Permissions {
  isAdmin: boolean;
  canSend: boolean;
  canRead: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canRotateKey: boolean;
  canEditMetadata: boolean;
}

const DEFAULT_PERMISSIONS: Permissions = {
  isAdmin: false,
  canSend: false,
  canRead: false,
  canEdit: false,
  canDelete: false,
  canRotateKey: false,
  canEditMetadata: false,
};

export interface UsePermissionsResult {
  permissions: Permissions;
  loading: boolean;
  refresh: () => void;
}

export function usePermissions(groupId: string): UsePermissionsResult {
  const { client } = useRequiredMessagingClient();
  const account = useCurrentAccount();
  const [permissions, setPermissions] = useState<Permissions>(DEFAULT_PERMISSIONS);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const groupIdRef = useRef(groupId);
  groupIdRef.current = groupId;

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!account) {
      setPermissions(DEFAULT_PERMISSIONS);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    async function checkPermissions() {
      try {
        const member = account!.address;
        const view = client.groups.view;

        // Check each permission type in parallel
        const [isAdmin, canSend, canRead, canEdit, canDelete, canRotateKey, canEditMetadata] =
          await Promise.all([
            view.hasPermission({
              groupId,
              member,
              permissionType: client.groups.bcs.PermissionsAdmin.name,
            }),
            view.hasPermission({
              groupId,
              member,
              permissionType: client.messaging.bcs.MessagingSender.name,
            }),
            view.hasPermission({
              groupId,
              member,
              permissionType: client.messaging.bcs.MessagingReader.name,
            }),
            view.hasPermission({
              groupId,
              member,
              permissionType: client.messaging.bcs.MessagingEditor.name,
            }),
            view.hasPermission({
              groupId,
              member,
              permissionType: client.messaging.bcs.MessagingDeleter.name,
            }),
            view.hasPermission({
              groupId,
              member,
              permissionType: client.messaging.bcs.EncryptionKeyRotator.name,
            }),
            view.hasPermission({
              groupId,
              member,
              permissionType: client.messaging.bcs.MetadataAdmin.name,
            }),
          ]);

        if (cancelled || groupIdRef.current !== groupId) return;

        setPermissions({
          isAdmin,
          canSend,
          canRead,
          canEdit,
          canDelete,
          canRotateKey,
          canEditMetadata,
        });
      } catch (err) {
        console.error('Failed to check permissions:', err);
        if (!cancelled && groupIdRef.current === groupId) {
          setPermissions(DEFAULT_PERMISSIONS);
        }
      } finally {
        if (!cancelled && groupIdRef.current === groupId) {
          setLoading(false);
        }
      }
    }

    checkPermissions().then();

    return () => {
      cancelled = true;
    };
  }, [groupId, account, client, refreshKey]);

  return { permissions, loading, refresh };
}
