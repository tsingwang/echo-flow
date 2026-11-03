const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const read = name => readFileSync(resolve(__dirname, '..', name), 'utf8');
const key = 'nce_sentence_favs_v1';
const collections = [
  { id: 'book-b', name: 'Book B' },
  { id: 'book-a', name: 'Book <A>' },
  { id: 'book-empty', name: 'Empty' }
];
const favorites = [
  { id: 'book-a/first::0', book: 'book-a', base: 'first', lessonId: 'book-a/first', en: 'A0', idx: 0, start: 1 },
  { id: 'book-b/second::0', lessonId: 'book-b/second', en: 'B0', idx: 0, start: 2 },
  { id: 'book-a/first::1', book: 'book-a', base: 'first', en: 'A1', idx: 1, start: 3 },
  { id: 'book-b/second::1', en: 'B1', idx: 1, start: 4 },
  { id: 'removed/old::0', book: 'removed', en: 'Deleted', idx: 0 },
  { id: 'legacy-id', en: 'Unknown', idx: 0 }
];

function element() {
  const handlers = {};
  const attributes = new Map();
  return {
    hidden: false, disabled: false, style: {}, value: '', textContent: '', innerHTML: '',
    options: [],
    classList: { add() {}, remove() {} },
    addEventListener(type, handler) { (handlers[type] ??= []).push(handler); },
    removeEventListener(type, handler) { handlers[type] = (handlers[type] || []).filter(fn => fn !== handler); },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute: name => attributes.get(name),
    removeAttribute: name => attributes.delete(name),
    appendChild(node) { this.options.push(node); },
    querySelector: () => null,
    contains: () => true,
    dispatch(type, event = {}) {
      return Promise.all((handlers[type] || []).map(handler => handler(event)));
    }
  };
}

