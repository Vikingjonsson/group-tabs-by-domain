import {
  groupTabsByDomain,
  dissolveGroupsWithTooFewTabs,
  collapseAllGroupsExcept,
  collapseAllInactiveGroups,
  isValidTabUrl,
  cleanExtensionGroupIds,
} from './handlers';


const mockTabs: chrome.tabs.Tab[] = [];
const mockGroups: chrome.tabGroups.TabGroup[] = [];
const mockState = { nextGroupId: 1 };


const chromeMock = {
  tabs: {
    query: jest.fn().mockImplementation((queryInfo?: chrome.tabs.QueryInfo) => {
      const filtered = mockTabs
        .filter((tab) => (queryInfo?.groupId !== undefined ? tab.groupId === queryInfo.groupId : true))
        .filter((tab) => (queryInfo?.active !== undefined ? tab.active === queryInfo.active : true))
        .filter(() => (queryInfo?.lastFocusedWindow !== undefined ? true : true));

      return Promise.resolve(filtered);
    }),

    group: jest.fn().mockImplementation((options: chrome.tabs.GroupOptions) => {
      const groupId = options.groupId || mockState.nextGroupId++;
      const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];

      for (const tabId of tabIds) {
        const tab = mockTabs.find((t) => t.id === tabId);
        if (tab) {
          (tab as any).groupId = groupId;
        }
      }

      const groupAlreadyExists = mockGroups.some((g) => g.id === groupId);
      if (!groupAlreadyExists) {
        const firstMatchingTab = mockTabs.find((t) => tabIds.includes(t.id!));
        mockGroups.push({
          id: groupId,
          windowId: firstMatchingTab?.windowId || 1,
          collapsed: false,
          title: '',
          color: 'grey',
          shared: false,
        });
      }

      return Promise.resolve(groupId);
    }),

    ungroup: jest.fn().mockImplementation((tabIds: number[]) => {
      for (const tabId of tabIds) {
        const tab = mockTabs.find((t) => t.id === tabId);
        if (tab) {
          (tab as any).groupId = undefined;
        }
      }
      return Promise.resolve();
    }),
  },

  tabGroups: {
    query: jest.fn().mockImplementation((queryInfo?: chrome.tabGroups.QueryInfo) => {
      const filtered = mockGroups
        .filter((g) => (queryInfo?.windowId !== undefined ? g.windowId === queryInfo.windowId : true))
        .filter((g) => (queryInfo?.title !== undefined ? g.title === queryInfo.title : true));

      return Promise.resolve(filtered);
    }),

    update: jest
      .fn()
      .mockImplementation(
        (groupId: number, updateProperties: chrome.tabGroups.UpdateProperties) => {
          const group = mockGroups.find((g) => g.id === groupId);
          if (group) {
            Object.assign(group, updateProperties);
          }
          return Promise.resolve(group);
        }
      ),
  },
};

(globalThis as any).chrome = chromeMock;


const createMockTab = (id: number, url: string, windowId = 1): chrome.tabs.Tab => {
  const tab = {
    id,
    url,
    windowId,
    index: mockTabs.length,
    pinned: false,
    highlighted: false,
    active: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
  } as chrome.tabs.Tab;
  mockTabs.push(tab);
  return tab;
};

const createPinnedTab = (id: number, url: string, windowId = 1): chrome.tabs.Tab => {
  const tab = createMockTab(id, url, windowId);
  (tab as any).pinned = true;
  return tab;
};

const resetAllMocks = (): void => {
  mockTabs.length = 0;
  mockGroups.length = 0;
  mockState.nextGroupId = 1;
  jest.clearAllMocks();
};

const findGroupByTitle = (title: string): chrome.tabGroups.TabGroup => {
  const group = mockGroups.find((g) => g.title === title);
  if (!group) throw new Error(`Group with title "${title}" not found`);
  return group;
};

const getTabsInGroup = (groupId: number): chrome.tabs.Tab[] => {
  return mockTabs.filter((t) => t.groupId === groupId);
};

const simulateTabLeavingGroup = (tabIndex: number): void => {
  (mockTabs[tabIndex] as any).groupId = undefined;
};

const setActiveTab = (tabIndex: number): void => {
  for (const tab of mockTabs) {
    (tab as any).active = false;
  }
  (mockTabs[tabIndex] as any).active = true;
};


