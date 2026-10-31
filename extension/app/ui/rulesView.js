/** 规则列表与编辑弹窗。 */
import { $, confirmAction, el, toast } from './dom.js';
import { MATCH_MODES, REPLY_MODES, SCOPES, describeRule, normalizeRule } from '../core/rules.js';
import { TEMPLATE_VARIABLES, renderTemplate } from '../core/template.js';
import { splitLines, uid } from '../core/util.js';

export function initRulesView(ctx) {
  const list = $('#rulesList');
  const empty = $('#rulesEmpty');
  const dialog = $('#ruleDialog');
  const form = $('#ruleForm');
  const title = $('#ruleDialogTitle');

  const nameInput = $('#ruleName');
  const scopeSelect = $('#ruleScope');
  const matchSelect = $('#ruleMatchMode');
  const matchField = matchSelect.closest('.field');
  const patternField = $('#patternField');
  const patternsInput = $('#rulePatterns');
  const giftFields = $('#giftFields');
  const giftNamesInput = $('#ruleGiftNames');
  const minGiftInput = $('#ruleMinGiftCount');
  const likeField = $('#likeField');
  const minLikeInput = $('#ruleMinLikeCount');
  const repliesInput = $('#ruleReplies');
  const replyModeSelect = $('#ruleReplyMode');
  const cooldownInput = $('#ruleCooldown');
  const maxPerMinInput = $('#ruleMaxPerMin');
  const perUserOnceInput = $('#rulePerUserOnce');
  const enabledInput = $('#ruleEnabled');
  const preview = $('#rulePreview');

  for (const scope of SCOPES) scopeSelect.append(new Option(scope.label, scope.value));
  for (const mode of MATCH_MODES) matchSelect.append(new Option(mode.label, mode.value));
  for (const mode of REPLY_MODES) replyModeSelect.append(new Option(mode.label, mode.value));

  const varsBox = $('#templateVars');
  if (varsBox) {
    for (const variable of TEMPLATE_VARIABLES) {
      varsBox.append(el('code', { textContent: `{${variable.key}}`, title: variable.desc }));
    }
  }

  function syncScopeFields() {
    const scope = scopeSelect.value;
    const isGift = scope === 'gift';
    const isLike = scope === 'like';
    giftFields.hidden = !isGift;
    likeField.hidden = !isLike;
    matchField.hidden = isGift || isLike;
    patternField.hidden = isGift || isLike;
    if (isGift) {
      patternsInput.value = '';
    }
  }

  function updatePreview() {
    const template = splitLines(repliesInput.value)[0] || '';
    if (!template) {
      preview.textContent = '预览：—';
      return;
    }
    const text = renderTemplate(template, {
      nickname: '小明',
      content: '这个多少钱',
      gift: '小心心',
      count: 2,
      level: 12,
      fansClub: '铁粉团',
      online: '1.2万',
      cumulative: '8.6万',
      time: '20:00:00',
    });
    preview.textContent = `预览：${text}`;
  }

  function openEditor(rule) {
    const isNew = !rule;
    const data = normalizeRule(
      rule || {
        id: uid('rule'),
        name: '',
        enabled: true,
        scope: 'chat',
        matchMode: 'contains',
        replies: [],
        patterns: [],
      },
    );
    $('#ruleId').value = data.id;
    nameInput.value = isNew ? '' : data.name;
    scopeSelect.value = data.scope;
    matchSelect.value = data.matchMode;
    patternsInput.value = data.patterns.join('\n');
    giftNamesInput.value = data.giftNames.join('\n');
    minGiftInput.value = String(data.minGiftCount);
    minLikeInput.value = String(data.minLikeCount);
    repliesInput.value = data.replies.join('\n');
    replyModeSelect.value = data.replyMode;
    cooldownInput.value = String(data.cooldownSec);
    maxPerMinInput.value = String(data.maxPerMin);
    perUserOnceInput.checked = data.perUserOnce;
    enabledInput.checked = data.enabled;
    title.textContent = isNew ? '新建规则' : '编辑规则';
    syncScopeFields();
    updatePreview();
    dialog.showModal();
    setTimeout(() => nameInput.focus(), 30);
  }

  function readForm() {
    return {
      id: $('#ruleId').value || uid('rule'),
      name: nameInput.value.trim(),
      enabled: enabledInput.checked,
      scope: scopeSelect.value,
      matchMode: matchSelect.value,
      patterns: splitLines(patternsInput.value),
      giftNames: splitLines(giftNamesInput.value),
      minGiftCount: Number(minGiftInput.value) || 0,
      minLikeCount: Number(minLikeInput.value) || 1,
      replies: splitLines(repliesInput.value),
      replyMode: replyModeSelect.value,
      cooldownSec: Number(cooldownInput.value) || 0,
      maxPerMin: Number(maxPerMinInput.value) || 0,
      perUserOnce: perUserOnceInput.checked,
    };
  }

  function validate(data) {
    if (!data.name) return '请填写规则名称';
    if (!data.replies.length) return '至少填写一条回复内容';
    if (data.scope === 'chat' && data.matchMode !== 'any' && !data.patterns.length) {
      return '评论规则需要至少一个关键词';
    }
    if (data.matchMode === 'regex') {
      for (const pattern of data.patterns) {
        try {
          new RegExp(pattern);
        } catch {
          return `正则不合法：${pattern}`;
        }
      }
    }
    return '';
  }

  async function saveRule(data) {
    const normalized = normalizeRule(data);
    const rules = ctx.getRules();
    const exists = rules.some((rule) => rule.id === normalized.id);
    const next = exists
      ? rules.map((rule) => (rule.id === normalized.id ? normalized : rule))
      : [...rules, normalized];
    await ctx.saveRules(next);
  }

  function renderCard(rule, index, total) {
    const toggle = el('input', { type: 'checkbox', title: rule.enabled ? '停用规则' : '启用规则' });
    toggle.checked = rule.enabled;
    toggle.addEventListener('change', () => {
      const next = ctx.getRules().map((item) =>
        item.id === rule.id ? normalizeRule({ ...item, enabled: toggle.checked }) : item,
      );
      ctx.saveRules(next);
    });

    const editBtn = el('button', { type: 'button', textContent: '编辑' });
    editBtn.addEventListener('click', () => openEditor(rule));

    const dupBtn = el('button', { type: 'button', textContent: '复制' });
    dupBtn.addEventListener('click', () => {
      const copy = normalizeRule({ ...rule, id: uid('rule'), name: `${rule.name} 副本`, enabled: false });
      ctx.saveRules([...ctx.getRules(), copy]);
    });

    const upBtn = el('button', { type: 'button', textContent: '↑', title: '上移', disabled: index === 0 });
    upBtn.addEventListener('click', () => {
      const next = [...ctx.getRules()];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      ctx.saveRules(next);
    });

    const downBtn = el('button', { type: 'button', textContent: '↓', title: '下移', disabled: index === total - 1 });
    downBtn.addEventListener('click', () => {
      const next = [...ctx.getRules()];
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      ctx.saveRules(next);
    });

    const delBtn = el('button', { type: 'button', textContent: '删除', className: 'danger' });
    delBtn.addEventListener('click', async () => {
      const confirmed = await confirmAction(`确定删除规则「${rule.name}」？删除后不可恢复。`);
      if (!confirmed) return;
      ctx.saveRules(ctx.getRules().filter((item) => item.id !== rule.id));
    });

    return el('article', { className: `rule-card${rule.enabled ? '' : ' off'}` }, [
      el('div', { className: 'rule-head' }, [
        el('div', { className: 'rule-title' }, [
          el('h3', { textContent: rule.name }),
          el('p', { className: 'rule-desc', textContent: describeRule(rule) }),
        ]),
        el('label', { className: 'switch', title: rule.enabled ? '已启用' : '已停用' }, [
          toggle,
          el('span', { className: 'track' }),
        ]),
      ]),
      el('div', {
        className: 'rule-replies',
        textContent: rule.replies.length ? `「${rule.replies[0]}」${rule.replies.length > 1 ? ` 等 ${rule.replies.length} 条` : ''}` : '（未填写回复）',
      }),
      el('div', { className: 'rule-foot' }, [editBtn, dupBtn, upBtn, downBtn, el('span', { className: 'spacer' }), delBtn]),
    ]);
  }

  function render() {
    const rules = ctx.getRules();
    list.textContent = '';
    empty.hidden = rules.length > 0;
    rules.forEach((rule, index) => list.append(renderCard(rule, index, rules.length)));
  }

  $('#addRuleBtn').addEventListener('click', () => openEditor(null));
  $('#ruleCancelBtn').addEventListener('click', () => dialog.close());
  $('#ruleCancelBtn2').addEventListener('click', () => dialog.close());

  scopeSelect.addEventListener('change', () => {
    syncScopeFields();
    updatePreview();
  });
  repliesInput.addEventListener('input', updatePreview);
  matchSelect.addEventListener('change', () => {
    if (matchSelect.value === 'regex') {
      patternsInput.placeholder = '每行一个正则，例如：^求(链接|地址)$';
    } else {
      patternsInput.placeholder = '价格\n怎么买';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = readForm();
    const error = validate(data);
    if (error) {
      toast(error, 'error');
      return;
    }
    await saveRule(data);
    dialog.close();
    toast('规则已保存', 'ok');
  });

  return { render, openEditor };
}
