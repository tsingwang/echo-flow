const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const read = name => readFileSync(resolve(__dirname, '..', name), 'utf8');
const source = read('assets/lesson.js');

function setup(saved = {}) {
  const values = new Map(Object.entries(saved));
  const handlers = {};
  const played = [];
  const notices = [];
  const navigation = [];
  const elements = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    console: { warn: message => notices.push(message) },
    document: {
      addEventListener: (type, handler) => { handlers[type] = handler; },
      getElementById: id => elements.get(id),
      createElement: () => ({ style: {}, textContent: '' }),
      body: { appendChild: element => elements.set(element.id, element) }
    },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    location: { href: '' },
    audio: {
      volume: 0.2, muted: false, paused: false,
      addEventListener: (type, handler) => { handlers[type] = handler; },
      pause() { this.paused = true; navigation.push('pause'); }
    },
    saveLastPos: () => navigation.push('save'),
    clearShadowGapTimer: () => navigation.push('clear-shadow'),
    shadowAutoPause: true, internalPause: false,
    idx: 1, items: [{}, {}, {}], readMode: 'continuous',
    shadowStartIndex: 1, firstContentIndex: 0,
    prevLessonHref: 'lesson.html#lib/one', nextLessonHref: 'lesson.html#lib/three',
    shortcutsPanel: { hidden: true },
    playSegment: index => played.push(index),
    showNotification: message => notices.push(message)
  });
  vm.runInContext(read('assets/utils.js'), context);
  vm.runInContext('const { findConflict, getShortcutKey } = NCEUtils;', context);
  vm.runInContext(source.slice(
    source.indexOf("const SHORTCUTS_KEY ="),
    source.indexOf('  // 主流程')
  ), context);
  vm.runInContext(source.slice(
    source.indexOf('    audio.volume = 1;'),
    source.indexOf("    const backLink =")
  ), context);
  vm.runInContext(source.slice(
    source.indexOf('    function pauseForNavigation()'),
    source.indexOf('    // 返回')
  ), context);
  vm.runInContext(source.slice(
    source.indexOf('    let volumeToastTimer ='),
    source.indexOf("    const settingsReset =")
  ), context);
  function press(key, target = {}, modifiers = {}) {
    let prevented = false;
    handlers.keydown({ key, target, ...modifiers, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { context, handlers, values, played, notices, navigation, elements, timers, press };
}

test('left/right select sentences without changing volume or navigating lessons', () => {
  const { context, played, press } = setup();
  assert.equal(press('ArrowLeft'), true);
  assert.equal(press('ArrowRight'), true);
  assert.deepEqual(played, [0, 2]);
  assert.equal(context.location.href, '');
  assert.equal(context.audio.volume, 1);
});

test('Ctrl+left/right navigate lessons after saving progress and pausing', () => {
  for (const [key, href] of [['ArrowLeft', 'lesson.html#lib/one'], ['ArrowRight', 'lesson.html#lib/three']]) {
    const { context, navigation, played, press } = setup();
    assert.equal(press(key, {}, { ctrlKey: true }), true);
    assert.equal(context.location.href, href);
    assert.deepEqual(navigation, ['save', 'clear-shadow', 'pause']);
    assert.deepEqual(played, []);
  }
});

test('missing adjacent lessons show a message without navigating or pausing', () => {
  const { context, notices, navigation, press } = setup();
  context.prevLessonHref = '';
  context.nextLessonHref = '';
  press('ArrowLeft', {}, { ctrlKey: true });
  press('ArrowRight', {}, { ctrlKey: true });
  assert.deepEqual(notices, ['没有上一课', '没有下一课']);
  assert.deepEqual(navigation, []);
  assert.equal(context.location.href, '');
});

test('sentence navigation respects the first/last sentence and shadow starting point', () => {
  const { context, played, press } = setup();
  context.idx = 0;
  press('ArrowLeft');
  context.idx = 2;
  press('ArrowRight');
  context.idx = -1;
  context.readMode = 'shadow';
  press('ArrowRight');
  assert.deepEqual(played, [0, 2, 1]);
});

test('editable fields do not trigger navigation shortcuts', () => {
  const { played, navigation, press } = setup();
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      assert.equal(press(key, target), false);
      assert.equal(press(key, target, { ctrlKey: true }), false);
    }
  }
  assert.deepEqual(played, []);
  assert.deepEqual(navigation, []);
});

test('up/down change volume by 10%, persist it and reuse a percentage toast', () => {
  const { context, values, elements, timers, played, navigation, press } = setup({ nce_volume: '0.5' });
  assert.equal(context.audio.volume, 0.5);
  assert.equal(press('ArrowUp'), true);
  assert.equal(context.audio.volume, 0.6);
  assert.equal(values.get('nce_volume'), '0.6');
  const toast = elements.get('volumeToast');
  assert.equal(toast.textContent, '音量 60%');
  assert.equal(press('ArrowDown'), true);
  assert.equal(context.audio.volume, 0.5);
  assert.equal(values.get('nce_volume'), '0.5');
  assert.equal(toast.textContent, '音量 50%');
  assert.equal(elements.size, 1);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(toast.style.opacity, '0');
  assert.deepEqual(played, []);
  assert.deepEqual(navigation, []);
});

