/**
 * Service Worker：扩展图标点击打开侧边栏；扩展更新后自动刷新直播间标签页。
 *
 * content_scripts 只在页面加载时注入一次，扩展 reload/update 不会重新跑进已经打开的
 * 直播间页面，所以旧页面里还是旧版 bridge.js。这里在安装/更新后用 tabs.reload 自动
 * 刷新当前主播直播间，避免用户手动 F5。
 */

const VERSION = chrome.runtime.getManifest().version;
const SESSION_MARK = 'dy.autoReloadedVersion';
let lastReloadAt = 0;
let reloading = false;

function enableSidePanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }
}

function sessionArea() {
  return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
}

async function chooseLiveTab() {
  const tabs = await chrome.tabs.query({ url: 'https://live.douyin.com/*' });
  if (!tabs.length) return null;

  let roomId = '';
  try {
    const data = await chrome.storage.local.get('dy.settings.v1');
    const settings = (data && data['dy.settings.v1']) || {};
    const match = String(settings.myRoomUrl || '').match(/live\.douyin\.com\/(\d+)/);
    roomId = match ? match[1] : '';
  } catch {
    // 设置还没写入时退回当前激活的直播间
  }

  if (roomId) {
    const own = tabs.filter((tab) => String(tab.url || '').includes(`/${roomId}`));
    if (own.length) return own.find((tab) => tab.active) || own[0];
  }
  return tabs.find((tab) => tab.active) || tabs[0];
}

async function protectLiveTab(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https:\/\/live\.douyin\.com\//.test(tab.url || '')) return;
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch {
    // 标签已关闭或不支持该属性
  }
}

async function protectAllLiveTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://live.douyin.com/*' });
    for (const tab of tabs) await protectLiveTab(tab.id);
  } catch {
    // ignore
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    if (/^https:\/\/live\.douyin\.com\//.test(tab.url || '')) protectLiveTab(tabId);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => protectLiveTab(tabId));
chrome.runtime.onStartup.addListener(protectAllLiveTabs);

async function reloadLiveTab(reason) {
  if (reloading || Date.now() - lastReloadAt < 5000) return;
  reloading = true;
  try {
    const tab = await chooseLiveTab();
    if (!tab || !tab.id) return;
    lastReloadAt = Date.now();
    await chrome.tabs.reload(tab.id, { bypassCache: true });
    console.info(`[dy-assistant] 已自动刷新直播间，让新版内容脚本生效（${reason}）`);
    try {
      chrome.action.setBadgeText({ text: '↻' });
    } catch {
      // 某些浏览器不提供 action badge
    }
    setTimeout(() => {
      try {
        chrome.action.setBadgeText({ text: '' });
      } catch {
        // ignore
      }
    }, 5000);
  } catch (error) {
    console.warn('[dy-assistant] 自动刷新直播间失败，可手动刷新一次', error);
  } finally {
    reloading = false;
  }
}

/**
 * 同一次扩展生命周期内只自动刷新一次；扩展更新时强制刷新。
 * storage.session 在扩展重载后通常会被清空，因此也能覆盖同版本 reload。
 */
async function autoReloadLiveTab(reason, force = false) {
  const session = sessionArea();
  if (!force && session) {
    try {
      const data = await session.get(SESSION_MARK);
      if (data && data[SESSION_MARK] === VERSION) return;
      await session.set({ [SESSION_MARK]: VERSION });
    } catch {
      // 读不到 session 时仍然尝试刷新，避免旧内容脚本卡住
    }
  }
  await reloadLiveTab(reason);
}

async function signalBoard(kind) {
  try {
    const data = await chrome.storage.local.get('dy.settings.v1');
    const settings = (data && data['dy.settings.v1']) || {};
    if (!settings.board || !settings.board.enabled) return;
    const base = String(settings.board.bridgeUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    await fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, at: Date.now() }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // bridge 未启动时忽略
  }
}

async function ensureAppTab() {
  try {
    const data = await chrome.storage.local.get('dy.settings.v1');
    const settings = (data && data['dy.settings.v1']) || {};
    if (!settings.board || !settings.board.enabled) return;
    const appUrl = chrome.runtime.getURL('app/app.html');
    const tabs = await chrome.tabs.query({});
    if (tabs.some((tab) => String(tab.url || '').startsWith(appUrl))) return;
    await chrome.tabs.create({ url: `${appUrl}?background=1`, active: false, pinned: true });
  } catch {
    // 没有 tabs 权限或浏览器拒绝时忽略
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  enableSidePanel();
  // install / update / chrome_update 都刷新一次，确保拿到当前版本的 content script
  autoReloadLiveTab(`installed:${details.reason || 'unknown'}`, true);
  // 已打开的背景板拉一次最新数据，不做整页重载，避免白屏
  signalBoard('board_refresh');
  ensureAppTab();
  protectAllLiveTabs();
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanel();
  autoReloadLiveTab('startup');
  ensureAppTab();
  protectAllLiveTabs();
});

enableSidePanel();
autoReloadLiveTab('worker-start');
ensureAppTab();
protectAllLiveTabs();
