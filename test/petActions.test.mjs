import test from 'node:test';
import assert from 'node:assert/strict';

import { PET_COMBOS, isTokenBackKeyword, matchPetCombo, parsePetActionCommand, petActionPool, petActionSpeech, petComboSpeech, petIdleSpeech, resolvePetAction, resolvePetComboSteps, TOKEN_BACK_REPLY } from '../extension/app/core/petActions.js';

const animations = {
  clicks: ['点击回应-元气挥手', '点击回应-害羞惊讶'],
  idle: ['待机呼吸休闲'],
  categories: [
    { actions: [
      '优雅女仆舞',
      '小幅度原地360度旋转展示',
      '原地小憩沉眠',
      '吃西瓜',
      '放风筝',
      '中秋赏月吃月饼',
      '撸猫',
      '涮火锅',
      '收红包',
      'token来',
    ] },
  ],
};

test('动作指令识别前缀和直接短语', () => {
  assert.equal(parsePetActionCommand('动作 跳舞'), '跳舞');
  assert.equal(parsePetActionCommand('/动作：转圈'), '转圈');
  assert.equal(parsePetActionCommand('给我放烟花'), '放烟花');
  assert.equal(parsePetActionCommand('来段舞'), '舞');
  assert.equal(parsePetActionCommand('跳个舞'), '跳个舞');
  assert.equal(parsePetActionCommand('主播跳个舞吧'), '跳个舞');
  assert.equal(parsePetActionCommand('你能比个心吗'), '比个心');
  assert.equal(parsePetActionCommand('转一圈'), '转一圈');
  assert.equal(parsePetActionCommand('挥个手'), '挥个手');
  assert.equal(parsePetActionCommand('今天跳舞'), '');
  assert.equal(parsePetActionCommand('做什么'), '');
  // 「我要听 XX」是点歌口令，不能被桌宠动作解析吃掉
  assert.equal(parsePetActionCommand('我要听雨爱司风版'), '');
});

test('吐槽或拒绝的「吃」句子不触发吃东西动作', () => {
  for (const input of ['吃吃吃，吃个屁', '吃个屁', '吃个鬼', '吃你个头', '吃屁', '别吃了', '不想吃', '吃什么吃', '吃不下']) {
    assert.equal(parsePetActionCommand(input), '', input);
  }
  // 正常的吃指令不受影响
  assert.equal(parsePetActionCommand('吃白饭'), '吃白饭');
  assert.equal(parsePetActionCommand('吃饭'), '吃饭');
  assert.equal(parsePetActionCommand('吃吃吃'), '吃吃吃');
});

test('动作指令按桌宠动画名和同义词匹配', () => {
  assert.equal(resolvePetAction('跳舞', animations), '优雅女仆舞');
  assert.equal(resolvePetAction('挥挥手', animations), '点击回应-元气挥手');
  assert.equal(resolvePetAction('转个圈', animations), '小幅度原地360度旋转展示');
  assert.equal(resolvePetAction('睡觉', animations), '原地小憩沉眠');
  assert.equal(resolvePetAction('吃西瓜', animations), '吃西瓜');
  assert.equal(resolvePetAction('转一圈', animations), '小幅度原地360度旋转展示');
  assert.equal(resolvePetAction('挥个手', animations), '点击回应-元气挥手');
  assert.equal(resolvePetAction('中秋', animations), '中秋赏月吃月饼');
  assert.equal(resolvePetAction('火锅', animations), '涮火锅');
  assert.equal(resolvePetAction('完全不存在的动作', animations), null);
});

test('动画池会去重并包含分类动作', () => {
  const pool = petActionPool(animations);
  assert.ok(pool.includes('优雅女仆舞'));
  assert.ok(pool.includes('点击回应-元气挥手'));
  assert.equal(new Set(pool).size, pool.length);
});

