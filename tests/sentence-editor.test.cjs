const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const read = name => readFileSync(resolve(__dirname, '..', name), 'utf8');
const source = read('assets/lesson.js');
const original = '[ti:Example]\n[00:01.001]One | 一\n[00:03.200]Two | 二\n[00:06.000]Three';

function helpers(context = vm.createContext({})) {
  vm.runInContext(read('assets/utils.js'), context);
  vm.runInContext('const { timeTagsToSeconds, hasCJK, formatTime, escapeHTML } = NCEUtils;', context);
  vm.runInContext(source.slice(source.indexOf('  function parseLrcText('), source.indexOf('  // 从 IndexedDB')), context);
  return context;
}

test('timestamp input accepts millisecond precision and rejects malformed or unsafe values', () => {
  const { parseSentenceTimestamp: parse } = helpers();
  for (const [input, ms] of [
    ['00:00.001', 1], ['0:12.3', 12300], ['1:02.03', 62030], ['100:00', 6000000],
    [' 00:01.000 ', 1000]
  ]) assert.equal(parse(input), ms);
  for (const input of ['', '-1:00.000', '00:60.000', '00:12.1234', '12.3', '0:1', 'Infinity',
    '999999999999999:00']) assert.throws(() => parse(input), /时间/);
});

test('LRC timestamps pad minutes to at least two digits and always output three fractional digits', () => {
  const { formatSentenceTimestamp: format } = helpers();
  for (const [seconds, expected] of [
    [0, '00:00.000'], [0.001, '00:00.001'], [12.12, '00:12.120'],
    [83.456, '01:23.456'], [59.9996, '01:00.000'], [6000.123, '100:00.123']
  ]) assert.equal(format(seconds), expected);
});

test('two and three fractional digits can mix without changing timestamp meaning', () => {
  const { parseLrcText, parseSentenceTimestamp } = helpers();
  const sentences = parseLrcText('[00:01.12]A\n[00:02.123]B\n[00:03.120]C').items;
  assert.equal(sentences[0].start, 1.12);
  assert.equal(sentences[1].start, 2.123);
  assert.equal(sentences[2].start, 3.12);
  assert.equal(parseSentenceTimestamp('00:01.12'), 1120);
  assert.equal(parseSentenceTimestamp('00:01.120'), 1120);
});

test('timestamp bounds are strictly between neighbours, with exact 1ms boundaries', () => {
  const { parseLrcText, validateSentenceTimestamp: validate } = helpers();
  const sentences = parseLrcText(original).items;
  for (const ms of [1002, 1101, 5999]) assert.doesNotThrow(() => validate(ms, 1, sentences, 10));
  for (const ms of [1000, 1001, 6000, 6001]) {
    assert.throws(() => validate(ms, 1, sentences, 10), /时间须/);
  }
  assert.doesNotThrow(() => validate(0, 0, sentences, 10));
  assert.throws(() => validate(-1, 0, sentences, 10), /时间须/);
  assert.doesNotThrow(() => validate(9999, 2, sentences, 10));
  assert.throws(() => validate(10000, 2, sentences, 10), /时间须/);
  assert.doesNotThrow(() => validate(12000, 2, sentences, NaN));
  assert.throws(() => validate(1100.1, 1, sentences, 10), /时间须/);
});

test('LRC editing preserves metadata, unrelated rows, CRLF and extra time tags', () => {
  const { editLrcSentence, parseLrcText } = helpers();
  const input = '[ti:Example]\r\n[offset:0]\r\n\r\n[00:01.00]First\r\n' +
    '[00:02.00][00:20.00]Old\r\n[00:02.00][00:20.00]旧句\r\n[00:04.00]Last\r\n';
  const output = editLrcSentence(input, 1, { start: 2.123, en: 'New <text>', cn: '新句' });
  assert.equal(output, '[ti:Example]\r\n[offset:0]\r\n\r\n[00:01.00]First\r\n' +
    '[00:02.123][00:20.00]New <text> | 新句\r\n[00:04.00]Last\r\n');
  const parsed = parseLrcText(output);
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].end, 2.123);
  assert.equal(parsed.items[1].en, 'New <text>');
  assert.equal(parsed.items[1].cn, '新句');
  const secondEdit = editLrcSentence(output, 2, { start: 4.5, en: 'Final', cn: '' });
  assert.equal(parseLrcText(secondEdit).items[2].en, 'Final');
  for (const en of ['New\nline', 'pipe | text', 'carriage\rreturn']) {
    assert.throws(() => editLrcSentence(input, 1, { start: 2, en, cn: '' }), /一行/);
  }
});

