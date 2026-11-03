const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const read = name => readFileSync(resolve(__dirname, '..', name), 'utf8');

function importer() {
  const records = new Map();
  const context = vm.createContext({
    Blob, TextDecoder, Uint8Array, DataView,
    NCE_RESOURCES: {
      listCollections: async () => [{ id: 'lib' }, { id: 'book-two' }],
      getLesson: async (book, filename) => records.get(`${book}/${filename}`),
      putLesson: async record => records.set(`${record.book}/${record.filename}`, record)
    }
  });
  context.window = context;
  vm.runInContext(read('assets/resources.js'), context);
  return { context, records, api: context.NCE_IMPORT };
}

const textFile = (name, text) => ({ name, text: async () => text });

test('imports with identical filenames stay isolated and partial reimports merge only within the target', async () => {
  const { api, records } = importer();
  const defaultAudio = { name: 'one.mp3' };
  const otherAudio = { name: 'one.mp3' };
  await api.importFileList([defaultAudio, textFile('one.lrc', '[ti:Default]\n[00:00]Default')], null, 'lib');
  await api.importFileList([otherAudio], null, 'book-two');
  await api.importFileList([textFile('one.lrc', '[ti:Other]\n[00:00]Other')], null, 'book-two');
  assert.equal(records.size, 2);
  assert.equal(records.get('lib/one').title, 'Default');
  assert.equal(records.get('lib/one').audioBlob, defaultAudio);
  assert.equal(records.get('lib/one').lrcFilename, 'one.lrc');
  assert.equal(records.get('book-two/one').title, 'Other');
  assert.equal(records.get('book-two/one').audioBlob, otherAudio);
  assert.equal(records.get('book-two/one').book, 'book-two');
});

test('folder pairing preserves the selected collection and rejects unknown destinations', async () => {
  const { api, records } = importer();
  const audio = { name: 'one.mp3', webkitRelativePath: 'folder/one.mp3' };
  const lrc = { ...textFile('one.lrc', '[00:00]Hello'), webkitRelativePath: 'folder/one.lrc' };
  const progress = [];
  const result = await api.importFileList([audio, lrc], (...args) => progress.push(args), 'book-two');
  assert.equal(result.imported, 1);
  assert.equal(records.get('book-two/one').lrcText, '[00:00]Hello');
  assert.equal(records.get('book-two/one').lrcFilename, 'one.lrc');
  assert.equal(progress.length, 1);
  await assert.rejects(api.importFileList([audio], null, 'missing'), /目标合集不存在/);
  await assert.rejects(api.importFileList([audio]), /请先创建并选择合集/);
  assert.equal(records.size, 1);
});

test('ZIP imports require a collection and import into that collection', async () => {
  const { api, records } = importer();
  const name = Buffer.from('one.lrc');
  const data = Buffer.from('[00:00]Hello');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  await api.importZipFile({
    arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)
  }, null, 'book-two');
  assert.equal(records.size, 1);
  assert.equal(records.get('book-two/one').lrcText, '[00:00]Hello');
  assert.equal(records.get('book-two/one').lrcFilename, 'one.lrc');
  await assert.rejects(api.importZipFile({}), /请先创建并选择合集/);
});

test('import preserves the exact LRC filename and headers through audio-only reimports', async () => {
  const { api, records } = importer();
  const text = '[al:Album]\r\n[ar:Artist]\r\n[ti:Different title]\r\n[by:Author]\r\n[offset:10]\r\n[00:00.001]Hello\r\n';
  const file = { ...textFile('01 Hello.LRC', text), webkitRelativePath: 'folder/01 Hello.LRC' };
  await api.importFileList([file], null, 'lib');
  await api.importFileList([{ name: '01 Hello.mp3' }], null, 'lib');
  assert.equal(records.get('lib/01 Hello').lrcFilename, '01 Hello.LRC');
  assert.equal(records.get('lib/01 Hello').lrcText, text);
  assert.equal(records.get('lib/01 Hello').title, 'Different title');
  await api.importFileList([textFile('01 Hello.lrc', '')], null, 'lib');
  assert.equal(records.get('lib/01 Hello').lrcFilename, '01 Hello.lrc');
  assert.equal(records.get('lib/01 Hello').lrcText, '');
});

