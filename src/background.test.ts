import * as handlers from './handlers';

// Mock handlers
jest.mock('./handlers', () => ({
  groupTabsByDomain: jest.fn().mockResolvedValue(new Map()),
  dissolveGroupsWithTooFewTabs: jest.fn().mockResolvedValue(undefined),
  collapseAllGroupsExcept: jest.fn().mockResolvedValue(undefined),
  collapseAllInactiveGroups: jest.fn().mockResolvedValue(undefined),
  isValidTabUrl: jest.fn().mockReturnValue(true),
  cleanExtensionGroupIds: jest.fn().mockReturnValue(new Map()),
}));

const listeners: Record<string, ((...args: any[]) => void | Promise<void>)[]> = {};

const addListener =
  (name: string) =>
  (callback: (...args: any[]) => void | Promise<void>): void => {
    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(callback);
  };

const triggerListener = async (name: string, ...args: any[]): Promise<void> => {
  if (listeners[name]) {
    for (const cb of listeners[name]) {
      await cb(...args);
    }
  }
};

const chromeMock = {
  runtime: {
    onInstalled: { addListener: addListener('runtime.onInstalled') },
    onStartup: { addListener: addListener('runtime.onStartup') },
  },
  contextMenus: {
    removeAll: jest.fn((cb) => cb()),
    create: jest.fn(),
    onClicked: { addListener: addListener('contextMenus.onClicked') },
  },
  storage: {
    session: {
      get: jest.fn().mockResolvedValue({ extensionGroupIds: {} }),
      set: jest.fn().mockResolvedValue(undefined),
    },
    sync: {
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
    },
    onChanged: { addListener: addListener('storage.onChanged') },
  },
  tabs: {
    query: jest.fn().mockResolvedValue([]),
    onCreated: { addListener: addListener('tabs.onCreated') },
    onUpdated: { addListener: addListener('tabs.onUpdated') },
    onRemoved: { addListener: addListener('tabs.onRemoved') },
  },
  tabGroups: {
    query: jest.fn().mockResolvedValue([]),
    onUpdated: { addListener: addListener('tabGroups.onUpdated') },
  },
};

(globalThis as any).chrome = chromeMock;

