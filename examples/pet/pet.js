/** 参考桌宠：SSE 接收弹幕 / AI 回复，POST 指令控制直播助手。 */
(() => {
  const base =
    location.protocol === 'http:' || location.protocol === 'https:'
      ? location.origin
      : 'http://127.0.0.1:8787';

  const $ = (id) => document.getElementById(id);
  const pet = $('pet');
  const bubble = $('bubble');
  const chatList = $('chatList');
  const onlineEl = $('online');
  const chatPanel = $('chatPanel');
  const replyInput = $('replyInput');

  let ttsEnabled = localStorage.getItem('dy-pet-tts') !== 'off';
  let chatVisible = localStorage.getItem('dy-pet-chat') !== 'off';
  let status = null;
  let bubbleTimer = 0;
  let source = null;

  function setConn(ok, text) {
    const dot = $('connDot');
    dot.className = `conn-dot ${ok ? 'ok' : 'bad'}`;
    $('connText').textContent = text;
  }

  function fmtNumber(value) {
    const n = Number(value) || 0;
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return String(n);
  }

  function speak(text) {
    if (!ttsEnabled || !('speechSynthesis' in window) || !text) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.05;
      utterance.pitch = 1.08;
      utterance.volume = 1;
      window.speechSynthesis.speak(utterance);
    } catch {
      /* ignore */
    }
  }

  function showBubble(text, options = {}) {
    const content = String(text || '').trim();
    if (!content) return;
    bubble.textContent = content;
    bubble.hidden = false;
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
    }, options.duration || 7000);
    if (options.speak) speak(content);
  }

  function animate(name) {
    if (!name) return;
    pet.classList.remove('happy', 'wave', 'talk', 'heart');
    void pet.offsetWidth;
    pet.classList.add(name);
    setTimeout(() => pet.classList.remove(name), 1600);
  }

  function addChat({ who, text, type = 'chat' }) {
    if (!chatList) return;
    const item = document.createElement('li');
    item.className = `msg-${type}`;
    const whoEl = document.createElement('span');
    whoEl.className = 'who';
    whoEl.textContent = `${who || '观众'}：`;
    const msgEl = document.createElement('span');
    msgEl.className = 'msg';
    msgEl.textContent = String(text || '');
    item.append(whoEl, msgEl);
    chatList.append(item);
    while (chatList.children.length > 40) chatList.firstElementChild.remove();
    chatList.scrollTop = chatList.scrollHeight;
  }

  function applyStatus(data) {
    if (!data) return;
    status = data;
    if (data.autoReply) {
      $('autoBtn').textContent = '自动回复 开';
      $('autoBtn').classList.add('on');
    } else {
      $('autoBtn').textContent = '自动回复 关';
      $('autoBtn').classList.remove('on');
    }

    $('dryBtn').textContent = data.dryRun ? '演练中' : '正式发送';
    $('dryBtn').classList.toggle('warn', Boolean(data.dryRun));

    $('aiBtn').textContent = data.aiEnabled ? 'AI 开' : 'AI 关';
    $('aiBtn').classList.toggle('on', Boolean(data.aiEnabled));

    if (data.online) onlineEl.textContent = `在线 ${fmtNumber(data.online)}`;

    if (!data.bridgeConnected) {
      setConn(false, '助手未连接');
    } else if (!data.leader) {
      setConn(false, '助手在另一个窗口运行');
    } else if (!data.roomBound) {
      setConn(true, '请绑定我的直播间');
    } else {
      setConn(true, '助手已连接');
    }
  }

  async function sendCommand(payload) {
    try {
      const response = await fetch(`${base}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!data.delivered) {
        showBubble(data.hint || '直播助手未连接，请打开扩展侧边栏');
      }
      return data;
    } catch {
      showBubble('桥接未启动：请先运行 node bridge/server.mjs');
      return null;
    }
  }

  function handleEvent(payload) {
    if (!payload || !payload.kind) return;

    if (payload.kind === 'status') {
      applyStatus(payload.data);
      return;
    }

    if (payload.kind === 'ai_reply') {
      if (payload.replay) {
        showBubble(payload.text);
        return;
      }
      showBubble(payload.text, { speak: ttsEnabled });
      animate('talk');
      addChat({ who: '桌宠', text: payload.text, type: 'ai' });
      return;
    }

    if (payload.kind === 'reply_sent') {
      if (payload.replay) return;
      showBubble(payload.dryRun ? `[演练] ${payload.text}` : `已发送：${payload.text}`, {
        duration: 4000,
      });
      return;
    }

    if (payload.kind === 'notice') {
      showBubble(payload.text || '桌宠收到一条提醒');
      return;
    }

    if (payload.kind === 'event') {
      const event = payload.event;
      if (!event) return;
      if (event.type === 'stats') {
        const online = event.stats && event.stats.online;
        if (online) onlineEl.textContent = `在线 ${fmtNumber(online)}`;
        return;
      }
      if (event.type === 'chat') {
        addChat({
          who: (event.user && event.user.nickname) || '观众',
          text: event.content,
          type: 'chat',
        });
        return;
      }
      if (event.type === 'gift') {
        const nickname = (event.user && event.user.nickname) || '观众';
        const gift = (event.gift && event.gift.name) || '礼物';
        addChat({ who: nickname, text: `送出 ${gift} ×${event.gift.count || 1}`, type: 'gift' });
        showBubble(`谢谢 ${nickname} 的${gift}！`);
        animate('happy');
        return;
      }
      if (event.type === 'member') {
        addChat({
          who: '系统',
          text: `${(event.user && event.user.nickname) || '有人'} 进入直播间`,
          type: 'system',
        });
        animate('wave');
        return;
      }
      if (event.type === 'follow') {
        showBubble(`谢谢 ${(event.user && event.user.nickname) || '你'} 的关注！`);
        animate('wave');
        return;
      }
      if (event.type === 'like') {
        animate('heart');
        return;
      }
      if (event.type === 'control') {
        showBubble('直播状态发生变化');
      }
    }
  }

  function connect() {
    if (source) {
      try {
        source.close();
      } catch {
        /* ignore */
      }
    }
    try {
      source = new EventSource(`${base}/events?replay=12`);
    } catch {
      setConn(false, '无法创建 EventSource');
      return;
    }
    source.onopen = () => setConn(true, '桥接已连接');
    source.onerror = () => setConn(false, '桥接未连接，自动重试…');
    source.onmessage = (event) => {
      try {
        handleEvent(JSON.parse(event.data));
      } catch {
        /* ignore */
      }
    };
  }

  function toggleTts() {
    ttsEnabled = !ttsEnabled;
    localStorage.setItem('dy-pet-tts', ttsEnabled ? 'on' : 'off');
    $('ttsBtn').textContent = ttsEnabled ? '🔊' : '🔇';
    $('ttsBtn').classList.toggle('off', !ttsEnabled);
    if (!ttsEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  function toggleChat() {
    chatVisible = !chatVisible;
    chatPanel.classList.toggle('collapsed', !chatVisible);
    localStorage.setItem('dy-pet-chat', chatVisible ? 'on' : 'off');
    $('chatToggle').classList.toggle('off', !chatVisible);
  }

  $('autoBtn').addEventListener('click', () => sendCommand({ action: 'toggle_auto_reply' }));
  $('dryBtn').addEventListener('click', () => sendCommand({ action: 'toggle_dry_run' }));
  $('aiBtn').addEventListener('click', () =>
    sendCommand({ action: 'set_ai', enabled: !(status && status.aiEnabled) }),
  );
  $('statusBtn').addEventListener('click', () => sendCommand({ action: 'status' }));
  $('ttsBtn').addEventListener('click', toggleTts);
  $('chatToggle').addEventListener('click', toggleChat);
  $('replyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = replyInput.value.trim();
    if (!text) return;
    const result = await sendCommand({ action: 'reply', text });
    if (result && result.delivered) {
      replyInput.value = '';
      showBubble('已交给直播助手发送');
    }
  });

  $('ttsBtn').textContent = ttsEnabled ? '🔊' : '🔇';
  $('ttsBtn').classList.toggle('off', !ttsEnabled);
  chatPanel.classList.toggle('collapsed', !chatVisible);
  $('chatToggle').classList.toggle('off', !chatVisible);

  connect();

  setInterval(async () => {
    try {
      const response = await fetch(`${base}/status`);
      const data = await response.json();
      if (!status) {
        setConn(Boolean(data.commandClients), data.commandClients ? '助手已连接' : '等待直播助手');
      }
      if (data.commandClients && !data.eventClients) {
        setConn(false, '桥接异常');
      }
    } catch {
      setConn(false, '桥接未启动');
    }
  }, 10000);
})();