test('volume stays within 0–100% and does not change the mute setting', () => {
  const { context, press } = setup();
  context.audio.muted = true;
  press('ArrowUp');
  assert.equal(context.audio.volume, 1);
  for (let i = 0; i < 12; i++) press('ArrowDown');
  assert.equal(context.audio.volume, 0);
  for (let i = 0; i < 12; i++) press('ArrowUp');
  assert.equal(context.audio.volume, 1);
  assert.equal(context.audio.muted, true);
});

test('missing or invalid saved volume uses 100%, valid zero is restored', () => {
  assert.equal(setup().context.audio.volume, 1);
  assert.equal(setup({ nce_volume: '0' }).context.audio.volume, 0);
  for (const value of ['-1', '1.1', 'NaN', 'Infinity', '', 'abc']) {
    const { context, notices } = setup({ nce_volume: value });
    assert.equal(context.audio.volume, 1);
    assert.match(notices[0], /音量无效/);
  }
});

test('nonconflicting custom sentence, volume and lesson keys still work', () => {
  const { context, press, played } = setup({
    nce_volume: '0.5',
    nce_shortcuts: JSON.stringify({ nextSentence: 'j', volumeUp: 'k', nextLesson: 'Ctrl+l' })
  });
  assert.equal(press('j'), true);
  assert.deepEqual(played, [2]);
  assert.equal(press('ArrowRight'), false);
  assert.equal(press('k'), true);
  assert.equal(context.audio.volume, 0.6);
  assert.equal(press('l'), false);
  assert.equal(press('l', {}, { ctrlKey: true }), true);
  assert.equal(context.location.href, 'lesson.html#lib/three');
});

test('saved original volume shortcuts remain supported', () => {
  const { press, played } = setup({
    nce_shortcuts: JSON.stringify({ nextSentence: 'j', volumeUp: 'ArrowUp', volumeDown: 'ArrowDown' })
  });
  assert.equal(press('j'), true);
  assert.deepEqual(played, [2]);
  assert.equal(press('ArrowDown'), true);
  assert.deepEqual(played, [2]);
});

test('saved shortcuts conflicting with new defaults fall back to unique defaults', () => {
  const { press, played, notices } = setup({
    nce_shortcuts: JSON.stringify({ nextSentence: 'ArrowDown' })
  });
  press('ArrowRight');
  assert.deepEqual(played, [2]);
  assert.match(notices[0], /冲突/);
});

test('shortcut panel lists Ctrl course navigation, sentence navigation and volume actions', () => {
  const { context } = setup();
  const shortcuts = JSON.parse(vm.runInContext('JSON.stringify(currentShortcuts)', context));
  assert.equal(shortcuts.prevLesson.label, '上一课');
  assert.equal(shortcuts.nextLesson.label, '下一课');
  assert.equal(shortcuts.prevLesson.key, 'Ctrl+ArrowLeft');
  assert.equal(shortcuts.nextLesson.key, 'Ctrl+ArrowRight');
  assert.equal(shortcuts.prevSentence.key, 'ArrowLeft');
  assert.equal(shortcuts.nextSentence.key, 'ArrowRight');
  assert.equal(shortcuts.volumeUp.key, 'ArrowUp');
  assert.equal(shortcuts.volumeDown.key, 'ArrowDown');
  assert.equal(context.NCEUtils.getKeyDisplayName(shortcuts.prevLesson.key), 'Ctrl+←');
  assert.equal(context.NCEUtils.getKeyDisplayName(shortcuts.nextLesson.key), 'Ctrl+→');
  assert.ok(read('assets/storage.js').includes("'nce_volume'"));
});

test('extra modifiers do not trigger unmodified or Ctrl-only shortcuts', () => {
  const { context, press, played, navigation } = setup();
  for (const modifiers of [
    { altKey: true }, { metaKey: true }, { shiftKey: true },
    { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }
  ]) {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'r', ' ']) {
      assert.equal(press(key, {}, modifiers), false);
    }
  }
  assert.deepEqual(played, []);
  assert.deepEqual(navigation, []);
  assert.equal(context.audio.volume, 1);
});

test('shortcut capture records combinations, ignores modifier-only presses and detects conflicts', () => {
  const { context, values, notices } = setup();
  context.editingAction = 'nextLesson';
  context.editingKbd = null;
  context.finishEditing = key => { context.finishedKey = key; };
  context.cancelEditing = () => { context.cancelled = true; };
  vm.runInContext(source.slice(
    source.indexOf('    function handleShortcutCapture(e)'),
    source.indexOf('    // 完成编辑')
  ), context);
  const capture = (key, modifiers = {}) => context.handleShortcutCapture({
    key, ...modifiers, preventDefault() {}, stopPropagation() {}
  });
  capture('Control', { ctrlKey: true });
  assert.equal(context.finishedKey, undefined);
  capture('ArrowLeft', { ctrlKey: true });
  assert.match(notices.at(-1), /上一课.*冲突/);
  capture('ArrowDown', { ctrlKey: true });
  assert.equal(context.finishedKey, 'Ctrl+ArrowDown');
  assert.equal(JSON.parse(values.get('nce_shortcuts')).nextLesson, 'Ctrl+ArrowDown');
  const reloaded = setup(Object.fromEntries(values));
  assert.equal(reloaded.press('ArrowDown', {}, { ctrlKey: true }), true);
  assert.equal(reloaded.context.location.href, 'lesson.html#lib/three');
  capture('Escape');
  assert.equal(context.cancelled, true);
});
