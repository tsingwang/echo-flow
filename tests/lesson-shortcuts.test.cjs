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
  const edited = [];
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
      activeElement: {},
      addEventListener: (type, handler) => { handlers[type] = handler; },
      getElementById: id => elements.get(id),
      querySelector: () => null,
      createElement: () => ({ style: {}, textContent: '', setAttribute() {} }),
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
    openShortcuts: () => { context.shortcutsPanel.hidden = false; },
    closeShortcuts: () => { context.shortcutsPanel.hidden = true; },
    playSegment: index => played.push(index),
    openSentenceEditor: index => edited.push(index),
    showNotification: message => notices.push(message)
  });
  vm.runInContext(read('assets/utils.js'), context);
  vm.runInContext('const { findConflict, getShortcutKey } = NCEUtils;', context);
  vm.runInContext(source.slice(
    source.indexOf("const SHORTCUTS_KEY ="),
    source.indexOf('  // 主流程')
  ), context);
  vm.runInContext(source.slice(
    source.indexOf('    audio.volume = NCEUtils.loadPlaybackVolume'),
    source.indexOf("    const backLink =")
  ), context);
  vm.runInContext(source.slice(
    source.indexOf('    function pauseForNavigation()'),
    source.indexOf('    // 返回')
  ), context);
  vm.runInContext(source.slice(
    source.indexOf('    const showVolumeToast ='),
    source.indexOf("    const settingsReset =")
  ), context);
  function press(key, target = context.document.activeElement, modifiers = {}) {
    let prevented = false;
    handlers.keydown({ key, target, ...modifiers, preventDefault() { prevented = true; } });
    return prevented;
  }
  return { context, handlers, values, played, edited, notices, navigation, elements, timers, press };
}

test('E edits the focused sentence or the current sentence, and supports custom keys', () => {
  const { press, edited, context } = setup();
  assert.equal(press('e'), true);
  assert.deepEqual(edited, [1]);
  press('e', { closest: () => ({ dataset: { idx: '2' } }) });
  assert.deepEqual(edited, [1, 2]);
  press('e', {}, { repeat: true });
  press('e', { tagName: 'INPUT' });
  assert.deepEqual(edited, [1, 2]);
  context.idx = -1;
  press('e');
  assert.deepEqual(edited, [1, 2]);
  const custom = setup({ nce_shortcuts: JSON.stringify({ editSentence: 'j' }) });
  assert.equal(custom.press('e'), false);
  assert.equal(custom.press('j'), true);
  assert.deepEqual(custom.edited, [1]);
});

test('sentence navigation moves stale sentence focus so E edits the new sentence', () => {
  for (const saved of [{}, {
    nce_shortcuts: JSON.stringify({ prevSentence: 'h', nextSentence: 'l', editSentence: 'j' })
  }]) {
    const { context, press, played, edited } = setup(saved);
    const sentences = context.items.map((_, index) => ({
      dataset: { idx: String(index) },
      closest() { return this; },
      focus(options) {
        assert.equal(options.preventScroll, true);
        context.document.activeElement = this;
      }
    }));
    context.listEl = {
      querySelector: selector => sentences.find(sentence =>
        selector === `.sentence[data-idx="${sentence.dataset.idx}"]`)
    };
    context.playSegment = index => { played.push(index); context.idx = index; };
    context.document.activeElement = {
      closest: () => sentences[1]
    };
    const [left, right, edit] = saved.nce_shortcuts ? ['h', 'l', 'j'] : ['ArrowLeft', 'ArrowRight', 'e'];
    for (const key of [right, left, left, left, right]) {
      press(key);
      press(edit);
    }
    assert.deepEqual(played, [2, 1, 0, 0, 1]);
    assert.deepEqual(edited, played);
    assert.equal(context.document.activeElement, sentences[1]);
  }
});

test('E follows sentence navigation even before asynchronous playback updates its index', () => {
  const { context, press, edited } = setup();
  const destination = {
    dataset: { idx: '2' },
    closest() { return this; },
    focus() { context.document.activeElement = this; }
  };
  context.listEl = { querySelector: () => destination };
  context.document.activeElement = { closest: () => ({ dataset: { idx: '1' } }) };
  press('ArrowRight');
  assert.equal(context.idx, 1);
  press('e');
  assert.deepEqual(edited, [2]);
});

test('sentence navigation does not steal focus from controls outside the sentence list', () => {
  const { context, press, played } = setup();
  const control = { tagName: 'BUTTON', closest: () => null };
  context.document.activeElement = control;
  press('ArrowRight');
  assert.deepEqual(played, [2]);
  assert.equal(context.document.activeElement, control);
});