function editor() {
  const elements = new Map();
  const events = new Map();
  const notices = [];
  const saved = [];
  const favorites = [];
  const frames = [];
  let write = async (...args) => saved.push(args);
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, hidden: true, value: '', disabled: false, textContent: '', isConnected: true,
      classList: { add() {}, remove() {} },
      setAttribute() {}, removeAttribute() {},
      addEventListener(type, handler) { this[type] = handler; },
      querySelectorAll: () => [...elements.values()].filter(item => item.id.startsWith('sentenceEditor')),
      focus() { context.document.activeElement = this; }
    });
    return elements.get(id);
  }
  const context = helpers(vm.createContext({
    console: { error() {} },
    document: {
      activeElement: null,
      body: { style: {} },
      addEventListener(type, handler) { events.set(type, handler); },
      getElementById: () => null
    },
    requestAnimationFrame: callback => frames.push(callback),
    qs: selector => element(selector.slice(1)),
    book: 'book-one', base: 'example',
    audio: { duration: 10, paused: false },
    playSeq: 0, loopReplayPending: true, idx: 1, segmentEnd: 6,
    _trapRoot: null, skipIntro: false, firstContentIndex: 0, shadowStartIndex: 0,
    _lastEndAdjusted: false,
    listEl: { querySelector: () => element('sentence') },
    clearAdvance() { context.clearedAdvance = true; },
    cancelIOSUnlockPause() {},
    pauseForNavigation() { context.audio.paused = true; },
    endFor: item => item.end,
    highlight: index => { context.highlighted = index; },
    enableTrap() { context.trapping = true; },
    disableTrap() { context.trapping = false; },
    adjustLastEndIfPossible() { context.items.at(-1).end = context.audio.duration; },
    findFirstContentIndex: () => 0,
    sentenceFavId: index => `book-one/example::${index}`,
    saveSentenceFavs: items => favorites.push(structuredClone(items)),
    render() { context.renders = (context.renders || 0) + 1; },
    showNotification: message => notices.push(message),
    window: { NCE_RESOURCES: { updateLessonLrc: (...args) => write(...args) } }
  }));
  context.items = context.parseLrcText(original).items;
  context.lessonLrcText = original;
  context.sentenceFavs = [{ id: 'book-one/example::1', en: 'Two', cn: '二', start: 3.2 }];
  for (const name of ['Overlay', 'Panel', 'Time', 'En', 'Cn', 'Error']) {
    context[`sentenceEditor${name}`] = element(`sentenceEditor${name}`);
  }
  vm.runInContext(source.slice(source.indexOf('    // 句子编辑'), source.indexOf('    // --------------------------\n    // 全局快捷键')), context);
  return {
    context, elements, notices, saved, favorites, element,
    open: index => { context.openSentenceEditor(index); frames.splice(0).forEach(callback => callback()); },
    close: () => context.closeSentenceEditor(),
    setWrite: callback => { write = callback; },
    escape: () => events.get('keydown')({ key: 'Escape', preventDefault() {} })
  };
}

test('opening pauses playback, cancels pending loops and populates an accessible modal', () => {
  const fixture = editor();
  const { context, element } = fixture;
  fixture.open(1);
  assert.equal(context.audio.paused, true);
  assert.equal(context.playSeq, 1);
  assert.equal(context.loopReplayPending, false);
  assert.equal(context.clearedAdvance, true);
  assert.equal(context.trapping, true);
  assert.equal(element('sentenceEditorPanel').hidden, false);
  assert.equal(element('sentenceEditorTime').value, '00:03.200');
  assert.equal(element('sentenceEditorEn').value, 'Two');
  assert.equal(context.document.activeElement.id, 'sentenceEditorDec');
  assert.match(element('sentenceEditorRange').textContent, /00:01\.001.*00:06\.000/);
});

