# Respect User-Created Tab Groups

## Problem

The extension currently treats all tab groups the same — it will regroup, dissolve, or override any group based on domain logic. If a user manually creates a group (or renames an extension-created group), the extension overwrites their intent on the next tab event.

## Decision

Track which groups the extension created. Only manage those groups. Leave everything else alone.

## Ownership Model

- **Extension-owned group**: created by the extension via `chrome.tabs.group()`. Tracked in a `Map<groupId, domain>`.
- **User-owned group**: any group not in the map. This includes groups the user created manually and extension groups the user renamed.

### Rename = transfer of ownership

If the extension detects that a tracked group's title no longer matches its expected domain, the user renamed it. The group is removed from the map and the extension stops managing it.

## Storage

The ownership map is stored in `chrome.storage.session`:

- Survives service worker restarts (important for MV3 extensions where the service worker is killed frequently).
- Clears when the browser closes, which is correct since Chrome group IDs are only valid within a browser session.
- Key: `extensionGroupIds`. Value: serialized `Record<string, string>` (groupId string → domain).

On startup (`onInstalled`/`onStartup`), the map is loaded from session storage into a module-level cache.

## Changes to handlers.ts

### `groupTabsByDomain`

Receives the ownership map as a parameter. When building tabs-by-domain:

- **Skip** any tab whose `groupId` is set and is NOT in the extension ownership map (tab is in a user-owned group).
- **Include** ungrouped tabs and tabs in extension-owned groups.

When a new group is created via `createNewTabGroup`, return the new group ID so the caller can register it in the map.

### `dissolveGroupsWithTooFewTabs`

Receives the ownership map as a parameter. Only dissolves groups whose ID is present in the map. User-owned groups are never dissolved regardless of tab count.

### `collapseAllGroupsExcept` / `collapseAllInactiveGroups`

No changes. Collapsing is non-destructive and applies globally as expected.

## Changes to background.ts

### New: ownership map management

- Module-level `extensionGroupIds: Map<number, string>` cache.
- `loadExtensionGroupIds()`: reads from `chrome.storage.session`, populates the cache.
- `saveExtensionGroupIds()`: writes the cache to `chrome.storage.session`.
- `registerExtensionGroup(groupId, domain)`: adds to cache and persists.
- `unregisterExtensionGroup(groupId)`: removes from cache and persists.

### Modified: `processTabChanges`

Before calling `groupTabsByDomain`:

1. Query all existing groups.
2. For each tracked group ID in the map, check if the group still exists. If not, remove it (stale cleanup).
3. For each tracked group ID, check if its current title matches the expected domain. If not, remove it (rename detection).
4. Pass the cleaned map to `groupTabsByDomain` and `dissolveGroupsWithTooFewTabs`.
5. After `groupTabsByDomain`, register any newly created group IDs.

### Modified: initialization

`initializeExtension` calls `loadExtensionGroupIds()` to populate the cache on startup.

## Handler return values

`groupTabsByDomain` needs to communicate which new groups it created. Two options:

- Return `Map<groupId, domain>` of newly created groups.
- Accept a callback `onGroupCreated(groupId, domain)`.

The return value approach is simpler. `groupTabsByDomain` returns a `Map<number, string>` of newly created groups. `background.ts` merges these into the ownership map.

`createNewTabGroup` returns the group ID (it already calls `chrome.tabs.group` which returns it). `ensureDomainIsGroupedInWindow` propagates this.

## Filtering logic in `buildTabIdsByDomainByWindow`

Currently `isGroupableTab` filters on `url`, `id`, `windowId`, and `pinned`. Add a new filter: skip tabs whose `groupId` is defined and not in the extension map.

This requires passing the extension map into `buildTabIdsByDomainByWindow` (or a predicate function).

## Testing

Extend existing tests:

- Tab in a user-owned group is not regrouped by `groupTabsByDomain`.
- User-owned group is not dissolved by `dissolveGroupsWithTooFewTabs`.
- Rename detection: extension group renamed by user is removed from the map.
- Stale cleanup: tracked group that no longer exists is removed from the map.
- New extension groups are returned and registered.
- Tabs in extension-owned groups are still managed normally.

## Edge cases

- **User drags a tab out of a user-owned group**: the tab becomes ungrouped. On next processing, the extension can group it by domain as normal.
- **User drags a tab into a user-owned group**: the tab's `groupId` changes to the user group. The extension will skip it.
- **Browser restart**: session storage clears, ownership map is empty. All existing groups are treated as user-owned (safe default — the extension won't touch groups it can't confirm it created).
- **Multiple tabs of same domain, some in user group**: only the ungrouped ones (or ones in extension groups) participate in domain grouping.
