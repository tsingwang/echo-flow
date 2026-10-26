const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const read = name => readFileSync(resolve(__dirname, '..', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function element() {
  const listeners = {};
  return {
    style: {}, classList: { add() {}, remove() {} },
    textContent: '', innerHTML: '', files: [], hidden: false, disabled: false,
    buttons: [], open: false, returnValue: '', showCount: 0,
    querySelectorAll() { return this.buttons; },
    focus() { this.focused = true; },
    showModal() { this.open = true; this.showCount++; },
    close(value) {
      if (value !== undefined) this.returnValue = value;
      this.open = false;
      return this.dispatch('close');
    },
    addEventListener(type, handler, options) { (listeners[type] ??= []).push({ handler, once: options?.once }); },
    async dispatch(type, event = {}) {
      for (const listener of [...(listeners[type] || [])]) {
        if (listener.once) listeners[type] = listeners[type].filter(item => item !== listener);
        await listener.handler(event);
      }
    }
  };
}

function setup() {
  const elements = new Map();
  const document = Object.assign(element(), {
    readyState: 'loading',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    }
  });
  const context = vm.createContext({
    document, localStorage: storage(), sessionStorage: storage(),
    console: { error() {}, warn() {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async () => ({ headers: new Headers(), status: 404 }),
    location: { hash: '', pathname: '/index.html' },
    history: { replaceState() {} },
    addEventListener() {}
  });
  context.window = context;
  vm.runInContext(read('assets/storage.js'), context);
  return { context, document, get: id => document.getElementById(id) };
}

function seed(context) {
  const preserved = {
    nce_sentence_favs_v1: '[{"id":"lib/one::0","en":"Hello","cn":"你好"}]',
    nce_favs: '["lib/one"]',
    nce_theme: 'dark', audioPlaybackRate: '1.25',
    nce_tts_voice: 'test-voice', nce_sync_token: 'test-token',
    unrelated: 'keep'
  };
  for (const key of [...context.NCE_STORAGE.KEYS.SETTINGS, ...context.NCE_STORAGE.KEYS.TTS]) {
    preserved[key] ??= 'keep-setting';
  }
  Object.entries(preserved).forEach(([key, value]) => context.localStorage.setItem(key, value));
  context.localStorage.setItem('nce_recents', '[{"id":"lib/one"}]');
  context.localStorage.setItem('nce_lastpos', '{"lib/one":{"t":5}}');
  context.localStorage.setItem('nce_revealed_sentences', '{"lib/one":[0]}');
  for (const key of ['nce_resume', 'nce_resume_play', 'nce_auto_next_played_lessons']) {
    context.sessionStorage.setItem(key, 'old');
  }
  return preserved;
}

test('clearing history preserves both favorites, all settings and unrelated data', async () => {
  const { context } = setup();
  const preserved = seed(context);
  await context.NCE_STORAGE.clearLearningHistory();
  for (const [key, value] of Object.entries(preserved)) {
    assert.equal(context.localStorage.getItem(key), value, key);
  }
  assert.equal(context.localStorage.getItem('nce_recents'), '[]');
  assert.equal(context.localStorage.getItem('nce_lastpos'), '{}');
  assert.equal(context.localStorage.getItem('nce_revealed_sentences'), '{}');
  for (const key of ['nce_resume', 'nce_resume_play', 'nce_auto_next_played_lessons']) {
    assert.equal(context.sessionStorage.getItem(key), null);
  }
});

test('backend sync receives explicit empty history with favorites and settings intact', async () => {
  const { context } = setup();
  seed(context);
  let uploaded;
  context.fetch = async (url, options) => {
    if (options.method === 'POST') uploaded = JSON.parse(options.body);
    return { headers: new Headers({ 'x-nce-storage': '1' }), ok: true, status: 200, json: async () => ({}) };
  };
  await context.NCE_STORAGE.SYNC.pull();
  await context.NCE_STORAGE.clearLearningHistory();
  assert.deepEqual(uploaded.userData.nce_recents, []);
  assert.deepEqual(uploaded.userData.nce_lastpos, {});
  assert.deepEqual(uploaded.userData.nce_revealed_sentences, {});
  assert.equal(uploaded.userData.nce_sentence_favs_v1[0].en, 'Hello');
  assert.deepEqual(uploaded.userData.nce_favs, ['lib/one']);
  assert.equal(uploaded.settings.nce_theme, 'dark');
});

test('sync and local storage failures are surfaced to the caller', async () => {
  const { context } = setup();
  context.fetch = async () => ({
    headers: new Headers({ 'x-nce-storage': '1' }), ok: false, status: 500
  });
  await context.NCE_STORAGE.SYNC.pull();
  await assert.rejects(context.NCE_STORAGE.clearLearningHistory(), /HTTP 500/);
  context.localStorage.setItem = () => { throw new Error('Storage blocked'); };
  await assert.rejects(context.NCE_STORAGE.clearLearningHistory(), /Storage blocked/);
});

test('resource clearing waits for transaction commit and rejects aborted transactions', async () => {
  for (const abort of [false, true]) {
    const { context } = setup();
    let transaction;
    context.indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = {
            transaction() {
              transaction = {
                objectStore: () => ({ transaction, clear() {} })
              };
              return transaction;
            }
          };
          request.onsuccess();
        });
        return request;
      }
    };
    vm.runInContext(read('assets/resource-store.js'), context);
    let settled = false;
    const clearing = context.NCE_RESOURCES.clearAll();
    clearing.then(() => { settled = true; }, () => { settled = true; });
    await tick();
    assert.equal(settled, false);
    if (abort) {
      transaction.onabort();
      await assert.rejects(clearing, /事务已中止/);
    } else {
      transaction.oncomplete();
      await clearing;
      assert.equal(settled, true);
    }
  }
});