test('dialogs, search, composition and handled keys suppress player and editor shortcuts', () => {
  const { context, press, played, edited, navigation } = setup();
  context.document.querySelector = () => ({ hidden: false });
  for (const key of ['e', ' ', 'ArrowRight', 'ArrowUp', '?']) press(key);
  press('ArrowRight', {}, { ctrlKey: true });
  context.document.querySelector = () => null;
  press('e', {}, { isComposing: true });
  press('ArrowRight', {}, { defaultPrevented: true });
  assert.deepEqual(played, []);
  assert.deepEqual(edited, []);
  assert.deepEqual(navigation, []);
});

test('question mark still toggles the shortcut help while its dialog blocks playback', () => {
  const { context, press, played } = setup();
  assert.equal(press('?'), true);
  assert.equal(context.shortcutsPanel.hidden, false);
  context.document.querySelector = () => context.shortcutsPanel;
  assert.equal(press('ArrowRight'), false);
  assert.deepEqual(played, []);
  assert.equal(press('?'), true);
  assert.equal(context.shortcutsPanel.hidden, true);
});

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

test('lesson back link distinguishes favorite-source entry from home and unknown sources', () => {
  for (const from of [undefined, 'favorites', 'index', 'https://example.com']) {
    const state = setup();
    const attributes = new Map();
    const label = { textContent: '首页' };
    let click;
    state.context.book = 'book 中文';
    state.context.queryParams = { from };
    state.context.qs = selector => selector === '#backLinkLabel' ? label : null;
    state.context.backLink = {
      setAttribute: (name, value) => attributes.set(name, value),
      addEventListener(type, handler) { if (type === 'click') click = handler; }
    };
    vm.runInContext(source.slice(
      source.indexOf('    // 返回'),
      source.indexOf('    // 自定义播放器控制')
    ), state.context);
    const favoriteSource = from === 'favorites';
    const destination = favoriteSource ? 'favorites.html' : `index.html#${encodeURIComponent('book 中文')}`;
    assert.equal(label.textContent, favoriteSource ? '返回' : '首页');
    assert.equal(attributes.get('aria-label'), favoriteSource ? '返回收藏' : '首页');
    assert.equal(attributes.get('title'), attributes.get('aria-label'));
    assert.equal(attributes.get('href'), destination);
    let prevented = false;
    click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(state.context.location.href, destination);
    assert.deepEqual(state.navigation, ['save', 'clear-shadow', 'pause']);
  }
  assert.match(read('lesson.html'), /id="backLinkLabel">首页<\/span>/);
});

test('neighbor navigation and automatic next lesson preserve favorite origin without changing the HTML cache URL', async () => {
  for (const from of [undefined, 'favorites']) {
    const state = setup();
    const context = state.context;
    Object.assign(context, {
      book: 'lib', base: 'two', queryParams: { from },
      prevLessonLink: { style: {} }, nextLessonLink: { style: {} },
      getLibrary: async () => [{ filename: 'one' }, { filename: 'two' }, { filename: 'three' }],
      getNextLesson: async () => ({ filename: 'three', title: 'Third' }),
      sessionStorage: { setItem() {} }, LASTPOS_KEY: 'nce_lastpos'
    });
    context.window = context;
    vm.runInContext(source.slice(
      source.indexOf('    function lessonHref('),
      source.indexOf('    const inModern =')
    ), context);
    vm.runInContext(source.slice(
      source.indexOf('    async function resolveLessonNeighbors()'),
      source.indexOf('    // 启动：')
    ), context);
    vm.runInContext(source.slice(
      source.indexOf('    async function autoNextLesson()'),
      source.indexOf('    async function resolveLessonNeighbors()')
    ), context);
    const suffix = from === 'favorites' ? '?from=favorites' : '';
    await context.resolveLessonNeighbors();
    assert.equal(context.prevLessonHref, `lesson.html#lib/one${suffix}`);
    assert.equal(context.nextLessonHref, `lesson.html#lib/three${suffix}`);
    assert.equal(context.prevLessonLink.href, context.prevLessonHref);
    assert.equal(context.nextLessonLink.href, context.nextLessonHref);
    const url = new URL(context.nextLessonHref, 'https://app.example/');
    assert.equal(url.search, '');
    assert.equal(url.pathname, '/lesson.html');
    await context.autoNextLesson();
    [...state.timers.values()].at(-1)();
    assert.equal(context.location.href, `lesson.html#lib/three${suffix}`);
  }
});