test('stepper moves exactly 100ms, including carry, without crossing neighbours', () => {
  const fixture = editor();
  const { element } = fixture;
  fixture.open(1);
  element('sentenceEditorInc').click();
  assert.equal(element('sentenceEditorTime').value, '00:03.300');
  element('sentenceEditorDec').click();
  assert.equal(element('sentenceEditorTime').value, '00:03.200');
  element('sentenceEditorTime').value = '0:05.900';
  element('sentenceEditorInc').click();
  assert.equal(element('sentenceEditorTime').value, '0:05.900');
  assert.equal(element('sentenceEditorError').hidden, false);
  element('sentenceEditorTime').value = '0:01.101';
  element('sentenceEditorDec').click();
  assert.equal(element('sentenceEditorTime').value, '0:01.101');
  const last = editor();
  last.context.audio.duration = 100;
  last.open(2);
  last.element('sentenceEditorTime').value = '0:59.950';
  last.element('sentenceEditorInc').click();
  assert.equal(last.element('sentenceEditorTime').value, '01:00.050');
});

test('save persists before closing and refreshes text, endpoints and existing favorites', async () => {
  const fixture = editor();
  const { context, element, saved, favorites } = fixture;
  fixture.open(1);
  element('sentenceEditorTime').value = '0:03.123';
  element('sentenceEditorEn').value = '<b>Edited</b>';
  element('sentenceEditorCn').value = '修改';
  await element('sentenceEditorDone').click();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].slice(0, 3), ['book-one', 'example', original]);
  assert.equal(context.lessonLrcText, saved[0][3]);
  assert.equal(context.items[0].end, 3.123);
  assert.equal(context.items[1].start, 3.123);
  assert.equal(context.items.at(-1).end, 10);
  assert.equal(context.segmentEnd, 6);
  assert.equal(context.renders, 1);
  assert.equal(favorites[0][0].en, '<b>Edited</b>');
  assert.equal(favorites[0][0].start, 3.123);
  assert.equal(element('sentenceEditorPanel').hidden, true);
  assert.equal(context.trapping, false);
  assert.equal(context.audio.paused, true);
});

test('close, overlay and Escape all save; unchanged text closes without rewriting LRC', async () => {
  for (const trigger of ['sentenceEditorClose', 'sentenceEditorOverlay', 'Escape']) {
    const fixture = editor();
    fixture.open(1);
    fixture.element('sentenceEditorEn').value = 'Saved';
    if (trigger === 'Escape') {
      fixture.escape();
      await new Promise(resolve => setImmediate(resolve));
    } else await fixture.element(trigger).click();
    assert.equal(fixture.saved.length, 1);
    assert.equal(fixture.element('sentenceEditorPanel').hidden, true);
  }
  const fixture = editor();
  fixture.open(1);
  await fixture.close();
  assert.equal(fixture.saved.length, 0);
  assert.equal(fixture.element('sentenceEditorPanel').hidden, true);
});

test('invalid input or failed writes keep the draft open and leave playback data untouched', async () => {
  const fixture = editor();
  const { context, element } = fixture;
  fixture.open(1);
  for (const value of ['bad', '0:01.001', '0:06.000']) {
    element('sentenceEditorTime').value = value;
    await fixture.close();
    assert.equal(element('sentenceEditorPanel').hidden, false);
    assert.equal(element('sentenceEditorError').hidden, false);
    assert.equal(fixture.saved.length, 0);
  }
  element('sentenceEditorTime').value = '0:03.300';
  element('sentenceEditorEn').value = 'Draft';
  fixture.setWrite(async () => { throw new Error('Disk full'); });
  await fixture.close();
  assert.equal(element('sentenceEditorError').textContent, 'Disk full');
  assert.equal(element('sentenceEditorEn').value, 'Draft');
  assert.equal(element('sentenceEditorPanel').hidden, false);
  assert.equal(element('sentenceEditorEn').disabled, false);
  assert.equal(context.items[1].en, 'Two');
  assert.equal(context.lessonLrcText, original);
  fixture.setWrite(async () => {});
  await fixture.close();
  assert.equal(element('sentenceEditorPanel').hidden, true);
  assert.equal(context.items[1].en, 'Draft');
});