async function home({
  initialLessons = [{ id: 'lib/one', book: 'lib', filename: 'one', title: 'One' }],
  collections = [{ id: 'lib', name: '第一本书' }],
  current = '', hash = ''
} = {}) {
  const state = setup();
  let lessons = initialLessons;
  state.context.location.hash = hash;
  if (current) state.context.localStorage.setItem('nce_current_collection', current);
  state.context.NCE_RESOURCES = {
    listCollections: async () => collections,
    reorderCollections: async ids => {
      collections = ids.map(id => collections.find(collection => collection.id === id));
    },
    createCollection: async name => {
      const collection = { id: 'book-new', name: name.trim() };
      collections.push(collection);
      return collection;
    },
    listLessons: async book => lessons.filter(lesson => !book || lesson.book === book),
    deleteCollection: async book => {
      lessons = lessons.filter(lesson => lesson.book !== book);
      collections = collections.filter(collection => collection.id !== book);
    },
    clearAll: async () => { lessons = []; }
  };
  state.context.NCE_IMPORT = {};
  state.context.NCE_COLLECTIONS = {
    renderTabs(tabs, collections, current, busy) {
      tabs.current = current;
      tabs.buttons = collections.map(collection => ({
        ...collection, disabled: busy, dataset: { collection: collection.id },
        focus() { this.focused = true; }
      }));
    },
    bindTabs(tabs, onSelect, onReorder) {
      state.selectCollection = onSelect;
      state.reorderCollections = onReorder;
    },
    bindCreateDialog(button, onCreate) { state.createCollection = onCreate; }
  };
  state.get('bookTitle').textContent = 'EchoFlow';
  const scripts = [...read('index.html').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  const libraryScript = scripts.find(match => match[1].includes("const clearBtn ="));
  vm.runInContext(libraryScript[1], state.context);
  await state.document.dispatch('DOMContentLoaded');
  await tick();
  return state;
}

test('home saves tab order without switching the current collection or reloading lessons', async () => {
  const state = await home({
    collections: [{ id: 'lib', name: 'First' }, { id: 'other', name: 'Other' }]
  });
  state.context.NCE_RESOURCES.listLessons = async () => { throw new Error('Must not reload'); };
  await state.reorderCollections(['other', 'lib'], 'other');
  assert.deepEqual(Array.from(state.get('collectionTabs').buttons, button => button.id), ['other', 'lib']);
  assert.equal(state.get('collectionTabs').current, 'lib');
  assert.equal(state.context.localStorage.getItem('nce_current_collection'), 'lib');
  assert.equal(state.get('collectionTabs').buttons[0].focused, true);
  assert.equal(state.get('collectionTabs').buttons.every(button => !button.disabled), true);
  assert.match(state.get('libraryStatus').textContent, /顺序已保存/);
});

test('home reports order-save failures and keeps the previous tab order', async () => {
  const state = await home({
    collections: [{ id: 'lib', name: 'First' }, { id: 'other', name: 'Other' }]
  });
  state.context.NCE_RESOURCES.reorderCollections = async () => { throw new Error('Disk full'); };
  await state.reorderCollections(['other', 'lib'], 'other');
  assert.deepEqual(Array.from(state.get('collectionTabs').buttons, button => button.id), ['lib', 'other']);
  assert.equal(state.get('collectionTabs').current, 'lib');
  assert.equal(state.get('createCollectionOpen').disabled, false);
  assert.match(state.get('libraryStatus').textContent, /保存合集顺序失败：Disk full/);
});

async function cleanup(get, accepted = true) {
  const pending = get('clearLibraryBtn').dispatch('click');
  assert.equal(get('clearCollectionDialog').open, true);
  await get('clearCollectionDialog').close(accepted ? 'clear' : 'cancel');
  await pending;
}

test('canceling confirmation leaves resources and learning history untouched', async () => {
  const { context, get } = await home();
  seed(context);
  await cleanup(get, false);
  assert.equal((await context.NCE_RESOURCES.listLessons()).length, 1);
  assert.equal(context.localStorage.getItem('nce_lastpos'), '{"lib/one":{"t":5}}');
  assert.equal(get('clearLibraryBtn').disabled, false);
  assert.equal(get('clearLibraryBtn').focused, true);
});

test('closing cleanup with Escape cancels even after an earlier confirmed cleanup', async () => {
  const { context, get } = await home({ collections, initialLessons: twoLessons });
  await cleanup(get);
  const pending = get('clearLibraryBtn').dispatch('click');
  assert.equal(get('clearCollectionDialog').returnValue, 'cancel');
  await get('clearCollectionDialog').close();
  await pending;
  assert.equal((await context.NCE_RESOURCES.listCollections()).length, 1);
  assert.equal((await context.NCE_RESOURCES.listLessons()).length, 1);
  assert.equal(get('collectionTabs').current, 'book-two');
  assert.equal(get('clearLibraryBtn').disabled, false);
});

test('cleanup confirmation safely displays the name and locks its target until answered', async () => {
  const state = await home({
    collections: [{ id: 'lib', name: 'Book <A> & 教材' }, collections[1]],
    initialLessons: twoLessons
  });
  const { context, get } = state;
  seed(context);
  const pending = get('clearLibraryBtn').dispatch('click');
  assert.equal(get('clearCollectionDialog').open, true);
  assert.equal(get('clearCollectionName').textContent, 'Book <A> & 教材');
  assert.equal(get('clearCollectionName').innerHTML, '');
  assert.equal(get('clearCollectionCancel').focused, true);
  assert.equal((await context.NCE_RESOURCES.listLessons()).length, 2);
  assert.equal(context.localStorage.getItem('nce_lastpos'), '{"lib/one":{"t":5}}');
  assert.equal(get('clearLibraryBtn').disabled, true);
  assert.equal(get('importOpenBtn').disabled, true);
  assert.equal(get('createCollectionOpen').disabled, true);
  assert.ok(get('collectionTabs').buttons.every(tab => tab.disabled));
  await state.selectCollection('book-two');
  await get('clearLibraryBtn').dispatch('click');
  let imports = 0;
  context.NCE_IMPORT.importFileList = async () => { imports++; };
  get('importFilesInput').files = [{ name: 'one.mp3' }];
  await get('importFilesInput').dispatch('change');
  assert.equal(imports, 0);
  assert.equal(get('collectionTabs').current, 'lib');
  assert.equal(get('clearCollectionDialog').showCount, 1);
  await get('clearCollectionDialog').close('clear');
  await pending;
  assert.equal(get('collectionTabs').current, 'book-two');
  assert.deepEqual((await context.NCE_RESOURCES.listLessons()).map(lesson => lesson.book), ['book-two']);
  assert.match(get('libraryStatus').textContent, /已删除合集「Book <A> & 教材」/);
});

test('failure to open cleanup confirmation is reported and unlocks controls without deleting', async () => {
  const { context, get } = await home();
  seed(context);
  get('clearCollectionDialog').showModal = () => { throw new Error('Dialog unavailable'); };
  await get('clearLibraryBtn').dispatch('click');
  assert.match(get('libraryStatus').textContent, /清理合集「第一本书」失败：Dialog unavailable/);
  assert.equal((await context.NCE_RESOURCES.listLessons()).length, 1);
  assert.equal(context.localStorage.getItem('nce_lastpos'), '{"lib/one":{"t":5}}');
  assert.equal(get('clearLibraryBtn').disabled, false);
});

test('confirmed cleanup deletes the last collection and requires creating another before importing', async () => {
  const { context, get } = await home();
  const preserved = seed(context);
  await cleanup(get);
  assert.equal((await context.NCE_RESOURCES.listLessons()).length, 0);
  assert.equal(get('lessonsGrid').innerHTML, '');
  assert.equal(get('libraryEmpty').hidden, false);
  assert.equal(get('libraryToolbar').hidden, true);
  assert.match(get('libraryStatus').textContent, /收藏与设置已保留/);
  assert.equal(get('clearLibraryBtn').disabled, true);
  assert.equal(get('importOpenBtn').disabled, true);
  assert.equal(get('createCollectionOpen').disabled, false);
  assert.equal((await context.NCE_RESOURCES.listCollections()).length, 0);
  assert.equal(context.localStorage.getItem('nce_current_collection'), null);
  assert.equal(context.localStorage.getItem('nce_sentence_favs_v1'), preserved.nce_sentence_favs_v1);
  assert.match(get('libraryStatus').textContent, /已删除/);
});

test('resource failure is visible and does not clear learning history', async () => {
  const { context, get } = await home();
  seed(context);
  context.NCE_RESOURCES.deleteCollection = async () => { throw new Error('Disk error'); };
  await cleanup(get);
  assert.match(get('libraryStatus').textContent, /清理合集「第一本书」失败：Disk error/);
  assert.equal(context.localStorage.getItem('nce_lastpos'), '{"lib/one":{"t":5}}');
  assert.equal(get('clearLibraryBtn').disabled, false);
});

test('imports and cleanup cannot run concurrently', async () => {
  const { context, get } = await home();
  let finish;
  context.NCE_IMPORT.importFileList = () => new Promise(resolve => { finish = resolve; });
  get('importFilesInput').files = [{ name: 'one.mp3' }];
  await get('importFilesInput').dispatch('change');
  assert.equal(get('clearLibraryBtn').disabled, true);
  await get('clearLibraryBtn').dispatch('click');
  assert.equal((await context.NCE_RESOURCES.listLessons()).length, 1);
  finish({ imported: 1 });
  await tick();
  assert.equal(get('clearLibraryBtn').disabled, false);
});

test('all inline JavaScript remains syntactically valid', () => {
  for (const match of read('index.html').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!match[1].includes('application/ld+json')) new vm.Script(match[2]);
  }
});