test('lesson page keeps its lesson heading without branding or collection controls', () => {
  const page = read('lesson.html');
  const header = page.match(/<header class="hero">([\s\S]*?)<\/header>/)[1];
  assert.match(header, /id="lessonTitle"/);
  assert.match(header, /id="lessonSub"/);
  assert.doesNotMatch(header, /EchoFlow|collection|tablist/);
  assert.doesNotMatch(page, /assets\/collections\.js|id="collectionTabs"|id="createCollectionOpen"/);
  assert.doesNotMatch(read('assets/lesson.js'), /NCE_COLLECTIONS|#collectionTabs|#createCollectionOpen/);
});

test('returning from a lesson pauses playback and opens the same collection on the home page', () => {
  const source = read('assets/lesson.js');
  let href;
  let click;
  let pauses = 0;
  const context = vm.createContext({
    book: 'book-one',
    backLink: {
      setAttribute(name, value) { if (name === 'href') href = value; },
      addEventListener(type, handler) { if (type === 'click') click = handler; }
    },
    pauseForNavigation: () => { pauses++; },
    location: { href: '' }
  });
  const start = source.indexOf('    // 返回\n');
  const end = source.indexOf('    // --------------------------', start);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(href, 'index.html#book-one');
  let prevented = false;
  click({ preventDefault() { prevented = true; } });
  assert.equal(context.location.href, 'index.html#book-one');
  assert.equal(pauses, 1);
  assert.equal(prevented, true);
});

function collectionStore(records) {
  let failCommit = false;
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          transaction() {
            const pending = new Map(records);
            let aborted = false;
            const transaction = {
              abort() {
                aborted = true;
                queueMicrotask(() => transaction.onabort());
              },
              objectStore() {
                return {
                  getAll() {
                    const request = {};
                    queueMicrotask(() => {
                      request.result = Array.from(pending.values(), item => ({ ...item }));
                      request.onsuccess();
                      queueMicrotask(() => {
                        if (aborted) return;
                        if (failCommit) {
                          transaction.error = new Error('Disk full');
                          transaction.onabort();
                        } else {
                          records.clear();
                          pending.forEach((value, key) => records.set(key, value));
                          transaction.oncomplete?.();
                        }
                      });
                    });
                    return request;
                  },
                  put(item) { pending.set(item.id, { ...item }); },
                  add(item) { pending.set(item.id, { ...item }); }
                };
              }
            };
            return transaction;
          }
        };
        request.onsuccess();
      });
      return request;
    }
  };
  const context = vm.createContext({ indexedDB, crypto: require('node:crypto').webcrypto });
  context.window = context;
  vm.runInContext(read('assets/resource-store.js'), context);
  return { api: context.NCE_RESOURCES, failCommit() { failCommit = true; } };
}

test('collection order persists across reloads, preserves legacy order and appends new collections', async () => {
  const records = new Map([
    ['two', { id: 'two', name: 'Two', createdAt: 2 }],
    ['one', { id: 'one', name: 'One', createdAt: 1 }],
    ['three', { id: 'three', name: 'Three', createdAt: 3 }]
  ]);
  const { api } = collectionStore(records);
  const ids = async store => Array.from(await store.listCollections(), item => item.id);
  assert.deepEqual(await ids(api), ['one', 'two', 'three']);
  await api.reorderCollections(['three', 'one', 'two']);
  const reloaded = collectionStore(records).api;
  assert.deepEqual(await ids(reloaded), ['three', 'one', 'two']);
  const created = await reloaded.createCollection('New');
  assert.deepEqual(await ids(reloaded), ['three', 'one', 'two', created.id]);
  records.delete('one');
  const last = await reloaded.createCollection('Last');
  assert.deepEqual(await ids(reloaded), ['three', 'two', created.id, last.id]);
  assert.equal(records.get('three').name, 'Three');
  assert.equal(records.get('three').createdAt, 3);
});

test('creating a collection before any reorder preserves the legacy creation order', async () => {
  const records = new Map([
    ['two', { id: 'two', name: 'Two', createdAt: 2 }],
    ['one', { id: 'one', name: 'One', createdAt: 1 }]
  ]);
  const { api } = collectionStore(records);
  const created = await api.createCollection('New');
  assert.deepEqual(Array.from(await api.listCollections(), item => item.id), ['one', 'two', created.id]);
  await assert.rejects(api.createCollection('New'), /已存在同名合集/);
});

test('invalid or stale collection orders and failed commits leave saved order untouched', async () => {
  const records = new Map([
    ['one', { id: 'one', name: 'One', createdAt: 1 }],
    ['two', { id: 'two', name: 'Two', createdAt: 2 }]
  ]);
  const { api, failCommit } = collectionStore(records);
  for (const invalid of [null, ['one', 'one'], ['two'], ['two', 'missing']]) {
    await assert.rejects(api.reorderCollections(invalid), /排序无效|列表已变化/);
    assert.equal(records.get('one').order, undefined);
    assert.equal(records.get('two').order, undefined);
  }
  failCommit();
  await assert.rejects(api.reorderCollections(['two', 'one']), /Disk full/);
  assert.equal(records.get('one').order, undefined);
  assert.equal(records.get('two').order, undefined);
});
