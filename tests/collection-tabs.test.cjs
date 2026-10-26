const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

function setup() {
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(readFileSync(resolve(__dirname, '../assets/utils.js'), 'utf8'), context);
  vm.runInContext(readFileSync(resolve(__dirname, '../assets/collections.js'), 'utf8'), context);
  return context.NCE_COLLECTIONS;
}

test('tabs escape collection names and identify the selected collection accessibly', () => {
  const api = setup();
  const tabs = { querySelector() { return null; } };
  api.renderTabs(tabs, [
    { id: 'book-one', name: '<First & "Book">' },
    { id: 'book-two', name: 'Second' }
  ], 'book-two', false);
  assert.match(tabs.innerHTML, /&lt;First &amp; &quot;Book&quot;&gt;/);
  assert.doesNotMatch(tabs.innerHTML, /<First/);
  assert.match(tabs.innerHTML, /data-collection="book-one"\s+aria-selected="false" tabindex="-1"/);
  assert.match(tabs.innerHTML, /data-collection="book-two"\s+aria-selected="true" tabindex="0"/);
  assert.match(tabs.innerHTML, /draggable="true"/);
  api.renderTabs(tabs, [{ id: 'book-one', name: 'First' }], 'book-one', true);
  assert.match(tabs.innerHTML, / disabled/);
  assert.match(tabs.innerHTML, /draggable="false"/);
});

test('an empty tab bar does not create an implicit default collection', () => {
  const api = setup();
  const tabs = { querySelector() { return null; } };
  api.renderTabs(tabs, [], null, false);
  assert.match(tabs.innerHTML, /尚未创建合集/);
  assert.doesNotMatch(tabs.innerHTML, /<button|默认合集/);
});

test('the active tab scrolls into view without moving the page', () => {
  const api = setup();
  let bounds = { left: 250, right: 350 };
  const viewport = {
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, right: 200 })
  };
  const tabs = {
    parentElement: viewport,
    querySelector() { return { getBoundingClientRect: () => bounds }; }
  };
  api.renderTabs(tabs, [{ id: 'book-one', name: 'First' }], 'book-one', false);
  assert.equal(viewport.scrollLeft, 150);
  bounds = { left: -25, right: 75 };
  api.renderTabs(tabs, [{ id: 'book-one', name: 'First' }], 'book-one', false);
  assert.equal(viewport.scrollLeft, 125);
});

test('tabs handle click, arrow navigation, wrapping, Home and End without triggering lesson shortcuts', async () => {
  const api = setup();
  const handlers = {};
  const selected = [];
  const clicked = [];
  let focused;
  const buttons = ['one', 'two', 'three'].map((id, index) => ({
    dataset: { collection: id }, disabled: false,
    selected: index === 0,
    closest() { return this; },
    getAttribute() { return String(this.selected); },
    click() { clicked.push(id); },
    focus() { focused = id; }
  }));
  const tabs = {
    addEventListener(type, callback) { handlers[type] = callback; },
    querySelectorAll() { return buttons; },
    querySelector() { return buttons.find(button => button.selected); }
  };
  api.bindTabs(tabs, async id => {
    selected.push(id);
    buttons.forEach(button => { button.selected = button.dataset.collection === id; });
  });
  await handlers.click({ target: buttons[0] });
  assert.equal(selected.length, 0);
  await handlers.click({ target: buttons[1] });
  assert.deepEqual(selected, ['two']);
  assert.equal(focused, 'two');
  buttons[2].disabled = true;
  await handlers.click({ target: buttons[2] });
  assert.equal(selected.length, 1);
  buttons[2].disabled = false;
  for (const [key, index, expected] of [
    ['ArrowRight', 0, 'two'], ['ArrowLeft', 0, 'three'],
    ['Home', 1, 'one'], ['End', 1, 'three']
  ]) {
    let prevented = false;
    let stopped = false;
    handlers.keydown({
      key, target: buttons[index],
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; }
    });
    assert.equal(clicked.at(-1), expected);
    assert.equal(prevented, true);
    assert.equal(stopped, true);
  }
});

test('remaining pages have no footer or removed-page links and keep valid inline scripts', () => {
  const root = resolve(__dirname, '..');
  assert.equal(existsSync(resolve(root, 'about.html')), false);
  assert.equal(existsSync(resolve(root, 'donate.html')), false);
  for (const name of readdirSync(root).filter(name => name.endsWith('.html'))) {
    const page = readFileSync(resolve(root, name), 'utf8');
    assert.doesNotMatch(page, /<footer\b|pwaFooterInstall|footerInstall|(?:about|donate)\.html/);
    for (const script of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (!script[1].includes('application/ld+json')) new vm.Script(script[2], { filename: name });
    }
  }
  for (const name of ['sw.js', 'sitemap.xml']) {
    assert.doesNotMatch(readFileSync(resolve(root, name), 'utf8'), /(?:about|donate)\.html/);
  }
  const worker = readFileSync(resolve(root, 'sw.js'), 'utf8');
  for (const match of worker.matchAll(/'(\.\/[^']+\.html)'/g)) {
    assert.equal(existsSync(resolve(root, match[1])), true, match[1]);
  }
});

