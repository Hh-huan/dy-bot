/** 设置页：表单绑定、AI 测试、配置导入导出。 */
import { $, confirmAction, toast } from './dom.js';
import { clamp, debounce, splitLines } from '../core/util.js';
import { AI_PROVIDERS, generateAiReply, providerPreset } from '../core/ai.js';
import { DEFAULT_TTS_VOICE, TTS_VOICES } from '../core/minimaxTts.js';

const ids = {
  myRoomUrl: '#setMyRoomUrl',
  myNickname: '#setMyNickname',
  myUserId: '#setMyUserId',
  dryRun: '#setDryRun',
  autoResumeLive: '#setAutoResumeLive',
  replyInterval: '#setReplyInterval',
  maxPerMin: '#setMaxPerMin',
  maxChars: '#setMaxChars',
  blockedKeywords: '#setBlockedKeywords',
  blockedUsers: '#setBlockedUsers',
  aiEnabled: '#setAiEnabled',
  aiMode: '#setAiMode',
  aiProvider: '#setAiProvider',
  aiKey: '#setAiKey',
  aiPrompt: '#setAiPrompt',
  aiCooldown: '#setAiCooldown',
  aiFallbackEnabled: '#setAiFallbackEnabled',
  aiFallbackProvider: '#setAiFallbackProvider',
  aiFallbackKey: '#setAiFallbackKey',
  dshPetEnabled: '#setDshPetEnabled',
  dshPetSurface: '#setDshPetSurface',
  dshPetTts: '#setDshPetTts',
  dshPetMenu: '#setDshPetMenu',
  dshPetChatBubble: '#setDshPetChatBubble',
  dshIdleAnim: '#setDshIdleAnim',
  dshActionCommands: '#setDshActionCommands',
  dshLikeThanks: '#setDshLikeThanks',
  ttsVoice: '#setTtsVoice',
  ttsVoiceCustom: '#setTtsVoiceCustom',
  ttsKey: '#setTtsKey',
  warmupEnabled: '#setWarmupEnabled',
  warmupIdle: '#setWarmupIdle',
  warmupInterval: '#setWarmupInterval',
  warmupGreetViewer: '#setWarmupGreetViewer',
  warmupSend: '#setWarmupSend',
  warmupBubble: '#setWarmupBubble',
  warmupSpeak: '#setWarmupSpeak',
  warmupPresets: '#setWarmupPresets',
  warmupPrompt: '#setWarmupPrompt',
  boardEnabled: '#setBoardEnabled',
  boardObsUrl: '#boardObsUrl',
  boardPetSlot: '#setBoardPetSlot',
  boardBubbles: '#setBoardBubbles',
  songEnabled: '#setSongEnabled',
  songPrefix: '#setSongPrefix',
  songMinPlay: '#setSongMinPlay',
  songQueueCut: '#setSongQueueCut',
  songDailyRecommend: '#setSongDailyRecommend',
  songHorrorFilter: '#setSongHorrorFilter',
  songPassSec: '#setSongPassSec',
  songReply: '#setSongReply',
};

/**
 * 可选权限：AI 接口 / Webhook 可能位于任意域名。
 * 必须在用户手势（点击、勾选）中调用，否则浏览器会拒绝。
 */
async function ensureOrigins(urls) {
  if (!globalThis.chrome || !chrome.permissions) return true;
  const origins = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.push(`${url.origin}/*`);
    } catch {
      /* 空值或非法地址直接跳过 */
    }
  }
  if (!origins.length) return false;
  const unique = [...new Set(origins)];
  try {
    // 已授权的域名（包括 manifest 里的固定权限）不要再放进 request，
    // 否则 Chrome 可能以「不是可选权限」为由拒绝整个请求。
    if (chrome.permissions.getAll) {
      const all = await chrome.permissions.getAll();
      const granted = new Set(all.origins || []);
      const missing = unique.filter((origin) => !granted.has(origin));
      if (!missing.length) return true;
      return await chrome.permissions.request({ origins: missing });
    }
    return await chrome.permissions.request({ origins: unique });
  } catch {
    return false;
  }
}