test('动作指令会生成带昵称的语音回复', () => {
  assert.match(petActionSpeech('跳舞', '优雅女仆舞', '小明'), /^好呀，小明，.*跳个舞/);
  assert.match(petActionSpeech('挥挥手', '点击回应-元气挥手', '小红'), /^好呀，小红，.*打个招呼/);
  assert.match(petActionSpeech('未知动作', '写代码', '阿伟'), /^好呀，阿伟，.*代码/);
});
test('token来 动作可按名字与别名触发', () => {
  assert.equal(resolvePetAction('token来', animations), 'token来');
  assert.equal(resolvePetAction('金币', animations), 'token来');
  assert.equal(resolvePetAction('收token', animations), 'token来');
  assert.equal(resolvePetAction('吃token', animations), '吃西瓜');
  assert.equal(parsePetActionCommand('动作 token来'), 'token来');
  assert.match(petActionSpeech('token来', 'token来', '小明'), /^好呀，小明，token来啦/);
});

test('token回 相关口令回复固定台词并触发 token来 动作', () => {
  assert.equal(parsePetActionCommand('token回'), 'token回');
  assert.equal(parsePetActionCommand('token回来吧'), 'token回来');
  assert.equal(parsePetActionCommand('回token'), '回token');
  assert.equal(parsePetActionCommand('token还我'), 'token还我');
  assert.equal(parsePetActionCommand('把token还回来'), '把token还回来');
  assert.equal(parsePetActionCommand('给我token回'), 'token回');
  assert.equal(resolvePetAction('token回', animations), 'token来');
  assert.equal(resolvePetAction('回token', animations), 'token来');
  assert.equal(resolvePetAction('token回来', animations), 'token来');
  assert.equal(resolvePetAction('token还我', animations), 'token来');
  assert.equal(petActionSpeech('token回', 'token来', '小明'), 'token来！token来！');
  assert.equal(petActionSpeech('把token还回来', 'token来', '小明'), TOKEN_BACK_REPLY);
  assert.equal(isTokenBackKeyword('token回'), true);
  assert.equal(isTokenBackKeyword('token来'), false);
  assert.equal(TOKEN_BACK_REPLY, 'token来！token来！');
});

test('空闲动作会同步说给大家表演', () => {
  assert.equal(petIdleSpeech('点击回应-开心跃动', () => 0), '给大家表演个开心跃动～');
});

test('组合动作口令可识别，普通动作不会被误判', () => {
  assert.equal(parsePetActionCommand('谢礼三连'), '谢礼三连');
  assert.equal(parsePetActionCommand('动作：鲸鱼秀'), '鲸鱼秀');
  assert.equal(parsePetActionCommand('来个打工三连'), '打工三连');
  assert.equal(matchPetCombo('感谢三连').id, 'thanks');
  assert.equal(matchPetCombo('拜年').id, 'newyear');
  assert.equal(matchPetCombo('跳舞'), null);
  assert.equal(matchPetCombo(''), null);
});

test('组合动作每个步骤都能解析成动画，缺失的步骤会被跳过', () => {
  const steps = [
    '女仆屈膝礼仪', '凭空生花', '放烟花', '蓝鲸现世', '鲸鱼吐泡泡特效', '蝴蝶蜜蜂环绕头顶开花',
    '原地敲击桌面互动', '玩游戏气急败坏', '点击回应-开心跃动', '点击回应-害羞惊讶',
    '点击回应-挠痒咯咯笑', '写代码', '哈欠连天', '吃白饭', '收红包', '写福字', '舞狮头',
  ];
  const animations = { clicks: [], idle: [], categories: [{ actions: steps }] };
  for (const combo of PET_COMBOS) {
    assert.deepEqual(resolvePetComboSteps(combo, animations), combo.steps, combo.label);
  }
  assert.deepEqual(resolvePetComboSteps(PET_COMBOS[0], { categories: [{ actions: ['女仆屈膝礼仪'] }] }), ['女仆屈膝礼仪']);
});

test('组合动作口播会替换昵称并兜底', () => {
  assert.match(petComboSpeech(PET_COMBOS[0], '小明'), /^小明的礼物收到啦/);
  assert.match(petComboSpeech(PET_COMBOS[1], ''), /^大家想看鲸鱼/);
  assert.equal(petComboSpeech(null, '小红'), '小红，给你表演个组合动作「连招」～');
});