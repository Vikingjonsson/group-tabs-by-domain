# Respect User-Created Tab Groups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the extension from overriding user-created or user-renamed tab groups.

**Architecture:** Track extension-created group IDs in a `Map<number, string>` (groupId → domain) persisted to `chrome.storage.session`. Pass this map to handler functions so they only manage extension-owned groups. Detect stale IDs (group removed) and renamed groups (user claimed ownership) by comparing the map against live Chrome group state.

**Tech Stack:** TypeScript, Chrome Extension APIs (MV3), Jest

---

## File Map

- **Modify:** `src/handlers.ts` — add `cleanExtensionGroupIds` export, add `extensionGroupIds` parameter to `groupTabsByDomain` and `dissolveGroupsWithTooFewTabs`, change return types, add `isInUserOwnedGroup` helper
- **Modify:** `src/handlers.test.ts` — add tests for ownership filtering, cleanup, return values; update existing tests to pass extension map
- **Modify:** `src/background.ts` — add ownership map load/save/cleanup logic, wire map into `processTabChanges`

---

### Task 1: Add `cleanExtensionGroupIds` function with tests

**Files:**

- Modify: `src/handlers.ts` (add export at end of file)
- Modify: `src/handlers.test.ts` (add new describe block)

- [ ] **Step 1: Write failing tests for `cleanExtensionGroupIds`**

Add to `src/handlers.test.ts` — new import and new describe block:

Update the import at line 1:

```typescript
import {
  groupTabsByDomain,
  dissolveGroupsWithTooFewTabs,
  collapseAllGroupsExcept,
  collapseAllInactiveGroups,
  isValidTabUrl,
  cleanExtensionGroupIds,
} from './handlers';
```

Add this describe block after the `integration scenarios` describe:

```typescript
describe('cleanExtensionGroupIds', () => {
  it('removes stale group IDs that no longer exist', () => {
    const extensionGroupIds = new Map<number, string>([
      [1, 'google.com'],
      [2, 'github.com'],
    ]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      {
        id: 1,
        windowId: 1,
        collapsed: false,
        title: 'google.com',
        color: 'blue' as chrome.tabGroups.ColorEnum,
        shared: false,
      },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.has(1)).toBe(true);
    expect(cleaned.has(2)).toBe(false);
  });

  it('removes groups whose title was renamed by the user', () => {
    const extensionGroupIds = new Map<number, string>([[1, 'google.com']]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      {
        id: 1,
        windowId: 1,
        collapsed: false,
        title: 'My Search Tabs',
        color: 'blue' as chrome.tabGroups.ColorEnum,
        shared: false,
      },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.has(1)).toBe(false);
  });

  it('keeps groups whose title still matches', () => {
    const extensionGroupIds = new Map<number, string>([[1, 'google.com']]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      {
        id: 1,
        windowId: 1,
        collapsed: false,
        title: 'google.com',
        color: 'blue' as chrome.tabGroups.ColorEnum,
        shared: false,
      },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.has(1)).toBe(true);
    expect(cleaned.get(1)).toBe('google.com');
  });

  it('returns empty map when all groups are stale', () => {
    const extensionGroupIds = new Map<number, string>([
      [1, 'google.com'],
      [2, 'github.com'],
    ]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.size).toBe(0);
  });

  it('handles empty input map', () => {
    const extensionGroupIds = new Map<number, string>();
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      {
        id: 1,
        windowId: 1,
        collapsed: false,
        title: 'google.com',
        color: 'blue' as chrome.tabGroups.ColorEnum,
        shared: false,
      },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --testNamePattern="cleanExtensionGroupIds"`
Expected: FAIL — `cleanExtensionGroupIds` is not exported from `./handlers`

- [ ] **Step 3: Implement `cleanExtensionGroupIds` in handlers.ts**

Add at the end of `src/handlers.ts`, before the closing (there is no closing, just at end of file):

```typescript
export const cleanExtensionGroupIds = (
  extensionGroupIds: Map<number, string>,
  existingGroups: chrome.tabGroups.TabGroup[]
): Map<number, string> => {
  const cleaned = new Map(extensionGroupIds);

  for (const [groupId, expectedDomain] of extensionGroupIds) {
    const group = existingGroups.find((g) => g.id === groupId);
    if (!group || group.title !== expectedDomain) {
      cleaned.delete(groupId);
    }
  }

  return cleaned;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --testNamePattern="cleanExtensionGroupIds"`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers.ts src/handlers.test.ts