describe('background script', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    Object.keys(listeners).forEach((k) => delete listeners[k]);
    chromeMock.storage.session.get.mockResolvedValue({ extensionGroupIds: {} });
    chromeMock.storage.sync.get.mockResolvedValue({});

    jest.isolateModules(() => {
      require('./background'); // eslint-disable-line @typescript-eslint/no-require-imports
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    jest.clearAllMocks();
  });

  it('initializes extension on install', async () => {
    await triggerListener('runtime.onInstalled');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.storage.session.get).toHaveBeenCalledWith({ extensionGroupIds: {} });
    expect(chromeMock.storage.sync.get).toHaveBeenCalledWith({
      groupSingleTabs: false,
      autoCollapseInactive: false,
    });
    expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
  });

  it('initializes extension on startup', async () => {
    await triggerListener('runtime.onStartup');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.storage.session.get).toHaveBeenCalledWith({ extensionGroupIds: {} });
    expect(chromeMock.storage.sync.get).toHaveBeenCalledWith({
      groupSingleTabs: false,
      autoCollapseInactive: false,
    });
    expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
  });

  describe('context menu interactions', () => {
    it('handles toggling single tabs grouping', async () => {
      await triggerListener('contextMenus.onClicked', {
        menuItemId: 'group-single-tabs',
        checked: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(chromeMock.storage.sync.set).toHaveBeenCalledWith({
        groupSingleTabs: true,
      });
      expect(handlers.groupTabsByDomain).toHaveBeenCalled();
    });

    it('handles toggling auto collapse', async () => {
      await triggerListener('contextMenus.onClicked', {
        menuItemId: 'auto-collapse-inactive',
        checked: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(chromeMock.storage.sync.set).toHaveBeenCalledWith({
        autoCollapseInactive: true,
      });
      expect(handlers.collapseAllInactiveGroups).toHaveBeenCalled();
    });
  });

  describe('storage changes', () => {
    it('updates single tab setting on external change', async () => {
      await triggerListener(
        'storage.onChanged',
        {
          groupSingleTabs: { newValue: true },
        },
        'sync'
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
      expect(handlers.groupTabsByDomain).toHaveBeenCalled();
    });

    it('updates auto collapse setting on external change', async () => {
      await triggerListener(
        'storage.onChanged',
        {
          autoCollapseInactive: { newValue: true },
        },
        'sync'
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(chromeMock.contextMenus.removeAll).toHaveBeenCalled();
    });

    it('ignores non-sync area changes', async () => {
      await triggerListener(
        'storage.onChanged',
        {
          groupSingleTabs: { newValue: true },
        },
        'local'
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(chromeMock.contextMenus.removeAll).not.toHaveBeenCalled();
    });
  });

  describe('tab lifecycle events', () => {
    it('schedules processing on tab created if URL is valid', async () => {
      (handlers.isValidTabUrl as jest.Mock).mockReturnValue(true);
      await triggerListener('tabs.onCreated', { url: 'https://example.com' });

      expect(handlers.isValidTabUrl).toHaveBeenCalledWith('https://example.com');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(handlers.groupTabsByDomain).toHaveBeenCalled();
    });

    it('ignores tab creation if URL is invalid', async () => {
      (handlers.isValidTabUrl as jest.Mock).mockReturnValue(false);
      await triggerListener('tabs.onCreated', { url: 'chrome://newtab/' });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(handlers.groupTabsByDomain).not.toHaveBeenCalled();
    });

    it('schedules processing on tab updated to complete', async () => {
      await triggerListener('tabs.onUpdated', 1, { status: 'complete' });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(handlers.groupTabsByDomain).toHaveBeenCalled();
    });

    it('ignores tab update if not complete', async () => {
      await triggerListener('tabs.onUpdated', 1, { status: 'loading' });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(handlers.groupTabsByDomain).not.toHaveBeenCalled();
    });

    it('schedules processing on tab removed', async () => {
      await triggerListener('tabs.onRemoved');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(handlers.groupTabsByDomain).toHaveBeenCalled();
    });

    it('debounces multiple tab events', async () => {
      (handlers.isValidTabUrl as jest.Mock).mockReturnValue(true);

      await triggerListener('tabs.onCreated', { url: 'https://example.com' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await triggerListener('tabs.onUpdated', 1, { status: 'complete' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      await triggerListener('tabs.onRemoved');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(handlers.groupTabsByDomain).toHaveBeenCalledTimes(1);
    });
  });
});

describe('tabGroups events', () => {
  it('collapses groups when auto-collapse is enabled', async () => {
    // Mock that auto-collapse is enabled
    chromeMock.storage.sync.get.mockResolvedValue({
      autoCollapseInactive: true,
      groupSingleTabs: false,
    });

    // Initialize extension
    await triggerListener('runtime.onInstalled');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Clear initial calls
    jest.clearAllMocks();

    // Trigger tab group update
    await triggerListener('tabGroups.onUpdated', {
      id: 123,
      windowId: 1,
      collapsed: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handlers.collapseAllGroupsExcept).toHaveBeenCalledWith(123, 1);
  });

  it('ignores group updates if auto-collapse is disabled', async () => {
    // Mock that auto-collapse is disabled
    chromeMock.storage.sync.get.mockResolvedValue({
      autoCollapseInactive: false,
      groupSingleTabs: false,
    });

    await triggerListener('runtime.onInstalled');
    await new Promise((resolve) => setTimeout(resolve, 0));
    jest.clearAllMocks();

    await triggerListener('tabGroups.onUpdated', {
      id: 123,
      windowId: 1,
      collapsed: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handlers.collapseAllGroupsExcept).not.toHaveBeenCalled();
  });

  it('ignores group updates if group is already collapsed', async () => {
    chromeMock.storage.sync.get.mockResolvedValue({
      autoCollapseInactive: true,
      groupSingleTabs: false,
    });

    await triggerListener('runtime.onInstalled');
    await new Promise((resolve) => setTimeout(resolve, 0));
    jest.clearAllMocks();

    await triggerListener('tabGroups.onUpdated', {
      id: 123,
      windowId: 1,
      collapsed: true, // already collapsed
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handlers.collapseAllGroupsExcept).not.toHaveBeenCalled();
  });
});

describe('edge cases', () => {
  it('handles processTabChanges concurrently (isProcessingTabChanges guard)', async () => {
    // Simulate that processTabChanges is running by forcing the flag
    // To test the early return `if (state.isProcessingTabChanges) return;`
    // First trigger it, and while it's waiting on a promise, trigger again.
    let promiseResolve: (value: any) => void;
    const processPromise = new Promise((resolve) => {
      promiseResolve = resolve;
    });
    (handlers.groupTabsByDomain as jest.Mock).mockReturnValue(processPromise);

    // Trigger first run
    await triggerListener('tabs.onRemoved'); // Debounce start
    await new Promise((resolve) => setTimeout(resolve, 150)); // Debounce trigger

    // First run is now executing and awaiting groupTabsByDomain
    expect(handlers.groupTabsByDomain).toHaveBeenCalledTimes(1);

    // Trigger second run
    await triggerListener('tabs.onRemoved');
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should still only be called once because the first is still processing
    expect(handlers.groupTabsByDomain).toHaveBeenCalledTimes(1);

    // Resolve the first run
    promiseResolve!(new Map());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('isCollapsingGroups guard', () => {
  it('skips tabGroups onUpdated if already collapsing groups', async () => {
    chromeMock.storage.sync.get.mockResolvedValue({
      autoCollapseInactive: true,
      groupSingleTabs: false,
    });
    await triggerListener('runtime.onInstalled');
    await new Promise((resolve) => setTimeout(resolve, 0));
    jest.clearAllMocks();

    // Make collapseAllGroupsExcept take some time
    let promiseResolve: (value: any) => void;
    const processPromise = new Promise((resolve) => {
      promiseResolve = resolve;
    });
    (handlers.collapseAllGroupsExcept as jest.Mock).mockReturnValue(processPromise);

    // First call without awaiting so it can block in the background
    void triggerListener('tabGroups.onUpdated', {
      id: 123,
      windowId: 1,
      collapsed: false,
    });
    // Allow it to start executing
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handlers.collapseAllGroupsExcept).toHaveBeenCalledTimes(1);

    // Second call while first is still running
    // Second call while first is still running
    void triggerListener('tabGroups.onUpdated', {
      id: 456,
      windowId: 1,
      collapsed: false,
    });

    // Should still only be 1 because it's locked
    expect(handlers.collapseAllGroupsExcept).toHaveBeenCalledTimes(1);

    promiseResolve!(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('extension group ids storage', () => {
  it('loads extension group ids on initialization', async () => {
    chromeMock.storage.session.get.mockResolvedValueOnce({
      extensionGroupIds: { '123': 'test.com' },
    });

    await triggerListener('runtime.onInstalled');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Force an event that uses the state to verify it was loaded
    await triggerListener('tabs.onCreated', { url: 'https://test.com' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(handlers.cleanExtensionGroupIds).toHaveBeenCalledWith(
      new Map([[123, 'test.com']]),
      expect.any(Array)
    );
  });

  it('saves extension group ids', async () => {
    // First, need to simulate some group ids being added.
    // This happens inside processTabChanges.
    (handlers.groupTabsByDomain as jest.Mock).mockResolvedValue(new Map([[789, 'example.com']]));

    // Trigger processTabChanges
    await triggerListener('tabs.onCreated', { url: 'https://example.com' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // After processing, it should save the groups
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({
      extensionGroupIds: { '789': 'example.com' },
    });
  });
});

describe('context menu toggle edge cases', () => {
  it('disables auto collapse without collapsing groups', async () => {
    jest.clearAllMocks();
    await triggerListener('contextMenus.onClicked', {
      menuItemId: 'auto-collapse-inactive',
      checked: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.storage.sync.set).toHaveBeenCalledWith({
      autoCollapseInactive: false,
    });
    expect(handlers.collapseAllInactiveGroups).not.toHaveBeenCalled();
  });

  it('ignores unknown context menu items', async () => {
    jest.clearAllMocks();
    await triggerListener('contextMenus.onClicked', {
      menuItemId: 'unknown-item',
      checked: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.storage.sync.set).not.toHaveBeenCalled();
  });
});

describe('storage.onChanged missing properties', () => {
  it('handles undefined newValue correctly', async () => {
    jest.clearAllMocks();

    // storage.onChanged when value is removed (newValue is undefined)
    await triggerListener(
      'storage.onChanged',
      {
        groupSingleTabs: { oldValue: true, newValue: undefined },
        autoCollapseInactive: { oldValue: true, newValue: undefined },
      },
      'sync'
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chromeMock.contextMenus.removeAll).toHaveBeenCalledTimes(2); // one for each
    expect(handlers.groupTabsByDomain).toHaveBeenCalled();
  });
});

describe('isLocalStorageChange guard', () => {
  it('ignores storage.onChanged when initiated locally', async () => {
    jest.clearAllMocks();

    // Simulate local change by mocking chrome.storage.sync.set to trigger onChanged synchronously
    chromeMock.storage.sync.set.mockImplementationOnce(async (_data: any) => {
      // While state.isLocalStorageChange is true, trigger the onChanged event
      await triggerListener(
        'storage.onChanged',
        {
          groupSingleTabs: { newValue: true },
        },
        'sync'
      );
    });

    await triggerListener('contextMenus.onClicked', {
      menuItemId: 'group-single-tabs',
      checked: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The context menu click itself triggers createContextMenu internally inside processTabChanges -> etc?
    // Wait, let's see. handleGroupSingleTabsToggle calls saveSettingToStorage which sets isLocalStorageChange=true.
    // If we mocked it to trigger onChanged, then onChanged should RETURN EARLY and NOT call createContextMenu.
    // Actually, processTabChanges will NOT call createContextMenu, it just processes tabs.
    // storage.onChanged normally calls createContextMenu().
    // Let's verify createContextMenu was NOT called by the storage listener.

    expect(chromeMock.contextMenus.removeAll).not.toHaveBeenCalled();
  });
});