test('saving is single-flight and controls stay disabled until commit', async () => {
  const fixture = editor();
  fixture.open(1);
  fixture.element('sentenceEditorEn').value = 'Updated';
  let finish;
  let calls = 0;
  fixture.setWrite(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = fixture.close();
  await fixture.close();
  assert.equal(calls, 1);
  assert.equal(fixture.element('sentenceEditorEn').disabled, true);
  assert.equal(fixture.element('sentenceEditorPanel').hidden, false);
  finish();
  await pending;
  assert.equal(fixture.element('sentenceEditorPanel').hidden, true);
});

test('opening the editor prevents pending metadata seeks and automatic loops from restarting audio', async () => {
  let ready;
  let schedules = 0;
  const context = vm.createContext({
    sentenceEditorPanel: { hidden: true },
    idx: 0, items: [{ start: 1, end: 2 }],
    playSeq: 0, loopReplayPending: false, isIOSLike: false,
    audio: { paused: true },
    ensureMetadata: () => new Promise(resolve => { ready = resolve; }),
    clearShadowGapTimer: () => { schedules++; }
  });
  const start = source.indexOf('    async function playSegment(');
  vm.runInContext(source.slice(start, source.indexOf('    // --------------------------', start)), context);
  const pending = context.playSegment(0, { manual: true });
  context.sentenceEditorPanel.hidden = false;
  context.playSeq++;
  ready();
  await pending;
  assert.equal(schedules, 0);
  await context.playSegment(0, { manual: false });
  assert.equal(schedules, 0);
});

test('rendering edited sentences escapes markup and preserves keyboard focus targets', () => {
  const context = helpers(vm.createContext({
    items: [{ en: '<img src=x onerror=alert(1)>', cn: '<script>test</script>' }],
    sentenceFavSet: new Set(), sentenceFavId: () => 'id',
    qs: () => context.list, list: {}, updateListenModeUI() {}
  }));
  vm.runInContext(source.slice(source.indexOf('    function render()'), source.indexOf('    function toggleSentenceFav')), context);
  context.render();
  assert.match(context.list.innerHTML, /tabindex="0"/);
  assert.match(context.list.innerHTML, /&lt;img/);
  assert.match(context.list.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(context.list.innerHTML, /<img|<script/);
});

function storage(record, failCommit = false) {
  let persisted = record;
  const context = vm.createContext({
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = {
            transaction() {
              let pending = persisted;
              let aborted = false;
              const transaction = {
                abort() { aborted = true; queueMicrotask(() => transaction.onabort()); },
                objectStore: () => ({
                  get() {
                    const request = {};
                    queueMicrotask(() => {
                      request.result = persisted;
                      request.onsuccess();
                      queueMicrotask(() => {
                        if (aborted) return;
                        if (failCommit) {
                          transaction.error = new Error('Disk full');
                          transaction.onabort();
                        } else {
                          persisted = pending;
                          transaction.oncomplete();
                        }
                      });
                    });
                    return request;
                  },
                  put(value) { pending = value; }
                })
              };
              return transaction;
            }
          };
          request.onsuccess();
        });
        return request;
      }
    }
  });
  context.window = context;
  vm.runInContext(read('assets/resource-store.js'), context);
  return { api: context.NCE_RESOURCES, record: () => persisted };
}

test('IndexedDB edits wait for commit, preserve audio/metadata and reject stale or deleted lessons', async () => {
  const record = {
    id: 'book/lesson', book: 'book', filename: 'lesson', lrcText: original,
    audioBlob: { audio: true }, title: 'Title', importedAt: 123, lrcFilename: 'lesson.LRC'
  };
  const store = storage(record);
  await store.api.updateLessonLrc('book', 'lesson', original, 'new');
  assert.equal(store.record().lrcText, 'new');
  assert.equal(store.record().audioBlob, record.audioBlob);
  assert.equal(store.record().importedAt, 123);
  assert.equal(store.record().title, 'Title');
  assert.equal(store.record().lrcFilename, 'lesson.LRC');
  await assert.rejects(store.api.updateLessonLrc('book', 'lesson', original, 'stale'), /其他页面更新/);
  assert.equal(store.record().lrcText, 'new');
  const deleted = storage(undefined);
  await assert.rejects(deleted.api.updateLessonLrc('book', 'lesson', original, 'new'), /课程已删除/);
  assert.equal(deleted.record(), undefined);
  const failed = storage(record, true);
  await assert.rejects(failed.api.updateLessonLrc('book', 'lesson', original, 'new'), /Disk full/);
  assert.equal(failed.record(), record);
});