export function initSettingsView(ctx) {
  const form = $('#settingsForm');
  const aiStatus = $('#aiStatus');
  const testButton = $('#testAiBtn');

  function node(key) {
    return $(ids[key]);
  }

  function setDshStatus(text, kind = '') {
    const el = $('#dshPetStatus');
    if (!el) return;
    el.textContent = text;
    el.className = `status-line ${kind}`;
  }

  function renderDshState(detail) {
    const info = detail || (ctx.getDshPetState ? ctx.getDshPetState() : {});
    if (!info.enabled) {
      setDshStatus('DSH 桌宠联动未启用');
      return;
    }
    if (info.error) {
      setDshStatus(`连接失败：${info.error}`, 'error');
      return;
    }
    if (info.ok) {
      const count = Array.isArray(info.pets) ? info.pets.length : 0;
      setDshStatus(`已连接${count ? ` · 检测到 ${count} 只桌宠` : ''}`, 'ok');
    } else {
      setDshStatus('正在连接 DSH 桌宠…');
    }
  }

  window.addEventListener('dy-dsh-pet-state', (event) => {
    if (!node('dshPetEnabled').checked) {
      setDshStatus('DSH 桌宠联动未启用');
      return;
    }
    renderDshState(event.detail);
  });

  for (const [value, provider] of Object.entries(AI_PROVIDERS)) {
    node('aiProvider').append(new Option(provider.label, value));
    node('aiFallbackProvider').append(new Option(provider.label, value));
  }

  for (const voice of TTS_VOICES) {
    node('ttsVoice').append(new Option(voice.label, voice.id));
  }
  node('ttsVoice').append(new Option('自定义 voice_id…', '__custom__'));

  function syncTtsVoiceField() {
    const custom = node('ttsVoice').value === '__custom__';
    const field = $('#ttsCustomVoiceField');
    if (field) field.hidden = !custom;
    if (custom && !node('ttsVoiceCustom').value) {
      node('ttsVoiceCustom').value = DEFAULT_TTS_VOICE;
    }
  }

  function boardBaseUrl() {
    const settings = ctx.getSettings();
    return String((settings.board && settings.board.bridgeUrl) || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  }

  function syncBoardUrl() {
    const slot = node('boardPetSlot').value || 'center';
    const target = `${boardBaseUrl()}/board?pet=${encodeURIComponent(slot)}`;
    node('boardObsUrl').value = target;
    return target;
  }

  async function refreshSongProviders(settings) {
    const el = $('#songProviders');
    if (!el) return;
    if (settings && (!settings.songRequest || !settings.songRequest.enabled)) {
      el.textContent = '点歌未启用';
      return;
    }
    el.textContent = '检测中…';
    const data = await ctx.getSongState();
    if (!data || !data.available) {
      el.textContent = '本地桥接未启动';
      return;
    }
    const labels = { qq: 'QQ 音乐' };
    el.textContent = Object.keys(labels)
      .map((key) => `${labels[key]}${data.available[key] ? ' 已安装' : ' 未检测到'}`)
      .join(' · ');
  }

  function render() {
    const settings = ctx.getSettings();
    node('myRoomUrl').value = settings.myRoomUrl || '';
    node('myNickname').value = settings.myNickname || '';
    node('myUserId').value = settings.myUserId || '';
    node('dryRun').checked = Boolean(settings.dryRun);
    node('autoResumeLive').checked = settings.autoResumeLive !== false;
    node('replyInterval').value = String((Number(settings.replyCooldownMs) || 0) / 1000);
    node('maxPerMin').value = String(settings.maxRepliesPerMin);
    node('maxChars').value = String(settings.maxReplyChars);
    node('blockedKeywords').value = (settings.blockedKeywords || []).join('\n');
    node('blockedUsers').value = (settings.blockedUsers || []).join('\n');

    const ai = settings.ai || {};
    node('aiEnabled').checked = Boolean(ai.enabled);
    node('aiMode').value = ai.mode === 'fallback' ? 'fallback' : 'always';
    node('aiProvider').value = ai.provider || 'deepseek';
    node('aiKey').value = ai.apiKey || '';
    node('aiPrompt').value = ai.systemPrompt || '';
    node('aiCooldown').value = String(ai.cooldownSec ?? 5);

    const fallback = ai.fallback || {};
    node('aiFallbackEnabled').checked = ai.fallbackEnabled !== false;
    node('aiFallbackProvider').value = fallback.provider || 'minimax';
    node('aiFallbackKey').value = fallback.apiKey || '';

    const dsh = settings.dshPet || {};
    node('dshPetEnabled').checked = Boolean(dsh.enabled);
    node('dshPetSurface').value = dsh.surface || 'desktop';
    node('dshPetTts').checked = Boolean(dsh.tts);
    node('dshPetMenu').checked = dsh.menu !== false;
    node('dshPetChatBubble').checked = dsh.chatBubble !== false;
    node('dshIdleAnim').checked = dsh.idleAnimEnabled !== false;
    node('dshActionCommands').checked = dsh.actionCommands !== false;
    node('dshLikeThanks').checked = dsh.likeThanks !== false;
    renderDshState();

    const tts = settings.tts || {};
    const voiceId = tts.voiceId || DEFAULT_TTS_VOICE;
    const knownVoice = TTS_VOICES.some((voice) => voice.id === voiceId);
    node('ttsVoice').value = knownVoice ? voiceId : '__custom__';
    node('ttsVoiceCustom').value = knownVoice ? '' : voiceId;
    node('ttsKey').value = tts.apiKey || '';
    syncTtsVoiceField();

    const warmup = settings.warmup || {};
    node('warmupEnabled').checked = Boolean(warmup.enabled);
    node('warmupIdle').value = String(warmup.idleSec ?? 120);
    node('warmupInterval').value = String(warmup.minIntervalSec ?? 180);
    node('warmupGreetViewer').checked = warmup.greetViewer !== false;
    node('warmupSend').checked = warmup.sendToChat !== false;
    node('warmupBubble').checked = warmup.bubble !== false;
    node('warmupSpeak').checked = warmup.speak !== false;
    node('warmupPresets').value = Array.isArray(warmup.presets) ? warmup.presets.join('\n') : '';
    node('warmupPrompt').value = warmup.prompt || '';

    const board = settings.board || {};
    node('boardEnabled').checked = Boolean(board.enabled);
    node('boardPetSlot').value = board.petSlot || 'center';
    node('boardBubbles').value = String(board.avatarBubbles ?? 10);
    syncBoardUrl();

    const song = settings.songRequest || {};
    node('songEnabled').checked = Boolean(song.enabled);
    node('songPrefix').value = song.prefix || '点歌';
    node('songMinPlay').value = String(song.minPlaySec ?? 60);
    node('songQueueCut').value = String(song.queueCutSec ?? 90);
    node('songDailyRecommend').checked = song.dailyRecommend !== false;
    node('songHorrorFilter').checked = song.horrorFilter !== false;
    node('songPassSec').value = String(song.priorityPassSec ?? 600);
    node('songReply').checked = song.reply !== false;
    refreshSongProviders(settings);
  }

  function collect() {
    const previous = ctx.getSettings();
    const intervalSeconds = clamp(Number(node('replyInterval').value) || 0, 0, 60);
    const maxChars = Math.round(clamp(Number(node('maxChars').value) || 60, 10, 100));
    const aiProvider = node('aiProvider').value;
    const fallbackProvider = node('aiFallbackProvider').value;
    const previousFallback = (previous.ai && previous.ai.fallback) || {};
    return {
      myRoomUrl: node('myRoomUrl').value.trim(),
      myNickname: node('myNickname').value.trim(),
      myUserId: node('myUserId').value.trim(),
      dryRun: node('dryRun').checked,
      autoResumeLive: node('autoResumeLive').checked,
      replyCooldownMs: Math.round(intervalSeconds * 1000),
      maxRepliesPerMin: Math.round(clamp(Number(node('maxPerMin').value) || 0, 0, 300)),
      maxRepliesPerUserPerMin: previous.maxRepliesPerUserPerMin,
      maxReplyChars: maxChars,
      maxRulesPerEvent: previous.maxRulesPerEvent,
      maxQueue: previous.maxQueue,
      blockSelfEcho: previous.blockSelfEcho,
      blockedKeywords: splitLines(node('blockedKeywords').value),
      blockedUsers: splitLines(node('blockedUsers').value),
      forwardEvents: false,
      webhookUrl: previous.webhookUrl || '',
      petBridge: { ...previous.petBridge, enabled: false },
      dshPet: {
        ...previous.dshPet,
        enabled: node('dshPetEnabled').checked,
        surface: node('dshPetSurface').value,
        tts: node('dshPetTts').checked,
        menu: node('dshPetMenu').checked,
        chatBubble: node('dshPetChatBubble').checked,
        idleAnimEnabled: node('dshIdleAnim').checked,
        actionCommands: node('dshActionCommands').checked,
        likeThanks: node('dshLikeThanks').checked,
      },
      tts: {
        ...previous.tts,
        voiceId:
          node('ttsVoice').value === '__custom__'
            ? node('ttsVoiceCustom').value.trim() || DEFAULT_TTS_VOICE
            : node('ttsVoice').value,
        apiKey: node('ttsKey').value.trim(),
      },
      warmup: {
        ...previous.warmup,
        enabled: node('warmupEnabled').checked,
        idleSec: Math.round(clamp(Number(node('warmupIdle').value) || 120, 20, 1800)),
        minIntervalSec: Math.round(
          clamp(Number(node('warmupInterval').value) || 180, 30, 3600),
        ),
        greetViewer: node('warmupGreetViewer').checked,
        sendToChat: node('warmupSend').checked,
        bubble: node('warmupBubble').checked,
        speak: node('warmupSpeak').checked,
        presets: [...new Set(
          node('warmupPresets').value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        )].slice(0, 30),
        prompt: node('warmupPrompt').value.trim(),
      },
      board: {
        ...previous.board,
        enabled: node('boardEnabled').checked,
        petSlot: node('boardPetSlot').value || 'center',
        avatarBubbles: Math.round(clamp(Number(node('boardBubbles').value), 0, 30)),
      },
      songRequest: {
        ...previous.songRequest,
        enabled: node('songEnabled').checked,
        prefix: node('songPrefix').value.trim() || '点歌',
        provider: 'qq',
        cooldownSec: 0,
        minPlaySec: Math.round(clamp(Number(node('songMinPlay').value) || 60, 10, 600)),
        queueCutSec: Math.round(clamp(Number(node('songQueueCut').value) || 90, 60, 180)),
        dailyRecommend: node('songDailyRecommend').checked,
        horrorFilter: node('songHorrorFilter').checked,
        priorityGifts:
          !previous.songRequest.priorityGifts || previous.songRequest.priorityGifts === '*'
            ? '小心心'
            : previous.songRequest.priorityGifts,
        priorityPassSec: Math.round(clamp(Number(node('songPassSec').value) || 600, 30, 3600)),
        reply: node('songReply').checked,
      },
      ai: {
        ...previous.ai,
        enabled: node('aiEnabled').checked,
        mode: node('aiMode').value,
        provider: aiProvider,
        baseUrl: providerPreset(aiProvider).baseUrl || previous.ai.baseUrl || '',
        model: providerPreset(aiProvider).model || previous.ai.model || '',
        apiKey: node('aiKey').value.trim(),
        systemPrompt: node('aiPrompt').value,
        cooldownSec: Math.round(clamp(Number(node('aiCooldown').value) || 5, 1, 600)),
        fallbackEnabled: node('aiFallbackEnabled').checked,
        fallback: {
          provider: fallbackProvider,
          baseUrl: providerPreset(fallbackProvider).baseUrl || previousFallback.baseUrl || '',
          model: providerPreset(fallbackProvider).model || previousFallback.model || '',
          apiKey: node('aiFallbackKey').value.trim(),
        },
      },
      ui: { ...previous.ui },
    };
  }

  const autoSave = debounce(() => {
    ctx.applySettings(collect());
  }, 400);

  form.addEventListener('input', autoSave);
  form.addEventListener('change', autoSave);

  function setStatus(text, kind = '') {
    aiStatus.textContent = text;
    aiStatus.className = `status-line ${kind}`;
  }

  node('ttsVoice').addEventListener('change', syncTtsVoiceField);

  testButton.addEventListener('click', async () => {
    const ai = collect().ai;
    if (!ai.apiKey) {
      setStatus('请先填写 API Key', 'error');
      return;
    }
    const urls = [ai.baseUrl];
    if (ai.fallbackEnabled && ai.fallback.apiKey) urls.push(ai.fallback.baseUrl);
    const granted = await ensureOrigins(urls);
    if (!granted) {
      setStatus('未授权访问接口域名，浏览器阻止了请求。请重试并点击「允许」。', 'error');
      return;
    }
    testButton.disabled = true;
    setStatus('正在请求 AI…');
    try {
      const result = await generateAiReply({
        ai,
        event: { type: 'chat', content: '主播这个怎么卖？', user: { nickname: '测试观众' } },
        maxChars: 60,
      });
      setStatus(`AI 回复（${result.provider}）：${result.text}`, 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      testButton.disabled = false;
    }
  });

  async function requestAiOrigins() {
    if (!node('aiEnabled').checked) return;
    const ai = collect().ai;
    const urls = [ai.baseUrl];
    if (ai.fallbackEnabled) urls.push(ai.fallback.baseUrl);
    const granted = await ensureOrigins(urls);
    if (!granted) setStatus('未授权访问 AI 接口域名，自动触发时将无法调用 AI。', 'error');
  }

  node('aiEnabled').addEventListener('change', requestAiOrigins);
  node('aiFallbackEnabled').addEventListener('change', requestAiOrigins);

  $('#exportConfigBtn').addEventListener('click', () => ctx.exportConfig());

  node('boardPetSlot').addEventListener('change', syncBoardUrl);

  $('#testBoardBtn').addEventListener('click', async () => {
    const status = $('#boardStatus');
    status.textContent = '连接中…';
    status.className = 'status-line';
    await ctx.applySettings({ board: collect().board });
    const result = await ctx.testBoard();
    if (result.ok) {
      const version = result.data && result.data.version;
      if (!version) {
        status.textContent = '已连接旧版桥接：请重启 bridge/server.mjs 后再试';
        status.className = 'status-line error';
      } else {
        status.textContent = `已连接 v${version}，事件客户端 ${result.data.eventClients ?? 0} 个`;
        status.className = 'status-line ok';
      }
    } else {
      status.textContent = `连接失败：${result.error || '请先启动 bridge/server.mjs'}`;
      status.className = 'status-line error';
    }
  });

  $('#clearGiftStatsBtn').addEventListener('click', async () => {
    const status = $('#boardStatus');
    if (!confirm('确定清空背景板的礼物统计吗？此操作不可撤销。')) return;
    status.textContent = '正在清空…';
    status.className = 'status-line';
    const result = await ctx.clearGiftStats();
    if (result.ok) {
      status.textContent = '礼物统计已清空';
      status.className = 'status-line ok';
    } else {
      status.textContent = `清空失败：${result.error || '桥接未连接'}`;
      status.className = 'status-line error';
    }
  });

  $('#openBoardBtn').addEventListener('click', () => {
    const url = syncBoardUrl();
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) toast('浏览器拦截了新窗口，请手动打开 OBS 地址', 'warn');
  });

  $('#copyBoardBtn').addEventListener('click', async () => {
    const status = $('#boardStatus');
    const url = syncBoardUrl();
    try {
      await navigator.clipboard.writeText(url);
      status.textContent = 'OBS 地址已复制';
      status.className = 'status-line ok';
    } catch {
      status.textContent = `复制失败，请手动复制：${url}`;
      status.className = 'status-line error';
    }
  });

  $('#testSongBtn').addEventListener('click', async () => {
    const status = $('#songStatus');
    const query = $('#songTestQuery').value.trim();
    if (!query) {
      status.textContent = '先输入歌名';
      status.className = 'status-line error';
      return;
    }
    status.textContent = '搜索并播放中…';
    status.className = 'status-line';
    await ctx.applySettings({ songRequest: collect().songRequest });
    const result = await ctx.testSong(query);
    if (result.ok) {
      const queueText = Number(result.position) > 0 ? `，队列第 ${result.position} 位` : '，正在播放';
      status.textContent = `已点：${result.song.title} - ${result.song.artist}${queueText}`;
      status.className = 'status-line ok';
    } else {
      status.textContent = `失败：${result.error || '未知错误'}`;
      status.className = 'status-line error';
    }
    refreshSongProviders();
  });

  $('#songTestQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#testSongBtn').click();
  });

  $('#warmupNowBtn').addEventListener('click', async () => {
    const status = $('#warmupStatus');
    if (!status) return;
    status.textContent = '正在生成暖场…';
    status.className = 'status-line';
    try {
      await ctx.applySettings({ warmup: collect().warmup });
      const result = await ctx.warmupNow();
      if (result && result.ok) {
        status.textContent = `已暖场：${result.text}`;
        status.className = 'status-line ok';
      } else {
        status.textContent = `失败：${(result && result.error) || '请先绑定直播间'}`;
        status.className = 'status-line error';
      }
    } catch (error) {
      status.textContent = `失败：${error.message}`;
      status.className = 'status-line error';
    }
  });

  $('#testTtsBtn').addEventListener('click', async () => {
    const status = $('#ttsStatus');
    if (!status) return;
    status.textContent = '正在合成…';
    status.className = 'status-line';
    try {
      const result = await ctx.testTts(collect().tts);
      if (result && result.ok) {
        const engine = result.provider === 'browser' ? '浏览器机械音' : 'MiniMax';
        status.textContent = `播放中…（${engine}${result.mode ? ` · ${result.mode}` : ''}）`;
        status.className = 'status-line ok';
      } else {
        status.textContent = `失败：${(result && result.error) || '未知错误'}`;
        status.className = 'status-line error';
      }
    } catch (error) {
      status.textContent = `失败：${error.message}`;
      status.className = 'status-line error';
    }
  });

  $('#testDshPetBtn').addEventListener('click', async () => {
    setDshStatus('正在发送测试气泡…');
    try {
      const dsh = ctx.getSettings().dshPet || {};
      const result = await ctx.testDshPet({
        baseUrl: dsh.baseUrl,
        petId: dsh.petId,
        surface: node('dshPetSurface').value,
      });
      if (result.ok) {
        setDshStatus(`测试气泡已发送 · ${result.petId}`, 'ok');
      } else {
        setDshStatus(`失败：${result.error || '无法连接 DSH 桌宠'}`, 'error');
      }
    } catch (error) {
      setDshStatus(`失败：${error.message}`, 'error');
    }
  });

  $('#refreshDshPetBtn').addEventListener('click', async () => {
    setDshStatus('正在读取宠物列表…');
    try {
      const dsh = ctx.getSettings().dshPet || {};
      const result = await ctx.listDshPets(dsh.baseUrl);
      if (result.ok) {
        setDshStatus(
          `找到 ${result.pets.length} 只桌宠：${result.pets.map((pet) => pet.id).join(' / ')}`,
          'ok',
        );
      } else {
        setDshStatus(`读取失败：${result.error || '请确认 DSH 正在运行'}`, 'error');
      }
    } catch (error) {
      setDshStatus(`读取失败：${error.message}`, 'error');
    }
  });

  $('#importConfigBtn').addEventListener('click', () => $('#importFile').click());

  $('#importFile').addEventListener('change', async (event) => {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await ctx.importConfig(data);
      render();
      toast('配置已导入', 'ok');
    } catch (error) {
      toast(`导入失败：${error.message}`, 'error');
    } finally {
      input.value = '';
    }
  });

  $('#resetAllBtn').addEventListener('click', async () => {
    const confirmed = await confirmAction('确定恢复默认设置和内置规则？当前配置会被覆盖。');
    if (!confirmed) return;
    await ctx.resetAll();
    render();
    toast('已恢复默认配置', 'ok');
  });

  return { render };
}
