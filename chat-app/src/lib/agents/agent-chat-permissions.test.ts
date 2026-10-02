import {describe, expect, it} from 'vitest';

import {
  extensionAwareGrantTypes,
  isCoreGroupPermission,
} from './agent-chat-permissions';

const EXT = '0x2::permissioned_group::ExtensionPermissionsAdmin';
const SEND = '0xabc::messaging::MessagingSender';

describe('extensionAwareGrantTypes', () => {
  it('puts extension-admin ahead of Send when the signer lacks it', () => {
    expect(
      extensionAwareGrantTypes({
        permissionType: SEND,
        signerHasExtensionAdmin: false,
        extensionAdminType: EXT,
      }),
    ).toEqual([EXT, SEND]);
  });

  it('grants Send alone once the signer holds extension-admin', () => {
    expect(
      extensionAwareGrantTypes({
        permissionType: SEND,
        signerHasExtensionAdmin: true,
        extensionAdminType: EXT,
      }),
    ).toEqual([SEND]);
  });

  it('does not prefix a core permission', () => {
    expect(isCoreGroupPermission(EXT)).toBe(true);
    expect(isCoreGroupPermission(SEND)).toBe(false);
    expect(
      extensionAwareGrantTypes({
        permissionType: EXT,
        signerHasExtensionAdmin: false,
        extensionAdminType: EXT,
      }),
    ).toEqual([EXT]);
  });
});