const collections = [
  { id: 'lib', name: '第一本书' },
  { id: 'book-two', name: '第二本书' }
];
const twoLessons = [
  { id: 'lib/one', book: 'lib', filename: 'one', title: 'First book' },
  { id: 'book-two/one', book: 'book-two', filename: 'one', title: 'Second book' }
];

test('collection history clearing preserves other books, favorites, settings and pending resume', async () => {
  const { context } = setup();
  seed(context);
  const recents = [{ id: 'lib/one', ts: 1 }, { id: 'book-two/one', ts: 2 }, { id: 'lib2/one', ts: 3 }];
  const progress = { 'lib/one': { t: 5 }, 'book-two/one': { t: 8 }, 'lib2/one': { t: 2 } };
  context.localStorage.setItem('nce_recents', JSON.stringify(recents));
  context.localStorage.setItem('nce_lastpos', JSON.stringify(progress));
  context.localStorage.setItem('nce_revealed_sentences', JSON.stringify({ 'lib/one': [1], 'book-two/one': [2] }));
  context.sessionStorage.setItem('nce_resume', 'book-two/one');
  await context.NCE_STORAGE.clearLearningHistory('lib');
  assert.deepEqual(JSON.parse(context.localStorage.getItem('nce_recents')), recents.slice(1));
  assert.deepEqual(JSON.parse(context.localStorage.getItem('nce_lastpos')), {
    'book-two/one': { t: 8 }, 'lib2/one': { t: 2 }
  });
  assert.deepEqual(JSON.parse(context.localStorage.getItem('nce_revealed_sentences')), { 'book-two/one': [2] });
  assert.equal(context.sessionStorage.getItem('nce_resume'), 'book-two/one');
  assert.equal(context.localStorage.getItem('nce_favs'), '["lib/one"]');
  context.sessionStorage.setItem('nce_resume', 'lib/one');
  await context.NCE_STORAGE.clearLearningHistory('lib');
  assert.equal(context.sessionStorage.getItem('nce_resume'), null);
  assert.equal(context.sessionStorage.getItem('nce_resume_play'), null);
});