async function setup({
  items = favorites, books = collections, failCollections = false, loop = 'off', tts = true,
  lessons = {}, autoMetadata = true, autoSeek = true, getLesson, rate, shortcuts, volume, historyLength = 1
} = {}) {
  const values = new Map([[key, JSON.stringify(items)], ['nce_tts_loop', loop]]);
  if (rate !== undefined) values.set('nce_tts_rate', rate);
  if (shortcuts !== undefined) values.set('nce_shortcuts', typeof shortcuts === 'string' ? shortcuts : JSON.stringify(shortcuts));
  if (volume !== undefined) values.set('nce_volume', volume);
  const nodes = new Map([
    'favSub', 'favSentences', 'favoriteCollectionBar', 'favoriteCollectionTabs', 'favoriteCollectionStatus',
    'ttsPrev', 'ttsNext', 'ttsPlayPause', 'ttsPos', 'ttsOverlay', 'ttsPanel', 'ttsLoopSelect',
    'clearListBtn', 'clearListDescription', 'searchModal', 'ttsRateSelect', 'ttsVoice', 'backBtn'
  ].map(id => [id, element()]));
  const homeMarkup = read('favorites.html').match(/<a id="backBtn"[^>]*>/)[0];
  nodes.get('backBtn').setAttribute('href', homeMarkup.match(/href="([^"]+)"/)[1]);
  nodes.get('favoriteCollectionBar').hidden = true;
  nodes.get('ttsPanel').hidden = true;
  nodes.get('searchModal').hidden = true;
  const document = Object.assign(element(), {
    getElementById: id => nodes.get(id) || null,
    querySelector(selector) {
      if (selector.startsWith('dialog[open]')) {
        return ['ttsPanel', 'searchModal'].map(id => nodes.get(id)).find(node => !node.hidden) || null;
      }
      return nodes.get(selector.slice(1)) || null;
    },
    createElement: () => element(),
    body: {
      appendChild(node) {
        if (node.id) nodes.set(node.id, node);
        else notices.push(node.textContent);
      },
      removeChild() {}
    }
  });
  const sourceButtons = new Map();
  nodes.get('favSentences').querySelector = selector => {
    const match = /^\.fav-item\[data-i="(\d+)"\] \[data-action="jump"\]$/.exec(selector);
    if (!match) return null;
    const index = Number(match[1]);
    if (!sourceButtons.has(index)) {
      const button = element();
      const label = element();
      button.querySelector = selector => selector === '.source-link-label' ? label : null;
      sourceButtons.set(index, button);
    }
    return sourceButtons.get(index);
  };
  const timers = new Map();
  const notices = [];
  const warnings = [];
  const speech = [];
  const confirmations = [];
  const calls = { cancel: 0, pause: 0, resume: 0, historyBack: 0, spokenWhilePaused: 0, reads: [], plays: [], seeks: [], created: [], revoked: [] };
  const resources = new Map(Object.entries(lessons));
  const blobs = new Map();
  const windowEvents = element();
  let audioTime = 0;
  const audio = Object.assign(element(), {
    src: '', readyState: 0, duration: NaN, seeking: false, paused: true, ended: false, playbackRate: 1,
    autoMetadata, autoSeek, playError: null,
    load() {
      this.ended = false;
      this.readyState = 0;
      this.duration = NaN;
      if (this.src && this.autoMetadata) this.finishMetadata();
    },
    finishMetadata() {
      this.duration = blobs.get(this.src)?.duration ?? 20;
      this.readyState = 1;
      return this.dispatch('loadedmetadata');
    },
    finishSeek() { this.seeking = false; return this.dispatch('seeked'); },
    play() {
      calls.plays.push({ src: this.src, time: this.currentTime, rate: this.playbackRate });
      if (this.playError) return Promise.reject(this.playError);
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    advance(time) { audioTime = time; return this.dispatch('timeupdate'); },
    finish() { audioTime = this.duration; this.ended = true; this.paused = true; return this.dispatch('ended'); }
  });
  Object.defineProperty(audio, 'currentTime', {
    get: () => audioTime,
    set(value) { audioTime = value; calls.seeks.push(value); audio.seeking = !audio.autoSeek; }
  });
  nodes.set('favoriteAudio', audio);
  let nextTimer = 0;
  let select;
  let tabs;
  let failWrite = false;
  let accepted = true;
  const synth = {
    paused: false,
    cancel() { calls.cancel++; },
    speak(utterance) { speech.push(utterance); if (this.paused) calls.spokenWhilePaused++; },
    pause() { calls.pause++; this.paused = true; },
    resume() { calls.resume++; this.paused = false; }, addEventListener() {},
    getVoices: () => []
  };
  const context = vm.createContext({
    document,
    console: { error() {}, warn: message => warnings.push(message) },
    localStorage: {
      getItem: name => values.get(name) ?? null,
      setItem(name, value) {
        if (failWrite) throw new Error('Storage blocked');
        values.set(name, value);
      },
      removeItem: name => values.delete(name)
    },
    sessionStorage: { setItem() {}, removeItem() {} },
    location: { href: '' },
    history: {
      length: historyLength,
      back() { calls.historyBack++; context.location.href = 'lesson.html#book-a/first?from=favorites'; }
    },
    matchMedia: () => ({ matches: false }),
    addEventListener: windowEvents.addEventListener,
    setTimeout(callback, delay = 0) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    confirm(message) { confirmations.push(message); return accepted; },
    NCE_RESOURCES: {
      getLesson(book, filename) {
        calls.reads.push([book, filename]);
        return getLesson ? getLesson(book, filename) : (resources.get(`${book}/${filename}`) || null);
      },
      listLessons: async () => [...resources].map(([id, record]) => ({
        id, hasAudio: !!record.audioBlob, hasLrc: !!record.lrcText
      })),
      listCollections: async () => {
        if (failCollections) throw new Error('Database unavailable');
        return books;
      }
    },
    URL: {
      createObjectURL(blob) {
        const url = `blob:favorite/${calls.created.length + 1}`;
        calls.created.push(url);
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL(url) { calls.revoked.push(url); blobs.delete(url); }
    },
    NCE_COLLECTIONS: {
      bindTabs(root, handler) { select = handler; },
      renderTabs(root, filters, selected, busy, options) {
        tabs = { filters: structuredClone(filters), selected, busy, options: { ...options } };
      }
    }
  });
  context.window = context;
  if (tts) {
    context.speechSynthesis = synth;
    context.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; }
    };
  }
  vm.runInContext(read('assets/utils.js'), context);
  vm.runInContext(read('assets/favorites.js'), context);
  await document.dispatch('DOMContentLoaded');
  await new Promise(resolve => setImmediate(resolve));
  const clickAction = (action, data) => document.dispatch('click', {
    target: { closest: selector => selector === '[data-action]' ? { dataset: { action, ...data } } : null },
    preventDefault() {}, stopPropagation() {}
  });
  return {
    context, calls, speech, confirmations, notices, warnings, values, audio, resources, timers,
    get: id => nodes.get(id), tabs: () => tabs,
    source: index => sourceButtons.get(index),
    select: id => select(id),
    saved: () => JSON.parse(values.get(key)),
    remove: id => clickAction('remove', { id }),
    jump: index => clickAction('jump', { i: String(index) }),
    leave: () => windowEvents.dispatch('pagehide'),
    focus: () => windowEvents.dispatch('focus'),
    storage: name => windowEvents.dispatch('storage', { key: name }),
    async home() {
      let prevented = false;
      await nodes.get('backBtn').dispatch('click', { preventDefault() { prevented = true; } });
      if (!prevented) {
        await windowEvents.dispatch('pagehide');
        context.location.href = nodes.get('backBtn').getAttribute('href');
      }
      return prevented;
    },
    row: index => document.dispatch('click', {
      target: { closest: selector => selector === '.fav-item' ? { dataset: { i: String(index) } } : null }
    }),
    async press(key, target = {}, modifiers = {}) {
      let prevented = false;
      await document.dispatch('keydown', {
        key, target, ...modifiers, preventDefault() { prevented = true; }
      });
      return prevented;
    },
    setAccepted: value => { accepted = value; },
    failWrites: () => { failWrite = true; },
    async flush() {
      await new Promise(resolve => setImmediate(resolve));
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 0) continue;
        timers.delete(id);
        timer.callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('collection filters follow home order, count favorites and never enable reordering', async () => {
  const state = await setup();
  const tabs = state.tabs();
  assert.deepEqual(Array.from(tabs.filters, item => item.id), ['all', 'book-b', 'book-a', 'book-empty', 'deleted']);
  assert.deepEqual(Array.from(tabs.filters, item => item.name), [
    '全部 (6)', 'Book B (2)', 'Book <A> (2)', 'Empty (0)', '已删除合集 (2)'
  ]);
  assert.equal(tabs.options.reorderable, false);
  assert.equal(state.get('favoriteCollectionBar').hidden, false);
  assert.equal(state.get('favoriteCollectionStatus').hidden, true);
  assert.equal(state.get('favSub').textContent, '共收藏 6 句');
  assert.equal(state.get('ttsPos').textContent, '1/6');
});

test('filtering changes only the visible subset and supports legacy source identifiers', async () => {
  const state = await setup({ lessons: { 'book-b/second': { audioBlob: {}, lrcText: '[00:00]B0' } } });
  state.select('book-b');
  const html = state.get('favSentences').innerHTML;
  assert.match(html, /B0/);
  assert.match(html, /B1/);
  assert.doesNotMatch(html, />A0<|>A1<|>Deleted<|>Unknown</);
  assert.equal(state.get('favSub').textContent, '当前分类 2 句 · 共收藏 6 句');
  assert.equal(state.get('ttsPos').textContent, '1/2');
  assert.deepEqual(state.saved(), favorites);
  await state.jump(1);
  assert.equal(state.context.location.href, 'lesson.html#book-b/second?from=favorites');
  state.select('deleted');
  assert.match(state.get('favSentences').innerHTML, /Deleted/);
  assert.match(state.get('favSentences').innerHTML, /Unknown/);
});

test('single removal persists the full list and does not erase hidden categories', async () => {
  const state = await setup();
  state.select('book-b');
  await state.remove('book-b/second::0');
  assert.deepEqual(state.saved(), favorites.filter(item => item.id !== 'book-b/second::0'));
  assert.doesNotMatch(state.get('favSentences').innerHTML, />B0</);
  assert.match(state.get('favSentences').innerHTML, />B1</);
  assert.equal(state.get('ttsPos').textContent, '1/1');
  assert.equal(state.tabs().selected, 'book-b');
});

test('clear list confirms and clears only the current collection, retaining its empty filter', async () => {
  const state = await setup();
  state.select('book-a');
  assert.match(state.get('clearListDescription').textContent, /Book <A>.*2 句/);
  await state.get('clearListBtn').dispatch('click');
  assert.match(state.confirmations[0], /Book <A>.*2 句/);
  assert.deepEqual(state.saved(), favorites.filter(item => item.book !== 'book-a'));
  assert.equal(state.tabs().selected, 'book-a');
  assert.match(state.get('favSentences').innerHTML, /当前分类还没有收藏句子/);
  assert.equal(state.get('ttsPos').textContent, '0/0');
  assert.equal(state.get('clearListBtn').disabled, true);
  const remaining = state.saved();
  await state.get('clearListBtn').dispatch('click');
  assert.deepEqual(state.saved(), remaining);
  state.select('all');
  assert.equal(state.get('ttsPos').textContent, '1/4');
});

test('clear all acts on every collection, cancellation changes nothing and empty filters cannot clear', async () => {
  const state = await setup();
  state.setAccepted(false);
  await state.get('clearListBtn').dispatch('click');
  assert.match(state.confirmations[0], /全部收藏.*6 句/);
  assert.deepEqual(state.saved(), favorites);
  state.select('book-empty');
  assert.equal(state.get('clearListBtn').disabled, true);
  await state.get('clearListBtn').dispatch('click');
  assert.equal(state.confirmations.length, 1);
  state.select('all');
  state.setAccepted(true);
  await state.get('clearListBtn').dispatch('click');
  assert.deepEqual(state.saved(), []);
  assert.equal(state.get('ttsPos').textContent, '0/0');
});

test('clearing deleted collection favorites preserves all live collection favorites', async () => {
  const state = await setup();
  state.select('deleted');
  await state.get('clearListBtn').dispatch('click');
  assert.match(state.confirmations[0], /已删除合集的收藏.*2 句/);
  assert.deepEqual(state.saved(), favorites.slice(0, 4));
  assert.equal(state.tabs().selected, 'deleted');
  assert.equal(state.get('clearListBtn').disabled, true);
});

test('playback navigation, positions and loop-all remain within the current filter', async () => {
  const state = await setup({ loop: 'all' });
  state.select('book-b');
  await state.get('ttsPlayPause').dispatch('click');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
  state.speech.at(-1).onend();
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  assert.equal(state.get('ttsPos').textContent, '2/2');
  state.speech.at(-1).onend();
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
  await state.get('ttsNext').dispatch('click');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  await state.get('ttsPrev').dispatch('click');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
});

test('left and right navigate the current favorites filter without configuration', async () => {
  const state = await setup();
  state.select('book-b');
  assert.equal(await state.press('ArrowRight'), true);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  assert.equal(state.get('ttsPos').textContent, '2/2');
  await state.press('ArrowRight');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  assert.equal(await state.press('ArrowLeft'), true);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
  assert.equal(state.get('ttsPos').textContent, '1/2');
  await state.press('ArrowLeft');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
  assert.equal(await state.press('j'), false);
  assert.equal(await state.press('k'), false);
});

test('navigation keys do not interfere with typing, collection tabs, dialogs, composition or modifier shortcuts', async () => {
  const state = await setup();
  state.select('book-b');
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    for (const target of [
      { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
      { isContentEditable: true }, { closest: () => ({ role: 'tablist' }) }
    ]) assert.equal(await state.press(key, target), false);
    for (const modifiers of [
      { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
      { isComposing: true }, { defaultPrevented: true }
    ]) assert.equal(await state.press(key, {}, modifiers), false);
    for (const id of ['ttsPanel', 'searchModal']) {
      state.get(id).hidden = false;
      assert.equal(await state.press(key), false);
      state.get(id).hidden = true;
    }
  }
  assert.equal(state.get('ttsPos').textContent, '1/2');
  assert.equal(state.speech.length, 0);
});

test('keyboard navigation handles empty favorites and works without speech synthesis', async () => {
  const state = await setup({ tts: false });
  state.select('book-b');
  assert.equal(await state.press('ArrowRight'), true);
  assert.equal(state.get('ttsPos').textContent, '2/2');
  assert.equal(await state.press('ArrowLeft'), true);
  assert.equal(state.get('ttsPos').textContent, '1/2');
  state.select('book-empty');
  assert.equal(await state.press('ArrowRight'), false);
  assert.equal(await state.press('ArrowLeft'), false);
  assert.equal(state.get('ttsPos').textContent, '0/0');
});

test('switching filters cancels both active playback and delayed callbacks without autoplay', async () => {
  const state = await setup({ loop: 'all' });
  state.select('book-b');
  await state.get('ttsPlayPause').dispatch('click');
  await state.flush();
  const previous = state.speech.at(-1);
  const cancels = state.calls.cancel;
  state.select('book-a');
  previous.onend();
  await state.flush();
  assert.ok(state.calls.cancel > cancels);
  assert.equal(state.speech.length, 1);
  assert.equal(state.get('ttsPos').textContent, '1/2');
  await state.get('ttsPlayPause').dispatch('click');
  state.select('book-empty');
  await state.flush();
  assert.equal(state.speech.length, 1);
  assert.equal(state.get('ttsPos').textContent, '0/0');
});

test('failed writes retain the full list and current filter and report the failure', async () => {
  const state = await setup();
  state.select('book-b');
  state.failWrites();
  await state.remove('book-b/second::0');
  await state.get('clearListBtn').dispatch('click');
  assert.deepEqual(state.saved(), favorites);
  assert.match(state.get('favSentences').innerHTML, /B0/);
  assert.match(state.get('favSentences').innerHTML, /B1/);
  assert.equal(state.tabs().selected, 'book-b');
  assert.ok(state.notices.every(notice => notice.includes('Storage blocked')));
  assert.equal(state.notices.length, 2);
});

test('collection loading failure reports the error without hiding or relabeling favorites as deleted', async () => {
  const state = await setup({ failCollections: true });
  assert.equal(state.get('favoriteCollectionBar').hidden, true);
  assert.match(state.get('favoriteCollectionStatus').textContent, /加载合集分类失败.*Database unavailable/);
  assert.match(state.get('favSentences').innerHTML, /A0/);
  assert.match(state.get('favSentences').innerHTML, /B0/);
  assert.deepEqual(state.saved(), favorites);
});

test('empty favorites and browsers without TTS still support collection filtering', async () => {
  const empty = await setup({ items: [] });
  assert.deepEqual(Array.from(empty.tabs().filters, filter => filter.id), ['all', 'book-b', 'book-a', 'book-empty']);
  assert.equal(empty.get('clearListBtn').disabled, true);
  empty.select('book-a');
  assert.equal(empty.get('ttsPos').textContent, '0/0');
  const noTts = await setup({ tts: false });
  noTts.select('book-b');
  await noTts.get('ttsNext').dispatch('click');
  assert.equal(noTts.get('ttsPos').textContent, '2/2');
});

test('favorites page loads the shared collection store and places its filter above the sentence list', () => {
  const page = read('favorites.html');
  assert.match(page, /assets\/resource-store\.js/);
  assert.match(page, /assets\/collections\.js/);
  assert.ok(page.indexOf('id="favoriteCollectionTabs"') < page.indexOf('id="favSentences"'));
  assert.match(page, /id="clearListDescription"/);
});

test('favorites home link always reaches index after returning from a source lesson, regardless of history', async () => {
  for (const historyLength of [1, 5]) {
    const state = await setup({
      items: [favorites[0]], lessons: { 'book-a/first': originalLesson() }, historyLength
    });
    await state.jump(0);
    assert.equal(state.context.location.href, 'lesson.html#book-a/first?from=favorites');
    state.context.location.href = 'favorites.html';
    await state.row(0);
    await state.flush();
    assert.equal(await state.home(), false);
    assert.equal(state.context.location.href, 'index.html');
    assert.equal(state.calls.historyBack, 0);
    assert.equal(state.audio.paused, true);
    assert.deepEqual(state.calls.revoked, state.calls.created);
  }
  assert.match(read('favorites.html'), /<a id="backBtn"[^>]*href="index\.html"[^>]*aria-label="首页"[\s\S]*?首页\s*<\/a>/);
});

test('favorites naming is consistent and the next icon points right with a shortcut hint', () => {
  const page = read('favorites.html');
  assert.match(page, /<title>我的收藏 - EchoFlow<\/title>/);
  assert.match(page, /<h1 id="favTitle">收藏<\/h1>/);
  assert.match(page, /aria-label="收藏播放器"/);
  assert.match(page, /id="ttsPrev"[^>]*aria-keyshortcuts="ArrowLeft"/);
  assert.match(page, /id="ttsNext"[^>]*aria-keyshortcuts="ArrowRight"/);
  const next = page.match(/<button id="ttsNext"[\s\S]*?<\/button>/)[0];
  assert.match(next, /d="M16 5h2v14h-2V5zM2 5v14l13-7L2 5z"/);
  for (const path of ['favorites.html', 'index.html', 'assets/favorites.js', 'assets/lesson.js', 'assets/utils.js']) {
    assert.doesNotMatch(read(path), /清单/, path);
  }
});

function originalLesson(lrcText = '[00:01.100]A0 | 甲\n[00:03.200]Unsaved\n[00:08.300]A2') {
  return { audioBlob: { size: 1234, type: 'audio/mpeg', duration: 12 }, lrcText, importedAt: 1 };
}

test('original audio and TTS default to 1x for missing or invalid settings and retain chosen rates', async () => {
  for (const [rate, expected] of [
    [undefined, 1], [null, 1], ['', 1], ['  ', 1], ['invalid', 1], ['1.5', 1.5]
  ]) {
    for (const original of [true, false]) {
      const state = await setup({
        items: [favorites[0]], rate,
        lessons: original ? { 'book-a/first': originalLesson() } : {}
      });
      await state.row(0);
      await state.flush();
      assert.equal(state.get('ttsRateSelect').value, String(expected));
      assert.equal(original ? state.calls.plays[0].rate : state.speech[0].rate, expected);
    }
  }
});

test('original audio wins over TTS, reads edited times and stops at the next full-LRC sentence', async () => {
  const items = [favorites[0], { ...favorites[0], id: 'book-a/first::2', idx: 2, en: 'A2', start: 9 }];
  const state = await setup({ items, lessons: { 'book-a/first': originalLesson() } });
  await state.row(0);
  await state.flush();
  assert.equal(state.speech.length, 0);
  assert.equal(state.calls.plays.length, 1);
  assert.equal(state.calls.plays[0].time, 1.1);
  assert.equal(state.calls.plays[0].rate, 1);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '暂停');
  await state.audio.advance(3.199);
  assert.equal(state.audio.paused, false);
  await state.audio.advance(3.2);
  assert.equal(state.audio.paused, true);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
  assert.equal(state.get('ttsPos').textContent, '1/2');
  assert.equal(state.notices.length, 0);
});

test('last original sentence uses audio duration, including when TTS is unsupported', async () => {
  const item = { ...favorites[0], idx: 2, id: 'book-a/first::2', en: 'A2' };
  const state = await setup({ items: [item], tts: false, lessons: { 'book-a/first': originalLesson() } });
  assert.equal(state.get('ttsVoice').disabled, true);
  await state.get('ttsPlayPause').dispatch('click');
  await state.flush();
  assert.equal(state.calls.plays[0].time, 8.3);
  await state.audio.advance(11.99);
  assert.equal(state.audio.paused, false);
  await state.audio.finish();
  assert.equal(state.audio.paused, true);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
  assert.equal(state.notices.length, 0);
});

test('shared parser combines bilingual rows and supports legacy favorite index suffixes', async () => {
  const item = { id: 'book-a/first::1', lessonId: 'book-a/first', en: 'Two' };
  const record = originalLesson('[ti:Example]\r\n[00:01.10]One\r\n[00:01.10]一\r\n[00:04.123]Two | 二\r\n[00:06.0]Three');
  const state = await setup({ items: [item], lessons: { 'book-a/first': record } });
  await state.row(0);
  await state.flush();
  assert.equal(state.calls.plays[0].time, 4.123);
  await state.audio.advance(6);
  assert.equal(state.audio.paused, true);
  assert.equal(state.speech.length, 0);
});

test('missing audio or subtitles only relabels the source link and silently falls back to TTS', async () => {
  for (const record of [null, { lrcText: '[00:01]A0' }, { audioBlob: { size: 1 } }]) {
    const state = await setup({
      items: [favorites[0]],
      lessons: record ? { 'book-a/first': record } : {}
    });
    const button = state.source(0);
    assert.equal(button.disabled, true);
    assert.equal(button.querySelector('.source-link-label').textContent, '缺失');
    state.select('book-a');
    assert.match(state.get('favSentences').innerHTML, /aria-label="缺失"[^>]* disabled/);
    assert.match(state.get('favSentences').innerHTML, /source-link-label">缺失</);
    await state.jump(0);
    assert.equal(state.context.location.href, '');
    await state.row(0);
    await state.flush();
    assert.equal(state.speech.at(-1).text, 'A0');
    assert.equal(state.calls.plays.length, 0);
    assert.equal(state.notices.length, 0);
  }
});

test('available source links remain enabled and deletion is rechecked before replaying cached audio', async () => {
  const state = await setup({ items: [favorites[0]], lessons: { 'book-a/first': originalLesson() } });
  assert.equal(state.source(0).disabled, false);
  assert.equal(state.source(0).querySelector('.source-link-label').textContent, '原文');
  await state.row(0);
  await state.flush();
  state.resources.delete('book-a/first');
  await state.row(0);
  await state.flush();
  assert.equal(state.source(0).disabled, true);
  assert.equal(state.speech.at(-1).text, 'A0');
  assert.deepEqual(state.calls.revoked, state.calls.created);
  assert.equal(state.notices.length, 0);
});

test('original audio pauses and resumes in place; rate, loop and voice changes do not restart it', async () => {
  const state = await setup({ items: [favorites[0]], lessons: { 'book-a/first': originalLesson() } });
  await state.row(0);
  await state.flush();
  await state.audio.advance(2);
  await state.get('ttsPlayPause').dispatch('click');
  assert.equal(state.audio.paused, true);
  state.get('ttsRateSelect').value = '1.5';
  await state.get('ttsRateSelect').dispatch('change');
  state.get('ttsLoopSelect').value = 'one';
  await state.get('ttsLoopSelect').dispatch('change');
  state.get('ttsVoice').value = 'Other voice';
  await state.get('ttsVoice').dispatch('change');
  assert.equal(state.calls.plays.length, 1);
  assert.equal(state.audio.currentTime, 2);
  assert.equal(state.audio.playbackRate, 1.5);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
  await state.get('ttsPlayPause').dispatch('click');
  assert.equal(state.audio.paused, false);
  assert.equal(state.calls.plays.at(-1).time, 2);
  assert.equal(state.calls.plays.at(-1).rate, 1.5);
  assert.equal(state.speech.length, 0);
  assert.equal(state.calls.reads.length, 1);
  state.get('ttsRateSelect').value = '2';
  await state.get('ttsRateSelect').dispatch('change');
  assert.equal(state.audio.currentTime, 2);
  assert.equal(state.audio.playbackRate, 2);
  assert.ok([...state.timers.values()].some(timer => Math.abs(timer.delay - 600) < 0.001));
});

test('filtered looping can mix original audio and TTS, without using other categories', async () => {
  const state = await setup({
    loop: 'all',
    lessons: { 'book-a/first': originalLesson() },
    items: [
      favorites[0],
      { ...favorites[0], id: 'book-a/missing::0', lessonId: 'book-a/missing', base: 'missing', en: 'Missing' },
      favorites[1]
    ]
  });
  state.select('book-a');
  await state.row(0);
  await state.flush();
  await state.audio.advance(3.2);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'Missing');
  assert.equal(state.get('ttsPos').textContent, '2/2');
  state.speech.at(-1).onend();
  await state.flush();
  assert.equal(state.calls.plays.length, 2);
  assert.equal(state.get('ttsPos').textContent, '1/2');
  assert.equal(state.speech.length, 1);
  assert.equal(state.notices.length, 0);
});

test('single-sentence loops reread current LRC while reusing the original audio URL', async () => {
  const state = await setup({
    items: [favorites[0]], loop: 'one',
    lessons: { 'book-a/first': originalLesson() }
  });
  await state.row(0);
  await state.flush();
  state.resources.get('book-a/first').lrcText = '[00:01.500]A0\n[00:04.000]Next';
  await state.audio.advance(3.2);
  await state.flush();
  assert.equal(state.calls.plays.length, 2);
  assert.equal(state.calls.plays.at(-1).time, 1.5);
  assert.equal(state.calls.created.length, 1);
  assert.equal(state.calls.reads.length, 2);
  await state.audio.advance(3.99);
  assert.equal(state.audio.paused, false);
  await state.audio.advance(4);
  await state.flush();
  assert.equal(state.calls.plays.length, 3);
});

test('cross-course keyboard navigation revokes old URLs and pagehide stops and releases audio', async () => {
  const state = await setup({
    items: favorites.slice(0, 2),
    lessons: { 'book-a/first': originalLesson(), 'book-b/second': originalLesson('[00:02]B0') }
  });
  await state.row(0);
  await state.flush();
  await state.press('ArrowRight');
  await state.flush();
  assert.equal(state.calls.plays.at(-1).time, 2);
  assert.equal(state.calls.revoked.length, 1);
  assert.equal(state.calls.created.length, 2);
  await state.leave();
  assert.equal(state.audio.paused, true);
  assert.equal(state.audio.src, '');
  assert.deepEqual(state.calls.revoked, state.calls.created);
  await state.audio.finish();
  await state.flush();
  assert.equal(state.calls.plays.length, 2);
});

test('stale IndexedDB reads cannot start playback after navigation, filtering or pagehide', async () => {
  for (const action of ['next', 'filter', 'leave', 'remove', 'clear', 'stop']) {
    let resolveRead;
    const state = await setup({
      items: favorites.slice(0, 2),
      getLesson: (book) => book === 'book-a' ? new Promise(resolve => { resolveRead = resolve; }) : null
    });
    await state.row(0);
    if (action === 'next') await state.press('ArrowRight');
    else if (action === 'filter') state.select('book-b');
    else if (action === 'leave') await state.leave();
    else if (action === 'remove') await state.remove(favorites[0].id);
    else if (action === 'clear') await state.get('clearListBtn').dispatch('click');
    else await state.get('ttsPlayPause').dispatch('click');
    resolveRead(originalLesson());
    await state.flush();
    assert.equal(state.calls.plays.length, 0, action);
    assert.equal(state.speech.length, action === 'next' ? 1 : 0, action);
  }
});

test('cancellation during metadata loading and seeking ignores stale audio events', async () => {
  for (const stage of ['metadata', 'seek']) {
    const state = await setup({
      items: [favorites[0]], lessons: { 'book-a/first': originalLesson() },
      autoMetadata: stage !== 'metadata', autoSeek: stage !== 'seek'
    });
    await state.row(0);
    await state.flush();
    assert.equal(state.get('ttsPlayPause').getAttribute('aria-busy'), 'true');
    state.select('book-b');
    await state.audio.finishMetadata();
    await state.audio.finishSeek();
    await state.flush();
    assert.equal(state.calls.plays.length, 0);
    assert.equal(state.speech.length, 0);
    assert.equal(state.notices.length, 0);
    assert.equal(state.get('ttsPos').textContent, '0/0');
  }
});

test('autoplay denial keeps the prepared segment for a direct user-gesture retry, not TTS', async () => {
  const state = await setup({ items: [favorites[0]], lessons: { 'book-a/first': originalLesson() } });
  state.audio.playError = Object.assign(new Error('Permission required'), { name: 'NotAllowedError' });
  await state.row(0);
  await state.flush();
  assert.equal(state.speech.length, 0);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
  assert.match(state.notices[0], /点击播放重试/);
  state.audio.playError = null;
  await state.get('ttsPlayPause').dispatch('click');
  assert.equal(state.calls.plays.at(-1).time, 1.1);
  assert.equal(state.calls.reads.length, 1);
  assert.equal(state.audio.paused, false);
});

test('invalid subtitles and decode failures explicitly fall back rather than playing the wrong segment', async () => {
  for (const lrcText of ['', 'not lrc', '[00:20]A0', '[00:02]A0\n[00:01]Backwards']) {
    const state = await setup({ items: [favorites[0]], lessons: { 'book-a/first': originalLesson(lrcText) } });
    await state.row(0);
    await state.flush();
    assert.equal(state.speech.at(-1).text, 'A0');
    assert.equal(state.calls.plays.length, 0);
    if (lrcText) assert.match(state.notices[0], /原音频播放失败/);
    else assert.equal(state.notices.length, 0);
  }
  const state = await setup({ items: [favorites[0]], lessons: { 'book-a/first': originalLesson() } });
  state.audio.playError = Object.assign(new Error('Cannot decode'), { name: 'NotSupportedError' });
  await state.row(0);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'A0');
  assert.match(state.notices[0], /Cannot decode/);
  assert.deepEqual(state.calls.revoked, state.calls.created);
});

test('TTS can pause before speech starts and changing rate while paused does not autoplay', async () => {
  const state = await setup({ items: [favorites[0]] });
  await state.row(0);
  await state.get('ttsPlayPause').dispatch('click');
  await state.flush();
  assert.equal(state.speech.length, 0);
  state.get('ttsRateSelect').value = '1.5';
  await state.get('ttsRateSelect').dispatch('change');
  await state.flush();
  assert.equal(state.speech.length, 0);
  await state.get('ttsPlayPause').dispatch('click');
  assert.equal(state.speech.length, 1);
  assert.equal(state.speech[0].rate, 1.5);
  assert.equal(state.calls.spokenWhilePaused, 0);
});

test('cancelling metadata loading allows the same original resource to be retried', async () => {
  const state = await setup({
    items: [favorites[0]], lessons: { 'book-a/first': originalLesson() }, autoMetadata: false
  });
  await state.row(0);
  await state.flush();
  await state.get('ttsPlayPause').dispatch('click');
  await state.get('ttsPlayPause').dispatch('click');
  await state.flush();
  assert.equal(state.calls.plays.length, 0);
  assert.equal(state.speech.length, 0);
  await state.audio.finishMetadata();
  await state.flush();
  assert.equal(state.calls.plays.length, 1);
  assert.equal(state.calls.created.length, 1);
  assert.equal(state.notices.length, 0);
});

test('audio boundary timer checks the media clock and stops even without timeupdate', async () => {
  const state = await setup({ items: [favorites[0]], lessons: { 'book-a/first': originalLesson() } });
  await state.row(0);
  await state.flush();
  const timer = [...state.timers.values()].find(timer => Math.abs(timer.delay - 2100) < 0.001);
  assert.ok(timer);
  timer.callback();
  assert.equal(state.audio.paused, false);
  state.audio.currentTime = 3.2;
  const replacement = [...state.timers.values()].find(timer => Math.abs(timer.delay - 2100) < 0.001);
  replacement.callback();
  assert.equal(state.audio.paused, true);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
});

test('a replaced audio file reloads its URL rather than reusing the cached lesson source', async () => {
  const state = await setup({
    items: [favorites[0]], lessons: { 'book-a/first': originalLesson() }
  });
  await state.row(0);
  await state.flush();
  state.resources.set('book-a/first', { ...originalLesson('[00:02]A0'), importedAt: 2 });
  await state.row(0);
  await state.flush();
  assert.equal(state.calls.created.length, 2);
  assert.equal(state.calls.revoked.length, 1);
  assert.equal(state.calls.plays.at(-1).time, 2);
});

test('audio errors during loading and playback are surfaced and do not leave playback stuck', async () => {
  for (const loading of [true, false]) {
    const state = await setup({
      items: [favorites[0]], lessons: { 'book-a/first': originalLesson() },
      autoMetadata: !loading
    });
    await state.row(0);
    await state.flush();
    await state.audio.dispatch('error');
    await state.flush();
    assert.equal(state.speech.at(-1).text, 'A0');
    assert.match(state.notices[0], /原音频播放失败/);
    assert.equal(state.audio.paused, true);
    assert.deepEqual(state.calls.revoked, state.calls.created);
  }
});

test('metadata timeouts and database failures are reported rather than silently treated as missing files', async () => {
  const state = await setup({
    items: [favorites[0]], lessons: { 'book-a/first': originalLesson() }, autoMetadata: false
  });
  await state.row(0);
  await state.flush();
  [...state.timers.values()].find(timer => timer.delay === 10000).callback();
  await state.flush();
  assert.match(state.notices[0], /超时/);
  assert.equal(state.speech.at(-1).text, 'A0');
  assert.equal(state.source(0).disabled, false);
  const blocked = await setup({
    items: [favorites[0]], lessons: { 'book-a/first': originalLesson() },
    getLesson: () => Promise.reject(new Error('Database blocked'))
  });
  await blocked.row(0);
  await blocked.flush();
  assert.match(blocked.notices[0], /Database blocked/);
  assert.equal(blocked.speech.at(-1).text, 'A0');
  assert.equal(blocked.source(0).disabled, false);
});

test('pagehide during a pending play promise cannot restore playback state afterwards', async () => {
  const state = await setup({ items: [favorites[0]], lessons: { 'book-a/first': originalLesson() } });
  let resolvePlay;
  state.audio.play = () => {
    state.audio.paused = false;
    return new Promise(resolve => { resolvePlay = resolve; });
  };
  await state.row(0);
  await state.flush();
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-busy'), 'true');
  await state.leave();
  resolvePlay();
  await state.flush();
  assert.equal(state.audio.paused, true);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-busy'), 'false');
  assert.equal(state.notices.length, 0);
});

test('space pauses and resumes both original audio and TTS, while R restarts the current sentence', async () => {
  for (const original of [true, false]) {
    const state = await setup({
      items: [favorites[0]], lessons: original ? { 'book-a/first': originalLesson() } : {}
    });
    assert.equal(await state.press(' '), true);
    await state.flush();
    assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '暂停');
    if (original) await state.audio.advance(2);
    assert.equal(await state.press(' '), true);
    assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
    if (original) assert.equal(state.audio.paused, true);
    else assert.equal(state.calls.pause, 1);
    await state.press(' ');
    await state.flush();
    assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '暂停');
    if (original) assert.equal(state.calls.plays.at(-1).time, 2);
    else assert.equal(state.speech.length, 1);
    const count = original ? state.calls.plays.length : state.speech.length;
    await state.press('r');
    await state.flush();
    assert.equal(original ? state.calls.plays.length : state.speech.length, count + 1);
    if (original) assert.equal(state.calls.plays.at(-1).time, 1.1);
    else assert.equal(state.speech.at(-1).text, 'A0');
    await state.press(' ', {}, { repeat: true });
    await state.press('r', {}, { repeat: true });
    await state.flush();
    assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '暂停');
    assert.equal(original ? state.calls.plays.length : state.speech.length, count + 1);
  }
});

