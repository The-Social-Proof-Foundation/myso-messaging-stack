/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: group_leaver
 *
 * Actor object that allows group members to leave a `PermissionedGroup<T>`.
 *
 * `GroupLeaver` is a derived singleton object from `MessagingNamespace`. It is
 * granted `PermissionsAdmin` on every group created via `messaging::create_group`,
 * and exposes a `leave` function that calls `object_remove_member` on behalf of
 * the caller.
 *
 * This module does NOT import `messaging.move` to avoid a circular dependency. The
 * generic `leave<T: drop>` is instantiated with the concrete `Messaging` type at
 * the call site in `messaging.move`.
 *
 * All public entry points are in the `messaging` module:
 *
 * - `messaging::leave` - removes the caller from a group
 */

import { MoveStruct } from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
const $moduleName = '@local-pkg/messaging::group_leaver';
export const GroupLeaver = new MoveStruct({
	name: `${$moduleName}::GroupLeaver`,
	fields: {
		id: bcs.Address,
	},
});