test('home restores the active tab while keeping the EchoFlow heading', async () => {
  const { get } = await home({ collections, initialLessons: twoLessons, current: 'book-two' });
  assert.equal(get('collectionTabs').current, 'book-two');
  assert.equal(get('bookTitle').textContent, 'EchoFlow');
  assert.match(get('lessonsGrid').innerHTML, /Second book/);
  assert.doesNotMatch(get('lessonsGrid').innerHTML, /First book/);
  assert.equal(get('importCollection').textContent, '第二本书');
});

test('book link overrides remembered selection and an unknown book selects the first existing collection', async () => {
  for (const hash of ['#lib', '#missing']) {
    const { get } = await home({ collections, current: 'book-two', hash });
    assert.equal(get('collectionTabs').current, 'lib');
  }
});

test('switching and creating collections updates the displayed lessons and remembers the choice', async () => {
  const state = await home({ collections: collections.slice(), initialLessons: twoLessons });
  const { context, get } = state;
  await state.selectCollection('book-two');
  assert.equal(context.localStorage.getItem('nce_current_collection'), 'book-two');
  assert.match(get('lessonsGrid').innerHTML, /Second book/);
  await state.createCollection('  新书  ');
  assert.equal(get('bookTitle').textContent, 'EchoFlow');
  assert.equal(get('collectionTabs').current, 'book-new');
  assert.equal(get('importCollection').textContent, '新书');
  assert.equal(get('libraryEmpty').hidden, false);
  assert.equal(context.localStorage.getItem('nce_current_collection'), 'book-new');
});