function sortableTabs() {
  const api = setup();
  const handlers = {};
  const moves = [];
  const selections = [];
  const buttons = ['one', 'two', 'three'].map((id, index) => ({
    dataset: { collection: id }, disabled: false,
    classes: new Set(),
    closest() { return this; },
    getBoundingClientRect() { return { left: index * 100, width: 80 }; }
  }));
  buttons.forEach(button => {
    button.classList = {
      add: (...names) => names.forEach(name => button.classes.add(name)),
      remove: (...names) => names.forEach(name => button.classes.delete(name))
    };
  });
  const tabs = {
    parentElement: {
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0, right: 300 })
    },
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelectorAll() { return buttons.filter(button => !button.disabled); },
    contains(target) { return buttons.includes(target); }
  };
  api.bindTabs(tabs, async id => selections.push(id), async (ids, moved) => {
    moves.push({ ids: Array.from(ids), moved });
  });
  const event = (index, clientX = index * 100) => ({
    target: buttons[index], clientX,
    dataTransfer: { setData() {} },
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  });
  return { handlers, moves, selections, buttons, tabs, event };
}

test('dragging reorders before or after the target without selecting a collection', async () => {
  for (const [source, target, x, expected] of [
    [0, 2, 210, ['two', 'one', 'three']],
    [0, 2, 270, ['two', 'three', 'one']],
    [2, 0, 10, ['three', 'one', 'two']]
  ]) {
    const { handlers, moves, selections, buttons, event } = sortableTabs();
    handlers.dragstart(event(source));
    assert.equal(buttons[source].classes.has('is-dragging'), true);
    await handlers.click(event(target));
    handlers.dragover(event(target, x));
    assert.equal(buttons[target].classes.has(x % 100 < 40 ? 'drop-before' : 'drop-after'), true);
    await handlers.drop(event(target, x));
    assert.deepEqual(moves, [{ ids: expected, moved: buttons[source].dataset.collection }]);
    assert.deepEqual(selections, []);
    assert.equal(buttons.every(button => button.classes.size === 0), true);
  }
});

test('external, canceled, disabled and unchanged drags never save an order', async () => {
  const { handlers, moves, buttons, event } = sortableTabs();
  await handlers.drop(event(1));
  buttons[0].disabled = true;
  const disabled = event(0);
  handlers.dragstart(disabled);
  assert.equal(disabled.prevented, true);
  buttons[0].disabled = false;
  handlers.dragstart(event(0));
  await handlers.drop(event(0));
  handlers.dragstart(event(0));
  await handlers.drop(event(1, 100));
  handlers.dragstart(event(0));
  handlers.dragend();
  await handlers.drop(event(2));
  handlers.dragstart(event(0));
  buttons[0].disabled = true;
  await handlers.drop(event(2));
  assert.deepEqual(moves, []);
});

test('dragging near the tab bar edges scrolls and leaving clears the drop indicator', () => {
  const { handlers, buttons, tabs, event } = sortableTabs();
  handlers.dragstart(event(1));
  handlers.dragover(event(2, 290));
  assert.equal(tabs.parentElement.scrollLeft, 20);
  handlers.dragleave({ relatedTarget: null });
  assert.equal(buttons[2].classes.size, 0);
  handlers.dragover(event(0, 10));
  assert.equal(tabs.parentElement.scrollLeft, 0);
  handlers.dragend();
  assert.equal(buttons.every(button => button.classes.size === 0), true);
});

test('Alt plus arrow keys moves tabs without wrapping or selecting a collection', async () => {
  const { handlers, moves, selections, event } = sortableTabs();
  for (const [index, key] of [[0, 'ArrowLeft'], [2, 'ArrowRight'], [1, 'ArrowLeft'], [1, 'ArrowRight']]) {
    const keyEvent = { ...event(index), key, altKey: true };
    await handlers.keydown(keyEvent);
    assert.equal(keyEvent.prevented, true);
    assert.equal(keyEvent.stopped, true);
  }
  assert.deepEqual(moves, [
    { ids: ['two', 'one', 'three'], moved: 'two' },
    { ids: ['one', 'three', 'two'], moved: 'two' }
  ]);
  assert.deepEqual(selections, []);
});