describe('isValidTabUrl', () => {
  it('rejects chrome://newtab/', () => {
    expect(isValidTabUrl('chrome://newtab/')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidTabUrl(undefined)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTabUrl('')).toBe(false);
  });

  it('accepts https URLs', () => {
    expect(isValidTabUrl('https://google.com')).toBe(true);
    expect(isValidTabUrl('https://example.com/page')).toBe(true);
  });

  it('accepts chrome:// URLs other than newtab', () => {
    expect(isValidTabUrl('chrome://settings/')).toBe(true);
    expect(isValidTabUrl('chrome://extensions/')).toBe(true);
  });

  it('accepts chrome-extension:// URLs', () => {
    expect(isValidTabUrl('chrome-extension://abcdef/popup.html')).toBe(true);
  });
});

describe('groupTabsByDomain', () => {
  beforeEach(resetAllMocks);

  it('does not group a single tab by default', async () => {
    createMockTab(1, 'https://google.com', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(0);
  });

  it('groups a single tab when shouldGroupSingleTabs is true', async () => {
    createMockTab(1, 'https://example.com/page', 1);

    await groupTabsByDomain(true);

    expect(mockGroups).toHaveLength(1);
    expect(mockGroups[0].title).toBe('example.com');
    expect(mockTabs[0].groupId).toBe(mockGroups[0].id);
  });

  it('does not group a single tab when shouldGroupSingleTabs is false', async () => {
    createMockTab(1, 'https://example.com/page', 1);

    await groupTabsByDomain(false);

    expect(mockGroups).toHaveLength(0);
  });

  it('groups multiple tabs from the same domain', async () => {
    createMockTab(1, 'https://google.com/search', 1);
    createMockTab(2, 'https://google.com/images', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(1);
    expect(mockGroups[0].title).toBe('google.com');
    expect(getTabsInGroup(mockGroups[0].id)).toHaveLength(2);
  });

  it('strips www. prefix when grouping', async () => {
    createMockTab(1, 'https://www.example.com/page1', 1);
    createMockTab(2, 'https://example.com/page2', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(1);
    expect(mockGroups[0].title).toBe('example.com');
  });

  it('groups tabs separately per window', async () => {
    createMockTab(1, 'https://google.com/search', 1);
    createMockTab(2, 'https://google.com/images', 1);
    createMockTab(3, 'https://google.com/maps', 2);
    createMockTab(4, 'https://google.com/news', 2);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(2);
    expect(mockGroups.every((g) => g.windowId === 1 || g.windowId === 2)).toBe(true);
  });

  it('creates separate groups for different domains', async () => {
    createMockTab(1, 'https://google.com/search', 1);
    createMockTab(2, 'https://google.com/images', 1);
    createMockTab(3, 'https://github.com/repo1', 1);
    createMockTab(4, 'https://github.com/repo2', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(2);
    const groupTitles = mockGroups.map((g) => g.title).sort();
    expect(groupTitles).toEqual(['github.com', 'google.com']);
  });

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

  it('assigns the same color for the same domain across runs', async () => {
    createMockTab(1, 'https://example.com/a', 1);
    createMockTab(2, 'https://example.com/b', 1);
    await groupTabsByDomain();
    const firstRunColor = mockGroups[0].color;

    resetAllMocks();

    createMockTab(3, 'https://example.com/c', 1);
    createMockTab(4, 'https://example.com/d', 1);
    await groupTabsByDomain();
    const secondRunColor = mockGroups[0].color;

    expect(firstRunColor).toBe(secondRunColor);
  });

  it('assigns a valid color from the palette', async () => {
    createMockTab(1, 'https://example.com/page', 1);
    await groupTabsByDomain(true);

    const VALID_COLORS = [
      'blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow',
    ];
    expect(VALID_COLORS).toContain(mockGroups[0].color);
  });
});

describe('groupTabsByDomain - ignored tabs', () => {
  beforeEach(resetAllMocks);

  it('ignores chrome:// URLs', async () => {
    createMockTab(1, 'chrome://newtab/', 1);
    createMockTab(2, 'chrome://settings/', 1);
    createMockTab(3, 'https://example.com', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(0);
  });

  it('does not group multiple chrome:// URLs together', async () => {
    createMockTab(1, 'chrome://newtab/', 1);
    createMockTab(2, 'chrome://newtab/', 1);
    createMockTab(3, 'chrome://settings/', 1);
    createMockTab(4, 'chrome://settings/', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(0);
  });

  it('ignores chrome-extension:// URLs', async () => {
    createMockTab(1, 'chrome-extension://abcdef/popup.html', 1);
    createMockTab(2, 'chrome-extension://abcdef/options.html', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(0);
  });

  it('ignores tabs with missing url', async () => {
    const tabWithoutUrl = createMockTab(1, '', 1);
    (tabWithoutUrl as any).url = undefined;
    createMockTab(2, 'https://example.com/a', 1);
    createMockTab(3, 'https://example.com/b', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(1);
    expect(mockGroups[0].title).toBe('example.com');
  });

  it('ignores tabs with missing id', async () => {
    const tabWithoutId = createMockTab(1, 'https://example.com/a', 1);
    (tabWithoutId as any).id = undefined;
    createMockTab(2, 'https://example.com/b', 1);
    createMockTab(3, 'https://example.com/c', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(1);
    expect(getTabsInGroup(mockGroups[0].id)).toHaveLength(2);
  });

  it('ignores tabs with invalid URLs', async () => {
    createMockTab(1, 'not-a-valid-url', 1);
    createMockTab(2, 'also-invalid', 1);
    createMockTab(3, 'https://example.com/a', 1);
    createMockTab(4, 'https://example.com/b', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(1);
    expect(mockGroups[0].title).toBe('example.com');
  });

  it('ignores pinned tabs', async () => {
    const pinnedTab = createPinnedTab(1, 'https://example.com/a', 1);
    createMockTab(2, 'https://example.com/b', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(0);
    expect(pinnedTab.groupId).toBeUndefined();
  });

  it('groups unpinned tabs even when pinned tabs share the domain', async () => {
    const pinnedTab = createPinnedTab(1, 'https://example.com/a', 1);
    createMockTab(2, 'https://example.com/b', 1);
    createMockTab(3, 'https://example.com/c', 1);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(1);
    expect(pinnedTab.groupId).toBeUndefined();
    expect(mockTabs[1].groupId).toBe(mockGroups[0].id);
    expect(mockTabs[2].groupId).toBe(mockGroups[0].id);
  });

  it('handles mixed groupable and non-groupable tabs across windows', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://github.com/solo', 1);
    createMockTab(4, 'https://google.com/c', 2);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(1);
    expect(mockGroups[0].title).toBe('google.com');
    expect(mockGroups[0].windowId).toBe(1);
  });
});

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
      color: 'blue' as chrome.tabGroups.Color,
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
      color: 'blue' as chrome.tabGroups.Color,
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

describe('dissolveGroupsWithTooFewTabs', () => {
  beforeEach(resetAllMocks);

  it('does not dissolve user-owned groups', async () => {
    const tab = createMockTab(1, 'https://example.com/a', 1);

    const userGroupId = 100;
    (tab as any).groupId = userGroupId;
    mockGroups.push({
      id: userGroupId,
      windowId: 1,
      collapsed: false,
      title: 'My Group',
      color: 'blue' as chrome.tabGroups.Color,
      shared: false,
    });

    await dissolveGroupsWithTooFewTabs(false, new Map());

    expect(tab.groupId).toBe(userGroupId);
  });

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
});

describe('collapseAllGroupsExcept', () => {
  beforeEach(resetAllMocks);

  it('collapses all groups except the specified one', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://github.com/a', 1);
    createMockTab(4, 'https://github.com/b', 1);
    await groupTabsByDomain();

    const googleGroup = findGroupByTitle('google.com');
    const githubGroup = findGroupByTitle('github.com');

    await collapseAllGroupsExcept(googleGroup.id, 1);

    expect(googleGroup.collapsed).toBe(false);
    expect(githubGroup.collapsed).toBe(true);
  });

  it('switches which group is collapsed when a different group is expanded', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://github.com/a', 1);
    createMockTab(4, 'https://github.com/b', 1);
    await groupTabsByDomain();

    const googleGroup = findGroupByTitle('google.com');
    const githubGroup = findGroupByTitle('github.com');

    await collapseAllGroupsExcept(googleGroup.id, 1);
    expect(githubGroup.collapsed).toBe(true);

    githubGroup.collapsed = false;
    await collapseAllGroupsExcept(githubGroup.id, 1);
    expect(googleGroup.collapsed).toBe(true);
  });

  it('does not collapse groups in other windows', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://github.com/a', 2);
    createMockTab(4, 'https://github.com/b', 2);
    await groupTabsByDomain();

    const googleGroup = findGroupByTitle('google.com');
    const githubGroup = findGroupByTitle('github.com');

    await collapseAllGroupsExcept(googleGroup.id, 1);

    expect(googleGroup.collapsed).toBe(false);
    expect(githubGroup.collapsed).toBe(false);
  });

  it('does not update already-collapsed groups', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://github.com/a', 1);
    createMockTab(4, 'https://github.com/b', 1);
    await groupTabsByDomain();

    const githubGroup = findGroupByTitle('github.com');
    githubGroup.collapsed = true;

    chromeMock.tabGroups.update.mockClear();
    await collapseAllGroupsExcept(findGroupByTitle('google.com').id, 1);

    expect(chromeMock.tabGroups.update).not.toHaveBeenCalled();
  });

  it('handles a window with only one group', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    await groupTabsByDomain();

    const googleGroup = findGroupByTitle('google.com');
    chromeMock.tabGroups.update.mockClear();

    await collapseAllGroupsExcept(googleGroup.id, 1);

    expect(googleGroup.collapsed).toBe(false);
    expect(chromeMock.tabGroups.update).not.toHaveBeenCalled();
  });
});

describe('collapseAllInactiveGroups', () => {
  beforeEach(resetAllMocks);

  it('collapses all groups except the one containing the active tab', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://github.com/a', 1);
    createMockTab(4, 'https://github.com/b', 1);
    await groupTabsByDomain();

    setActiveTab(0);
    await collapseAllInactiveGroups();

    const googleGroup = findGroupByTitle('google.com');
    const githubGroup = findGroupByTitle('github.com');
    expect(googleGroup.collapsed).toBe(false);
    expect(githubGroup.collapsed).toBe(true);
  });

  it('collapses all groups when active tab is not in any group', async () => {
    createMockTab(1, 'https://google.com/a', 1);
    createMockTab(2, 'https://google.com/b', 1);
    createMockTab(3, 'https://solo.com', 1);
    await groupTabsByDomain();

    setActiveTab(2);
    await collapseAllInactiveGroups();

    const googleGroup = findGroupByTitle('google.com');
    expect(googleGroup.collapsed).toBe(true);
  });

  it('does nothing when there are no groups', async () => {
    createMockTab(1, 'https://solo.com', 1);
    setActiveTab(0);

    chromeMock.tabGroups.update.mockClear();
    await collapseAllInactiveGroups();

    expect(chromeMock.tabGroups.update).not.toHaveBeenCalled();
  });
});

describe('cleanExtensionGroupIds', () => {
  it('removes stale group IDs that no longer exist', () => {
    const extensionGroupIds = new Map<number, string>([[1, 'google.com'], [2, 'github.com']]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      { id: 1, windowId: 1, collapsed: false, title: 'google.com', color: 'blue' as chrome.tabGroups.Color, shared: false },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.has(1)).toBe(true);
    expect(cleaned.has(2)).toBe(false);
  });

  it('removes groups whose title was renamed by the user', () => {
    const extensionGroupIds = new Map<number, string>([[1, 'google.com']]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      { id: 1, windowId: 1, collapsed: false, title: 'My Search Tabs', color: 'blue' as chrome.tabGroups.Color, shared: false },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.has(1)).toBe(false);
  });

  it('keeps groups whose title still matches', () => {
    const extensionGroupIds = new Map<number, string>([[1, 'google.com']]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      { id: 1, windowId: 1, collapsed: false, title: 'google.com', color: 'blue' as chrome.tabGroups.Color, shared: false },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.has(1)).toBe(true);
    expect(cleaned.get(1)).toBe('google.com');
  });

  it('returns empty map when all groups are stale', () => {
    const extensionGroupIds = new Map<number, string>([[1, 'google.com'], [2, 'github.com']]);
    const existingGroups: chrome.tabGroups.TabGroup[] = [];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.size).toBe(0);
  });

  it('handles empty input map', () => {
    const extensionGroupIds = new Map<number, string>();
    const existingGroups: chrome.tabGroups.TabGroup[] = [
      { id: 1, windowId: 1, collapsed: false, title: 'google.com', color: 'blue' as chrome.tabGroups.Color, shared: false },
    ];

    const cleaned = cleanExtensionGroupIds(extensionGroupIds, existingGroups);

    expect(cleaned.size).toBe(0);
  });
});

describe('integration scenarios', () => {
  beforeEach(resetAllMocks);

  it('groups tabs across multiple windows independently', async () => {
    createMockTab(1, 'https://google.com/search', 1);
    createMockTab(2, 'https://google.com/images', 1);
    createMockTab(3, 'https://stackoverflow.com/q1', 2);
    createMockTab(4, 'https://stackoverflow.com/q2', 2);

    await groupTabsByDomain();

    expect(mockGroups).toHaveLength(2);
    expect(mockGroups.find((g) => g.windowId === 1)?.title).toBe('google.com');
    expect(mockGroups.find((g) => g.windowId === 2)?.title).toBe('stackoverflow.com');
  });

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
});