test('cleanup removes the current collection and its history, then switches to the remaining tab', async () => {
  const { context, get } = await home({ collections, initialLessons: twoLessons });
  context.localStorage.setItem('nce_recents', '[{"id":"lib/one"},{"id":"book-two/one"}]');
  context.localStorage.setItem('nce_lastpos', '{"lib/one":{"t":5},"book-two/one":{"t":8}}');
  await cleanup(get);
  assert.equal(get('clearCollectionName').textContent, '第一本书');
  assert.equal((await context.NCE_RESOURCES.listLessons()).length, 1);
  assert.equal((await context.NCE_RESOURCES.listCollections()).length, 1);
  assert.equal(get('collectionTabs').current, 'book-two');
  assert.equal(get('libraryEmpty').hidden, true);
  assert.deepEqual(JSON.parse(context.localStorage.getItem('nce_recents')), [{ id: 'book-two/one' }]);
  assert.deepEqual(JSON.parse(context.localStorage.getItem('nce_lastpos')), { 'book-two/one': { t: 8 } });
});

test('history failure after deletion reports partial completion without asking to delete the next collection', async () => {
  const { context, get } = await home({ collections, initialLessons: twoLessons });
  context.NCE_STORAGE.clearLearningHistory = async () => { throw new Error('Sync unavailable'); };
  await cleanup(get);
  assert.equal(get('collectionTabs').current, 'book-two');
  assert.equal((await context.NCE_RESOURCES.listCollections()).length, 1);
  assert.match(get('libraryStatus').textContent, /已删除合集「第一本书」，但学习记录清理或同步未完成：Sync unavailable/);
  assert.doesNotMatch(get('libraryStatus').textContent, /重试/);
});

