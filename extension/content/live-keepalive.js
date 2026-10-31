/**
 * 抖音直播间播放保活：
 * 页面因为后台节流、缓冲或播放器自身逻辑暂停时，自动点一下播放。
 * 可在侧边栏「设置 → 直播」关闭。
 */
(() => {
  const ext = globalThis.chrome;
  if (!ext || !ext.runtime) return;

  const SETTINGS_KEY = 'dy.settings.v1';
  let enabled = true;
  let lastPlayAt = 0;
  let resumeTimer = 0;

  function largestVideo() {
    const videos = [...document.querySelectorAll('video')].filter(
      (video) =>
        video.isConnected &&
        !video.ended &&
        video.readyState >= 2 &&
        video.clientWidth > 120 &&
        video.clientHeight > 80,
    );
    videos.sort(
      (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
    );
    return videos[0] || null;
  }

  function resume() {
    if (!enabled) return;
    const video = largestVideo();
    if (!video || !video.paused) return;
    const now = Date.now();
    if (now - lastPlayAt < 1500) return;
    lastPlayAt = now;
    video.play().catch(() => {
      // 浏览器自动播放策略可能拦截；用户点过页面后下一次会成功
    });
  }

  function scheduleResume() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = 0;
      resume();
    }, 700);
  }

  document.addEventListener(
    'pause',
    (event) => {
      if (event.target instanceof HTMLVideoElement) scheduleResume();
    },
    true,
  );
  document.addEventListener(
    'canplay',
    (event) => {
      if (event.target instanceof HTMLVideoElement && event.target.paused) {
        scheduleResume();
      }
    },
    true,
  );
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleResume();
  });
  window.addEventListener('focus', scheduleResume);

  setInterval(resume, 3000);
  setTimeout(resume, 1800);

  ext.storage.local
    .get(SETTINGS_KEY)
    .then((data) => {
      const settings = data && data[SETTINGS_KEY];
      enabled = !settings || settings.autoResumeLive !== false;
    })
    .catch(() => {});
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    const settings = changes[SETTINGS_KEY].newValue || {};
    enabled = settings.autoResumeLive !== false;
  });
})();