test('favorites reuse all six lesson key overrides, including filtered left/right navigation', async () => {
  const state = await setup({
    shortcuts: { playPause: 'p', replay: 't', prevSentence: 'j', nextSentence: 'k', volumeUp: 'u', volumeDown: 'd' },
    volume: '0.5'
  });
  state.select('book-b');
  for (const key of [' ', 'r', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(await state.press(key), false);
  }
  assert.equal(await state.press('p'), true);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
  await state.press('k');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  assert.equal(state.get('ttsPos').textContent, '2/2');
  await state.press('t');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  await state.press('j');
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
  await state.press('u');
  await state.flush();
  assert.equal(state.speech.at(-1).volume, 0.6);
  await state.press('d');
  await state.flush();
  assert.equal(state.speech.at(-1).volume, 0.5);
  assert.equal(state.values.get('nce_volume'), '0.5');
  assert.equal(state.get('ttsPrev').getAttribute('aria-keyshortcuts'), 'j');
  assert.equal(state.get('ttsNext').getAttribute('title'), '下一句（K）');
  assert.equal(state.get('ttsPlayPause').getAttribute('title'), '播放/暂停（P）');
});

test('custom key combinations match lesson modifier rules without intercepting unrelated commands', async () => {
  const state = await setup({
    shortcuts: { playPause: 'Ctrl+p', replay: 'Alt+r', nextSentence: 'Ctrl+Shift+ArrowRight', volumeUp: 'Shift+ArrowUp' },
    volume: '0.5'
  });
  state.select('book-b');
  assert.equal(await state.press('p'), false);
  assert.equal(await state.press('r'), false);
  assert.equal(await state.press('p', {}, { ctrlKey: true }), true);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B0');
  assert.equal(await state.press('ArrowRight', {}, { ctrlKey: true }), false);
  assert.equal(await state.press('ArrowRight', {}, { ctrlKey: true, shiftKey: true }), true);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  assert.equal(await state.press('r', {}, { altKey: true }), true);
  await state.flush();
  assert.equal(state.speech.at(-1).text, 'B1');
  assert.equal(await state.press('ArrowUp', {}, { shiftKey: true }), true);
  assert.equal(state.audio.volume, 0.6);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-keyshortcuts'), 'Control+p');
  assert.equal(state.get('ttsNext').getAttribute('aria-keyshortcuts'), 'Control+Shift+ArrowRight');
});

test('up/down share saved volume with lesson, clamp at 0–100% and reuse the lesson percentage toast', async () => {
  const state = await setup({
    items: [favorites[0]], volume: '0.5', lessons: { 'book-a/first': originalLesson() }
  });
  assert.equal(state.audio.volume, 0.5);
  await state.row(0);
  await state.flush();
  await state.audio.advance(2);
  assert.equal(await state.press('ArrowUp'), true);
  assert.equal(state.audio.volume, 0.6);
  assert.equal(state.values.get('nce_volume'), '0.6');
  const toast = state.get('volumeToast');
  assert.equal(toast.textContent, '音量 60%');
  assert.equal(await state.press('ArrowDown'), true);
  assert.equal(state.get('volumeToast'), toast);
  assert.equal(toast.textContent, '音量 50%');
  assert.equal(state.calls.plays.length, 1);
  assert.equal(state.audio.currentTime, 2);
  for (let i = 0; i < 15; i++) await state.press('ArrowDown');
  assert.equal(state.audio.volume, 0);
  assert.equal(state.values.get('nce_volume'), '0');
  for (let i = 0; i < 15; i++) await state.press('ArrowUp');
  assert.equal(state.audio.volume, 1);
  assert.equal(state.values.get('nce_volume'), '1');
  assert.equal([...state.timers.values()].filter(timer => timer.delay === 1000).length, 1);
});

test('TTS restores shared volume and volume changes preserve pause state', async () => {
  const state = await setup({ items: [favorites[0]], volume: '0.4' });
  await state.press(' ');
  await state.flush();
  assert.equal(state.speech.at(-1).volume, 0.4);
  await state.press('ArrowUp');
  await state.flush();
  assert.equal(state.speech.at(-1).volume, 0.5);
  assert.equal(state.speech.length, 2);
  await state.press(' ');
  await state.press('ArrowDown');
  await state.flush();
  assert.equal(state.speech.length, 2);
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-label'), '播放');
  await state.press(' ');
  assert.equal(state.speech.at(-1).volume, 0.4);
  assert.equal(state.speech.length, 3);
  assert.equal(state.calls.spokenWhilePaused, 0);
  for (let i = 0; i < 5; i++) await state.press('ArrowDown');
  await state.flush();
  assert.equal(state.speech.at(-1).volume, 0);
  const count = state.speech.length;
  await state.press('ArrowDown');
  await state.flush();
  assert.equal(state.speech.length, count);
});

test('missing and invalid volume settings follow the same defaults as lesson, including saved mute-level zero', async () => {
  for (const [volume, expected] of [
    [undefined, 1], ['', 1], ['abc', 1], ['-1', 1], ['1.1', 1], ['0', 0], ['0.7', 0.7]
  ]) {
    const state = await setup({ items: [favorites[0]], volume });
    assert.equal(state.audio.volume, expected);
    await state.press(' ');
    await state.flush();
    assert.equal(state.speech[0].volume, expected);
  }
});

test('lesson configuration changes refresh favorite key hints and shared volume without reloading', async () => {
  const state = await setup({ items: [favorites[0]], volume: '0.5', lessons: { 'book-a/first': originalLesson() } });
  state.values.set('nce_shortcuts', JSON.stringify({ playPause: 'p', prevSentence: 'j', nextSentence: 'k' }));
  await state.storage('nce_shortcuts');
  assert.equal(await state.press(' '), false);
  assert.equal(state.get('ttsPlayPause').getAttribute('title'), '播放/暂停（P）');
  assert.equal(state.get('ttsNext').getAttribute('aria-keyshortcuts'), 'k');
  await state.press('p');
  await state.flush();
  state.values.set('nce_volume', '0.2');
  await state.storage('nce_volume');
  assert.equal(state.audio.volume, 0.2);
  assert.equal(state.calls.plays.length, 1);
  state.values.delete('nce_shortcuts');
  await state.focus();
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-keyshortcuts'), 'Space');
  assert.equal(await state.press('p'), false);
  assert.equal(await state.press(' '), true);
  assert.equal(state.audio.paused, true);
});

test('conflicting or malformed saved shortcut configurations use the same fallback as lesson', async () => {
  for (const shortcuts of [{ nextSentence: 'ArrowDown' }, '{invalid json']) {
    const state = await setup({ shortcuts });
    state.select('book-b');
    assert.equal(await state.press('ArrowRight'), true);
    await state.flush();
    assert.equal(state.speech.at(-1).text, 'B1');
    assert.ok(state.warnings.length > 0);
    assert.equal(state.get('ttsNext').getAttribute('aria-keyshortcuts'), 'ArrowRight');
  }
});

test('every favorite shortcut ignores editable fields, tabs, open dialogs and already handled keys', async () => {
  const state = await setup();
  for (const key of [' ', 'r', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    for (const target of [
      { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
      { isContentEditable: true }, { closest: () => ({ role: 'tablist' }) }
    ]) assert.equal(await state.press(key, target), false);
    for (const modifiers of [
      { defaultPrevented: true }, { isComposing: true }, { ctrlKey: true },
      { shiftKey: true }, { altKey: true }, { metaKey: true }
    ]) assert.equal(await state.press(key, {}, modifiers), false);
    for (const id of ['ttsPanel', 'searchModal']) {
      state.get(id).hidden = false;
      assert.equal(await state.press(key), false);
      state.get(id).hidden = true;
    }
  }
  assert.equal(state.calls.reads.length, 0);
  assert.equal(state.audio.volume, 1);
});

test('space keeps native button activation except on the playback button', async () => {
  const state = await setup({ items: [favorites[0]] });
  const target = button => ({
    tagName: 'BUTTON',
    closest: selector => selector === 'button, a[href], summary' ? button : null
  });
  assert.equal(await state.press(' ', target({})), false);
  assert.equal(state.calls.reads.length, 0);
  assert.equal(await state.press(' ', target(state.get('ttsPlayPause'))), true);
  await state.flush();
  assert.equal(state.speech.length, 1);
});

test('space cancels pending original loading and replay cannot escape an empty collection', async () => {
  let resolveRead;
  const state = await setup({ getLesson: () => new Promise(resolve => { resolveRead = resolve; }) });
  await state.press(' ');
  assert.equal(state.get('ttsPlayPause').getAttribute('aria-busy'), 'true');
  await state.press(' ');
  resolveRead(originalLesson());
  await state.flush();
  assert.equal(state.calls.plays.length, 0);
  assert.equal(state.speech.length, 0);
  state.select('book-empty');
  assert.equal(await state.press(' '), false);
  assert.equal(await state.press('r'), false);
  assert.equal(await state.press('ArrowDown'), true);
  assert.equal(state.audio.volume, 0.9);
});
