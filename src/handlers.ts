const NEW_TAB_URL = 'chrome://newtab/';

type GroupColor = `${chrome.tabGroups.Color}`;
type TabId = number;
type WindowId = number;
type Domain = string;
type TabIdsByDomain = Record<Domain, TabId[]>;
type TabIdsByDomainByWindow = Record<WindowId, TabIdsByDomain>;

const AVAILABLE_GROUP_COLORS: GroupColor[] = [
  'blue',
  'cyan',
  'green',
  'grey',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
];

const extractBaseDomain = (url: string): Domain | null => {
  try {
    const { hostname, protocol } = new URL(url);

    const isBrowserInternalUrl = protocol === 'chrome:' || protocol === 'chrome-extension:';
    if (isBrowserInternalUrl) return null;

    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const getDeterministicColorForDomain = (domain: Domain): GroupColor => {
  const hash = [...domain].reduce(
    (accumulated, char) => (accumulated * 31 + char.charCodeAt(0)) | 0,
    0
  );
  return AVAILABLE_GROUP_COLORS[Math.abs(hash) % AVAILABLE_GROUP_COLORS.length];
};

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

  const extensionOwnedGroup = existingGroupsForDomain.find((g) =>
    extensionGroupIds.has(g.id)
  );

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
        const groupId = await ensureDomainIsGroupedInWindow(domain, tabIds, windowId, extensionGroupIds);
        if (!extensionGroupIds.has(groupId)) {
          newGroups.set(groupId, domain);
        }
      }
    }
  }

  return newGroups;
};

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

export const collapseAllGroupsExcept = async (
  expandedGroupId: number,
  windowId: WindowId
): Promise<void> => {
  const allGroupsInWindow = await chrome.tabGroups.query({ windowId });

  for (const group of allGroupsInWindow) {
    const isAnotherExpandedGroup = group.id !== expandedGroupId && !group.collapsed;
    if (isAnotherExpandedGroup) {
      await chrome.tabGroups.update(group.id, { collapsed: true });
    }
  }
};

export const collapseAllInactiveGroups = async (): Promise<void> => {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeGroupId = activeTab?.groupId ?? -1;
  const allGroups = await chrome.tabGroups.query({});

  for (const group of allGroups) {
    if (group.id !== activeGroupId && !group.collapsed) {
      await chrome.tabGroups.update(group.id, { collapsed: true });
    }
  }
};

export const isValidTabUrl = (url: string | undefined): boolean => {
  return !!url && url !== NEW_TAB_URL;
};

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
