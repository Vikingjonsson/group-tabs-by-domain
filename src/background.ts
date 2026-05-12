import {
  groupTabsByDomain,
  dissolveGroupsWithTooFewTabs,
  collapseAllGroupsExcept,
  collapseAllInactiveGroups,
  isValidTabUrl,
  cleanExtensionGroupIds,
} from './handlers';

const STORAGE_KEY_GROUP_SINGLE_TABS = 'groupSingleTabs';
const STORAGE_KEY_AUTO_COLLAPSE = 'autoCollapseInactive';
const STORAGE_KEY_EXTENSION_GROUP_IDS = 'extensionGroupIds';
const MENU_ID_GROUP_SINGLE_TABS = 'group-single-tabs';
const MENU_ID_AUTO_COLLAPSE = 'auto-collapse-inactive';
const DEBOUNCE_DELAY_MS = 100;

const state = {
  shouldGroupSingleTabs: false,
  shouldAutoCollapseInactive: false,
  isLocalStorageChange: false,
  isProcessingTabChanges: false,
  isCollapsingGroups: false,
  tabChangeDebounceTimer: null as ReturnType<typeof setTimeout> | null,
  extensionGroupIds: new Map<number, string>(),
};

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

const scheduleTabProcessing = (): void => {
  if (state.tabChangeDebounceTimer) clearTimeout(state.tabChangeDebounceTimer);
  state.tabChangeDebounceTimer = setTimeout(processTabChanges, DEBOUNCE_DELAY_MS);
};

const saveSettingToStorage = async (key: string, value: boolean): Promise<void> => {
  state.isLocalStorageChange = true;
  await chrome.storage.sync.set({ [key]: value });
  state.isLocalStorageChange = false;
};

const createContextMenu = (): void => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID_GROUP_SINGLE_TABS,
      title: 'Group single tabs',
      type: 'checkbox',
      checked: state.shouldGroupSingleTabs,
      contexts: ['action'],
    });
    chrome.contextMenus.create({
      id: MENU_ID_AUTO_COLLAPSE,
      title: 'Auto-collapse inactive groups',
      type: 'checkbox',
      checked: state.shouldAutoCollapseInactive,
      contexts: ['action'],
    });
  });
};

const refreshSettingsFromStorage = async (): Promise<void> => {
  const storedSettings = await chrome.storage.sync.get({
    [STORAGE_KEY_GROUP_SINGLE_TABS]: false,
    [STORAGE_KEY_AUTO_COLLAPSE]: false,
  });

  state.shouldGroupSingleTabs = storedSettings[STORAGE_KEY_GROUP_SINGLE_TABS] as boolean;
  state.shouldAutoCollapseInactive = storedSettings[STORAGE_KEY_AUTO_COLLAPSE] as boolean;
};

const handleGroupSingleTabsToggle = async (isChecked: boolean): Promise<void> => {
  state.shouldGroupSingleTabs = isChecked;
  await saveSettingToStorage(STORAGE_KEY_GROUP_SINGLE_TABS, isChecked);
  await processTabChanges();
};

const handleAutoCollapseToggle = async (isChecked: boolean): Promise<void> => {
  state.shouldAutoCollapseInactive = isChecked;
  await saveSettingToStorage(STORAGE_KEY_AUTO_COLLAPSE, isChecked);
  if (isChecked) {
    await collapseAllInactiveGroups();
  }
};

const initializeExtension = async (): Promise<void> => {
  await loadExtensionGroupIds();
  await refreshSettingsFromStorage();
  createContextMenu();
};

chrome.runtime.onInstalled.addListener(() => {
  initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  initializeExtension();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === MENU_ID_GROUP_SINGLE_TABS) {
    await handleGroupSingleTabsToggle(!!info.checked);
  } else if (info.menuItemId === MENU_ID_AUTO_COLLAPSE) {
    await handleAutoCollapseToggle(!!info.checked);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || state.isLocalStorageChange) return;

  if (changes[STORAGE_KEY_GROUP_SINGLE_TABS]) {
    state.shouldGroupSingleTabs = (changes[STORAGE_KEY_GROUP_SINGLE_TABS].newValue ??
      false) as boolean;
    createContextMenu();
    processTabChanges();
  }

  if (changes[STORAGE_KEY_AUTO_COLLAPSE]) {
    state.shouldAutoCollapseInactive = (changes[STORAGE_KEY_AUTO_COLLAPSE].newValue ??
      false) as boolean;
    createContextMenu();
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (isValidTabUrl(tab.url)) {
    scheduleTabProcessing();
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    scheduleTabProcessing();
  }
});

chrome.tabs.onRemoved.addListener(() => {
  scheduleTabProcessing();
});

chrome.tabGroups.onUpdated.addListener(async (updatedGroup) => {
  await refreshSettingsFromStorage();

  const shouldSkip =
    !state.shouldAutoCollapseInactive || state.isCollapsingGroups || updatedGroup.collapsed;
  if (shouldSkip) return;

  state.isCollapsingGroups = true;
  try {
    await collapseAllGroupsExcept(updatedGroup.id, updatedGroup.windowId);
  } finally {
    state.isCollapsingGroups = false;
  }
});
