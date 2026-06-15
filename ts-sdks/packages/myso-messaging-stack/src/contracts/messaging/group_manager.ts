/**************************************************************
 * THIS FILE IS GENERATED AND SHOULD NOT BE MANUALLY MODIFIED *
 **************************************************************/

/**
 * Module: group_manager
 *
 * Actor object that provides controlled `&mut UID` access to
 * `PermissionedGroup<T>` objects.
 *
 * `GroupManager` is a derived singleton object from `MessagingNamespace`. It is
 * granted `ObjectAdmin` on every group created via `messaging::create_group`, and
 * exposes functions for:
 *
 * - Metadata dynamic field management
 *
 * This module does NOT import `messaging.move` to avoid a circular dependency. The
 * generic functions are instantiated with the concrete `Messaging` type at the
 * call site in `messaging.move`.
 *
 * All public entry points are in the `messaging` module.
 */

import { MoveStruct } from '../utils/index.js';
import { bcs } from '@socialproof/myso/bcs';
const $moduleName = '@local-pkg/messaging::group_manager';
export const GroupManager = new MoveStruct({
	name: `${$moduleName}::GroupManager`,
	fields: {
		id: bcs.Address,
	},
});