git commit -m "feat: add cleanExtensionGroupIds for stale/renamed group detection"
```

---

### Task 2: Modify `groupTabsByDomain` to support ownership tracking

**Files:**

- Modify: `src/handlers.ts:43-133` (multiple internal functions + `groupTabsByDomain`)
- Modify: `src/handlers.test.ts` (new describe block + update one existing test)

- [ ] **Step 1: Write failing tests for user-owned group protection and return values**

Add to `src/handlers.test.ts` — new describe block after `groupTabsByDomain - ignored tabs`:

```typescript
describe('groupTabsByDomain - user-owned groups', () => {
  beforeEach(resetAllMocks);

  it('does not regroup tabs in user-owned groups', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    const userTab = createMockTab(3, 'https://google.com/c', 1);

    const userGroupId = 100;
    (userTab as any).groupId = userGroupId;
    mockGroups.push({
      id: userGroupId,
      windowId: 1,
      collapsed: false,
      title: 'My Research',
      color: 'blue' as chrome.tabGroups.ColorEnum,
      shared: false,
    });

    await groupTabsByDomain(false, new Map());

    expect(userTab.groupId).toBe(userGroupId);
    const googleGroup = findGroupByTitle('google.com');
    expect(getTabsInGroup(googleGroup.id)).toHaveLength(2);
  });

  it('groups ungrouped tabs even when same-domain tabs are in user groups', async () => {
    const userTab = createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://google.com/c', 1);

    const userGroupId = 100;
    (userTab as any).groupId = userGroupId;
    mockGroups.push({
      id: userGroupId,
      windowId: 1,
      collapsed: false,
      title: 'My Research',
      color: 'blue' as chrome.tabGroups.ColorEnum,
      shared: false,
    });

    const newGroups = await groupTabsByDomain(false, new Map());

    expect(userTab.groupId).toBe(userGroupId);
    expect(newGroups.size).toBe(1);
    const googleGroup = findGroupByTitle('google.com');
    expect(getTabsInGroup(googleGroup.id)).toHaveLength(2);
  });

  it('returns newly created extension groups', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);

    const newGroups = await groupTabsByDomain(false, new Map());

    expect(newGroups.size).toBe(1);
    const [groupId, domain] = [...newGroups.entries()][0];
    expect(domain).toBe('google.com');
    expect(groupId).toBe(mockGroups[0].id);
  });

  it('does not return already-tracked extension groups', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    const firstRunGroups = await groupTabsByDomain(false, new Map());

    createMockTab(3, 'https://google.com/c', 1);
    const secondRunGroups = await groupTabsByDomain(false, firstRunGroups);

    expect(secondRunGroups.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run new tests to verify they fail**

Run: `npm test -- --testNamePattern="user-owned groups"`
Expected: FAIL — `groupTabsByDomain` does not accept a second parameter / does not filter / does not return a Map

- [ ] **Step 3: Implement ownership filtering and return values in handlers.ts**

Replace the full block from `isGroupableTab` through `groupTabsByDomain` in `src/handlers.ts` (lines 43–133) with:

```typescript
const isGroupableTab = (tab: chrome.tabs.Tab): boolean => {
  return !!tab.url && !!tab.id && tab.windowId !== undefined && !tab.pinned;
};

const isInUserOwnedGroup = (
  tab: chrome.tabs.Tab,
  extensionGroupIds: Map<number, string>
): boolean => {
  const groupId = tab.groupId;
  if (groupId === undefined || groupId === -1) return false;
  return !extensionGroupIds.has(groupId);
};

const buildTabIdsByDomainByWindow = (
  tabs: chrome.tabs.Tab[],
  extensionGroupIds: Map<number, string>
): TabIdsByDomainByWindow => {
  const result: TabIdsByDomainByWindow = {};

  for (const tab of tabs) {
    if (!isGroupableTab(tab)) continue;
    if (isInUserOwnedGroup(tab, extensionGroupIds)) continue;

    const domain = extractBaseDomain(tab.url!);
    if (!domain) continue;

    result[tab.windowId] ??= {};
    result[tab.windowId][domain] ??= [];
    result[tab.windowId][domain].push(tab.id!);
  }

  return result;
};

const asNonEmptyArray = (tabIds: TabId[]): [TabId, ...TabId[]] => {
  if (tabIds.length === 0) throw new Error('Expected non-empty array');
  return tabIds as [TabId, ...TabId[]];
};

const createNewTabGroup = async (
  tabIds: TabId[],
  domain: Domain,
  windowId: WindowId
): Promise<number> => {
  const groupId = await chrome.tabs.group({
    tabIds: asNonEmptyArray(tabIds),
    createProperties: { windowId },
  });

  await chrome.tabGroups.update(groupId, {
    title: domain,
    color: getDeterministicColorForDomain(domain),
  });

  return groupId;
};

const addTabsToExistingGroup = async (
  tabIds: TabId[],
  domain: Domain,
  windowId: WindowId,
  existingGroupId: number
): Promise<number> => {
  try {
    await chrome.tabs.group({ tabIds: asNonEmptyArray(tabIds), groupId: existingGroupId });
    return existingGroupId;
  } catch {
    return await createNewTabGroup(tabIds, domain, windowId);
  }
};

const ensureDomainIsGroupedInWindow = async (
  domain: Domain,
  tabIds: TabId[],
  windowId: WindowId,
  extensionGroupIds: Map<number, string>
): Promise<number> => {
  const existingGroupsForDomain = await chrome.tabGroups.query({
    windowId,
    title: domain,
  });

  const extensionOwnedGroup = existingGroupsForDomain.find((g) => extensionGroupIds.has(g.id));

  if (!extensionOwnedGroup) {
    return await createNewTabGroup(tabIds, domain, windowId);
  } else {
    return await addTabsToExistingGroup(tabIds, domain, windowId, extensionOwnedGroup.id);
  }
};

const extractValidTabIds = (tabs: chrome.tabs.Tab[]): TabId[] => {
  return tabs.map((tab) => tab.id).filter((id): id is TabId => id !== undefined);
};

export const groupTabsByDomain = async (
  shouldGroupSingleTabs = false,
  extensionGroupIds: Map<number, string> = new Map()
): Promise<Map<number, string>> => {
  const allTabs = await chrome.tabs.query({});
  const tabIdsByDomainByWindow = buildTabIdsByDomainByWindow(allTabs, extensionGroupIds);
  const MINIMUM_TABS_TO_GROUP = shouldGroupSingleTabs ? 1 : 2;
  const newGroups = new Map<number, string>();

  for (const [windowIdString, tabIdsByDomain] of Object.entries(tabIdsByDomainByWindow)) {
    const windowId = parseInt(windowIdString, 10);

    for (const [domain, tabIds] of Object.entries(tabIdsByDomain)) {
      if (tabIds.length >= MINIMUM_TABS_TO_GROUP) {
        const groupId = await ensureDomainIsGroupedInWindow(
          domain,
          tabIds,
          windowId,
          extensionGroupIds
        );
        if (!extensionGroupIds.has(groupId)) {
          newGroups.set(groupId, domain);
        }
      }
    }
  }

  return newGroups;
};
```

- [ ] **Step 4: Run new tests to verify they pass**

Run: `npm test -- --testNamePattern="user-owned groups"`
Expected: all 4 tests PASS

- [ ] **Step 5: Update existing test that calls `groupTabsByDomain` twice**

In `src/handlers.test.ts`, update the test "adds new tabs to an existing group for the same domain":

```typescript
it('adds new tabs to an existing group for the same domain', async () => {
  createMockTab(1, 'https://example.com/a', 1);
  createMockTab(2, 'https://example.com/b', 1);
  const extensionGroups = await groupTabsByDomain();
  expect(mockGroups).toHaveLength(1);

  createMockTab(3, 'https://example.com/c', 1);
  await groupTabsByDomain(false, extensionGroups);

  expect(mockGroups).toHaveLength(1);
  expect(getTabsInGroup(mockGroups[0].id)).toHaveLength(3);
});
```

- [ ] **Step 6: Run all `groupTabsByDomain` tests**

Run: `npm test -- --testNamePattern="groupTabsByDomain"`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/handlers.ts src/handlers.test.ts
git commit -m "feat: groupTabsByDomain skips user-owned groups and returns new group IDs"
```

---

### Task 3: Modify `dissolveGroupsWithTooFewTabs` to respect ownership

**Files:**

- Modify: `src/handlers.ts:135-150` (`dissolveGroupsWithTooFewTabs`)
- Modify: `src/handlers.test.ts` (new test + update existing dissolve/integration tests)

- [ ] **Step 1: Write failing test for user-owned group protection**

Add to `src/handlers.test.ts` inside the `dissolveGroupsWithTooFewTabs` describe, before existing tests:

```typescript
it('does not dissolve user-owned groups', async () => {
  const tab = createMockTab(1, 'https://example.com/a', 1);

  const userGroupId = 100;
  (tab as any).groupId = userGroupId;
  mockGroups.push({
    id: userGroupId,
    windowId: 1,
    collapsed: false,
    title: 'My Group',
    color: 'blue' as chrome.tabGroups.ColorEnum,
    shared: false,
  });

  await dissolveGroupsWithTooFewTabs(false, new Map());

  expect(tab.groupId).toBe(userGroupId);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm test -- --testNamePattern="does not dissolve user-owned"`
Expected: FAIL — the function dissolves all groups regardless of ownership

- [ ] **Step 3: Implement ownership check in `dissolveGroupsWithTooFewTabs`**

Replace `dissolveGroupsWithTooFewTabs` in `src/handlers.ts`:

```typescript
export const dissolveGroupsWithTooFewTabs = async (
  shouldGroupSingleTabs = false,
  extensionGroupIds: Map<number, string> = new Map()
): Promise<void> => {
  const allGroups = await chrome.tabGroups.query({});
  const MINIMUM_TABS_TO_GROUP = shouldGroupSingleTabs ? 1 : 2;

  for (const group of allGroups) {
    if (!extensionGroupIds.has(group.id)) continue;

    const tabsInGroup = await chrome.tabs.query({ groupId: group.id });
    const tabIds = extractValidTabIds(tabsInGroup);

    const hasTooFewTabs = tabsInGroup.length < MINIMUM_TABS_TO_GROUP;
    if (hasTooFewTabs && tabIds.length > 0) {
      await chrome.tabs.ungroup(asNonEmptyArray(tabIds));
    }
  }
};
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npm test -- --testNamePattern="does not dissolve user-owned"`
Expected: PASS

- [ ] **Step 5: Update all existing dissolve and integration tests to pass extension map**

In `src/handlers.test.ts`, update every test in the `dissolveGroupsWithTooFewTabs` describe that calls both `groupTabsByDomain` and `dissolveGroupsWithTooFewTabs`. Capture the return value and pass it through:

```typescript
it('dissolves a group that dropped to 1 tab', async () => {
  createMockTab(1, 'https://example.com/page1', 1);
  createMockTab(2, 'https://example.com/page2', 1);
  const extensionGroups = await groupTabsByDomain();

  simulateTabLeavingGroup(1);
  await dissolveGroupsWithTooFewTabs(false, extensionGroups);

  expect(mockTabs[0].groupId).toBeUndefined();
});

it('preserves groups with 2+ tabs', async () => {
  createMockTab(1, 'https://example.com/page1', 1);
  createMockTab(2, 'https://example.com/page2', 1);
  createMockTab(3, 'https://example.com/page3', 1);
  const extensionGroups = await groupTabsByDomain();

  await dissolveGroupsWithTooFewTabs(false, extensionGroups);

  expect(mockGroups).toHaveLength(1);
  expect(getTabsInGroup(mockGroups[0].id)).toHaveLength(3);
});

it('preserves a 1-tab group when shouldGroupSingleTabs is true', async () => {
  createMockTab(1, 'https://example.com/page1', 1);
  createMockTab(2, 'https://example.com/page2', 1);
  const extensionGroups = await groupTabsByDomain(true);

  simulateTabLeavingGroup(1);
  await dissolveGroupsWithTooFewTabs(true, extensionGroups);

  expect(mockTabs[0].groupId).toBe(mockGroups[0].id);
});

it('preserves a group dropping from 3 to 1 tab when shouldGroupSingleTabs is true', async () => {
  createMockTab(1, 'https://example.com/a', 1);
  createMockTab(2, 'https://example.com/b', 1);
  createMockTab(3, 'https://example.com/c', 1);
  const extensionGroups = await groupTabsByDomain(true);
  const groupId = mockGroups[0].id;

  simulateTabLeavingGroup(1);
  simulateTabLeavingGroup(2);
  await dissolveGroupsWithTooFewTabs(true, extensionGroups);

  expect(mockTabs[0].groupId).toBe(groupId);
});

it('handles empty groups (0 tabs) without throwing', async () => {
  createMockTab(1, 'https://example.com/a', 1);
  createMockTab(2, 'https://example.com/b', 1);
  const extensionGroups = await groupTabsByDomain();

  simulateTabLeavingGroup(0);
  simulateTabLeavingGroup(1);

  await expect(dissolveGroupsWithTooFewTabs(false, extensionGroups)).resolves.not.toThrow();
});

it('only dissolves groups that dropped below the minimum, leaves others intact', async () => {
  createMockTab(1, 'https://example.com/a', 1);
  createMockTab(2, 'https://example.com/b', 1);
  createMockTab(3, 'https://github.com/a', 1);
  createMockTab(4, 'https://github.com/b', 1);
  const extensionGroups = await groupTabsByDomain();

  const githubGroup = findGroupByTitle('github.com');

  simulateTabLeavingGroup(1);
  await dissolveGroupsWithTooFewTabs(false, extensionGroups);

  expect(mockTabs[0].groupId).toBeUndefined();
  expect(mockTabs[2].groupId).toBe(githubGroup.id);
  expect(mockTabs[3].groupId).toBe(githubGroup.id);
});
```

Also update the integration test "groups then dissolves correctly when a tab is closed":

```typescript
it('groups then dissolves correctly when a tab is closed', async () => {
  createMockTab(1, 'https://example.com/a', 1);
  createMockTab(2, 'https://example.com/b', 1);

  const extensionGroups = await groupTabsByDomain();
  expect(mockGroups).toHaveLength(1);
  expect(getTabsInGroup(mockGroups[0].id)).toHaveLength(2);

  const removedTab = mockTabs.pop()!;
  (removedTab as any).groupId = undefined;

  await dissolveGroupsWithTooFewTabs(false, extensionGroups);

  expect(mockTabs[0].groupId).toBeUndefined();
});
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/handlers.ts src/handlers.test.ts
git commit -m "feat: dissolveGroupsWithTooFewTabs only dissolves extension-owned groups"
```

---

### Task 4: Wire up ownership management in background.ts

**Files:**

- Modify: `src/background.ts` (add storage logic, update processTabChanges and initializeExtension)

- [ ] **Step 1: Add ownership map storage functions and update imports**

In `src/background.ts`, update the import to include `cleanExtensionGroupIds`:

```typescript
import {
  groupTabsByDomain,
  dissolveGroupsWithTooFewTabs,
  collapseAllGroupsExcept,
  collapseAllInactiveGroups,
  isValidTabUrl,
  cleanExtensionGroupIds,
} from './handlers';
```

Add a new storage key constant after the existing constants:

```typescript
const STORAGE_KEY_EXTENSION_GROUP_IDS = 'extensionGroupIds';
```

Add a new field to `state`:

```typescript
const state = {
  shouldGroupSingleTabs: false,
  shouldAutoCollapseInactive: false,
  isLocalStorageChange: false,
  isProcessingTabChanges: false,
  isCollapsingGroups: false,
  tabChangeDebounceTimer: null as ReturnType<typeof setTimeout> | null,
  extensionGroupIds: new Map<number, string>(),
};
```

Add load/save functions after `state`:

```typescript
const loadExtensionGroupIds = async (): Promise<void> => {
  const stored = await chrome.storage.session.get({ [STORAGE_KEY_EXTENSION_GROUP_IDS]: {} });
  const record = stored[STORAGE_KEY_EXTENSION_GROUP_IDS] as Record<string, string>;
  state.extensionGroupIds = new Map(
    Object.entries(record).map(([id, domain]) => [parseInt(id, 10), domain])
  );
};

const saveExtensionGroupIds = async (): Promise<void> => {
  const record: Record<string, string> = {};
  for (const [id, domain] of state.extensionGroupIds) {
    record[id.toString()] = domain;
  }
  await chrome.storage.session.set({ [STORAGE_KEY_EXTENSION_GROUP_IDS]: record });
};
```

- [ ] **Step 2: Update `processTabChanges` to use ownership map**

Replace `processTabChanges` with:

```typescript
const processTabChanges = async (): Promise<void> => {
  if (state.isProcessingTabChanges) return;

  state.isProcessingTabChanges = true;
  try {
    await refreshSettingsFromStorage();

    const allGroups = await chrome.tabGroups.query({});
    state.extensionGroupIds = cleanExtensionGroupIds(state.extensionGroupIds, allGroups);

    const newGroups = await groupTabsByDomain(state.shouldGroupSingleTabs, state.extensionGroupIds);
    for (const [groupId, domain] of newGroups) {
      state.extensionGroupIds.set(groupId, domain);
    }

    await dissolveGroupsWithTooFewTabs(state.shouldGroupSingleTabs, state.extensionGroupIds);
    await saveExtensionGroupIds();
  } finally {
    state.isProcessingTabChanges = false;
  }
};
```

- [ ] **Step 3: Update `initializeExtension` to load ownership map**

Replace `initializeExtension` with:

```typescript
const initializeExtension = async (): Promise<void> => {
  await loadExtensionGroupIds();
  await refreshSettingsFromStorage();
  createContextMenu();
};
```

- [ ] **Step 4: Run lint and build**

Run: `npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: all tests PASS (background.ts changes don't affect handler tests)

- [ ] **Step 6: Commit**

```bash
git add src/background.ts
git commit -m "feat: wire up extension group ownership tracking in background.ts"
```