test('import captures its target and locks collection changes until it finishes', async () => {
  const { context, get } = await home({ collections, current: 'book-two' });
  let finish;
  let target;
  context.NCE_IMPORT.importFileList = (files, onProgress, book) => {
    target = book;
    return new Promise(resolve => { finish = resolve; });
  };
  get('importCollection').value = 'lib';
  get('importFilesInput').files = [{ name: 'one.mp3' }];
  await get('importFilesInput').dispatch('change');
  assert.equal(target, 'book-two');
  assert.equal(get('collectionTabs').buttons.every(tab => tab.disabled), true);
  assert.equal(get('createCollectionOpen').disabled, true);
  assert.equal(get('importCollection').textContent, '第二本书');
  finish({ imported: 1 });
  await tick();
  assert.equal(get('collectionTabs').current, 'book-two');
  assert.equal(get('collectionTabs').buttons.some(tab => tab.disabled), false);
});

test('failed home switch leaves the displayed collection and cleanup target unchanged', async () => {
  const state = await home({ collections, initialLessons: twoLessons });
  const { context, get } = state;
  context.NCE_RESOURCES.listLessons = async () => { throw new Error('Disk error'); };
  await state.selectCollection('book-two');
  assert.equal(get('collectionTabs').current, 'lib');
  assert.equal(get('bookTitle').textContent, 'EchoFlow');
  assert.match(get('lessonsGrid').innerHTML, /First book/);
  assert.equal(context.localStorage.getItem('nce_current_collection'), 'lib');
  assert.match(get('libraryStatus').textContent, /切换合集失败：Disk error/);
});

test('without a collection there are no upload controls and file events cannot import', async () => {
  const { context, get } = await home({ collections: [], initialLessons: [] });
  let imported = false;
  context.NCE_IMPORT.importFileList = async () => { imported = true; };
  assert.equal(get('collectionTabs').buttons.length, 0);
  assert.equal(get('libraryToolbar').hidden, true);
  assert.equal(get('emptyImportBtn').hidden, true);
  assert.equal(get('emptyDropHint').hidden, true);
  assert.equal(get('importOpenBtn').disabled, true);
  assert.equal(get('createCollectionOpen').disabled, false);
  assert.equal(get('emptyTitle').textContent, '先创建一个合集');
  get('importFilesInput').files = [{ name: 'one.mp3' }];
  await get('importFilesInput').dispatch('change');
  assert.equal(imported, false);
  assert.match(get('libraryStatus').textContent, /先点击 \+ 创建合集/);
});

test('scoped history sync retains progress in other collections', async () => {
  const { context } = setup();
  context.localStorage.setItem('nce_recents', '[{"id":"lib/one"},{"id":"book-two/one"}]');
  context.localStorage.setItem('nce_lastpos', '{"lib/one":{"t":1},"book-two/one":{"t":2}}');
  let uploaded;
  context.fetch = async (url, options) => {
    if (options.method === 'POST') uploaded = JSON.parse(options.body);
    return { headers: new Headers({ 'x-nce-storage': '1' }), ok: true, status: 200, json: async () => ({}) };
  };
  await context.NCE_STORAGE.SYNC.pull();
  await context.NCE_STORAGE.clearLearningHistory('lib');
  assert.deepEqual(uploaded.userData.nce_recents, [{ id: 'book-two/one' }]);
  assert.deepEqual(uploaded.userData.nce_lastpos, { 'book-two/one': { t: 2 } });
  assert.deepEqual(uploaded.userData.nce_revealed_sentences, {});
});
