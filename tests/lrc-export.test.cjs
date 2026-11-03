const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const read = name => readFileSync(resolve(__dirname, '..', name), 'utf8');

function setup(records = []) {
  const downloads = [];
  const blobs = new Map();
  const revoked = [];
  const timers = [];
  const attached = new Set();
  const queries = [];
  const context = vm.createContext({
    Blob, TextDecoder, TextEncoder, Uint8Array, DataView,
    indexedDB: {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = {
            transaction(name, mode) {
              assert.equal(name, 'lessons');
              assert.equal(mode, 'readonly');
              return {
                objectStore: () => ({
                  index(name) {
                    assert.equal(name, 'book');
                    return {
                      getAll(book) {
                        queries.push(book);
                        const request = {};
                        queueMicrotask(() => {
                          request.result = records;
                          request.onsuccess();
                        });
                        return request;
                      }
                    };
                  }
                })
              };
            }
          };
          request.onsuccess();
        });
        return request;
      }
    },
    document: {
      body: { appendChild: element => attached.add(element) },
      createElement(tag) {
        assert.equal(tag, 'a');
        return {
          click() {
            assert.ok(attached.has(this));
            downloads.push({ filename: this.download, blob: blobs.get(this.href) });
          },
          remove() { attached.delete(this); }
        };
      }
    },
    URL: {
      createObjectURL(blob) {
        const url = `blob:${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL: url => revoked.push(url)
    },
    setTimeout: (callback, delay) => timers.push({ callback, delay })
  });
  context.window = context;
  vm.runInContext(read('assets/resource-store.js'), context);
  context.NCE_RESOURCES.listCollections = async () => [{ id: 'one', name: '合集一' }, { id: 'two', name: 'Second' }];
  vm.runInContext(read('assets/resources.js'), context);
  return { context, api: context.NCE_IMPORT, downloads, blobs, revoked, timers, attached, queries };
}

async function readZip(blob) {
  const zip = Buffer.from(await blob.arrayBuffer());
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  const centralOffset = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt16LE(end + 8), count);
  assert.equal(zip.readUInt32LE(end + 12), end - centralOffset);
  const files = [];
  let local = 0;
  let central = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt16LE(local + 6), 0x0800);
    assert.equal(zip.readUInt16LE(central + 8), 0x0800);
    assert.equal(zip.readUInt16LE(local + 8), 0);
    assert.equal(zip.readUInt16LE(central + 10), 0);
    assert.equal(zip.readUInt32LE(central + 42), local);
    const size = zip.readUInt32LE(local + 18);
    assert.equal(zip.readUInt32LE(local + 22), size);
    assert.equal(zip.readUInt32LE(central + 20), size);
    assert.equal(zip.readUInt32LE(central + 24), size);
    const nameSize = zip.readUInt16LE(local + 26);
    assert.equal(zip.readUInt16LE(central + 28), nameSize);
    const name = zip.subarray(local + 30, local + 30 + nameSize);
    assert.deepEqual(zip.subarray(central + 46, central + 46 + nameSize), name);
    const data = zip.subarray(local + 30 + nameSize, local + 30 + nameSize + size);
    const crc = zip.readUInt32LE(local + 14);
    assert.equal(zip.readUInt32LE(central + 16), crc);
    files.push({ name: name.toString('utf8'), data, crc });
    local += 30 + nameSize + size;
    central += 46 + nameSize;
  }
  assert.equal(local, centralOffset);
  assert.equal(central, end);
  return files;
}

test('exports one ZIP containing only the chosen collection LRC files with exact filenames, headers and content', async () => {
  const original = '\ufeff[al: Original album ]\r\n[ar:Artist]\r\n[ti:Display title, not filename]\r\n' +
    '[by:Author]\r\n[offset:125]\r\n[custom:kept]\r\n\r\n[00:01.100]Edited sentence | 修改后的句子\r\n';
  const fixture = setup([
    { book: 'one', filename: '01 原始', lrcFilename: '01 原始.LRC', lrcText: original, audioBlob: new Blob(['audio']) },
    { book: 'two', filename: 'other', lrcText: '[ti:Other collection]\n[00:00]Other' },
    { book: 'one', filename: '02 Legacy', lrcText: '[ti:Legacy]\n[00:02.000]Old\n' },
    { book: 'one', filename: '03 Empty', lrcFilename: '03 Empty.lrc', lrcText: '' },
    { book: 'one', filename: '04 Audio', audioBlob: new Blob(['audio only']) }
  ]);
  const count = await fixture.api.exportCollectionLrc('one');
  assert.equal(count, 3);
  assert.deepEqual(fixture.queries, ['one']);
  assert.equal(fixture.downloads.length, 1);
  assert.equal(fixture.downloads[0].filename, '合集一-LRC.zip');
  assert.equal(fixture.downloads[0].blob.type, 'application/zip');
  const files = await readZip(fixture.downloads[0].blob);
  assert.deepEqual(files.map(item => item.name), [
    '01 原始.LRC', '02 Legacy.lrc', '03 Empty.lrc'
  ]);
  assert.deepEqual(files[0].data, Buffer.from(original, 'utf8'));
  assert.equal(files[1].data.toString('utf8'), '[ti:Legacy]\n[00:02.000]Old\n');
  assert.equal(files[2].data.length, 0);
  assert.equal(files[2].crc, 0);
  assert.equal(fixture.attached.size, 0);
  assert.equal(fixture.revoked.length, 0);
  assert.equal(fixture.timers.length, 1);
  for (const timer of fixture.timers) {
    assert.equal(timer.delay, 60000);
    timer.callback();
  }
  assert.equal(fixture.revoked.length, 1);
});

test('ZIP checksum matches the standard CRC32 vector and the archive can be reimported', async () => {
  const fixture = setup([
    { book: 'one', filename: 'checksum', lrcText: '123456789' },
    { book: 'one', filename: '字幕', lrcFilename: '字幕.LRC', lrcText: '[ti:Title]\r\n[00:01.120]Hello | 你好\r\n' }
  ]);
  await fixture.api.exportCollectionLrc('one');
  const blob = fixture.downloads[0].blob;
  const files = await readZip(blob);
  assert.equal(files.find(file => file.name === 'checksum.lrc').crc, 0xcbf43926);
  const pairs = await fixture.api.pairsFromZip(await blob.arrayBuffer());
  assert.equal(pairs.length, 2);
  const subtitle = pairs.find(pair => pair.basename === '字幕');
  assert.equal(subtitle.lrc.path, '字幕.LRC');
  assert.equal(await subtitle.lrc.getText(), '[ti:Title]\r\n[00:01.120]Hello | 你好\r\n');
  assert.ok(pairs.every(pair => !pair.audio));
});

test('ZIP names safely use the collection name without changing names inside the archive', async () => {
  const fixture = setup([{ book: 'one', filename: '01 Original', lrcText: 'text' }]);
  fixture.context.NCE_RESOURCES.listCollections = async () => [{ id: 'one', name: 'A/B:合集?' }];
  await fixture.api.exportCollectionLrc('one');
  assert.equal(fixture.downloads[0].filename, 'A-B-合集--LRC.zip');
  const files = await readZip(fixture.downloads[0].blob);
  assert.equal(files[0].name, '01 Original.lrc');
});

test('ZIP size limits fail explicitly without starting a download', async () => {
  const fixture = setup();
  fixture.context.NCE_RESOURCES.listLrcFiles = async () =>
    Array.from({ length: 65535 }, (_, i) => ({ filename: `${i}.lrc`, lrcText: '' }));
  await assert.rejects(fixture.api.exportCollectionLrc('one'), /文件过多/);
  fixture.context.NCE_RESOURCES.listLrcFiles = async () =>
    [{ filename: 'a'.repeat(65536) + '.lrc', lrcText: '' }];
  await assert.rejects(fixture.api.exportCollectionLrc('one'), /超出 ZIP 格式限制/);
  assert.equal(fixture.downloads.length, 0);
});

test('subtitle projection never exposes audio blobs or includes another collection', async () => {
  const fixture = setup([
    { book: 'one', filename: 'a', lrcText: '[ti:A]', audioBlob: { audio: true } },
    { book: 'two', filename: 'b', lrcText: '[ti:B]' }
  ]);
  const files = await fixture.context.NCE_RESOURCES.listLrcFiles('one');
  assert.equal(files.length, 1);
  assert.deepEqual(Object.keys(files[0]).sort(), ['filename', 'lrcText']);
  assert.equal(files[0].filename, 'a.lrc');
  await assert.rejects(fixture.context.NCE_RESOURCES.listLrcFiles(), /请选择/);
});

test('missing collections, empty collections and storage failures do not start downloads', async () => {
  const fixture = setup([{ book: 'one', filename: 'audio-only', audioBlob: {} }]);
  await assert.rejects(fixture.api.exportCollectionLrc(), /请先创建并选择/);
  await assert.rejects(fixture.api.exportCollectionLrc('missing'), /目标合集不存在/);
  await assert.rejects(fixture.api.exportCollectionLrc('one'), /没有可导出/);
  assert.equal(fixture.downloads.length, 0);
  fixture.context.NCE_RESOURCES.listLrcFiles = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(fixture.api.exportCollectionLrc('one'), /Storage unavailable/);
  assert.equal(fixture.downloads.length, 0);
});

test('invalid file names are reported before any file downloads rather than silently renamed', async () => {
  const fixture = setup([
    { book: 'one', filename: 'a', lrcText: 'first' },
    { book: 'one', filename: 'z', lrcFilename: '../z.lrc', lrcText: 'invalid' }
  ]);
  await assert.rejects(fixture.api.exportCollectionLrc('one'), /字幕文件名无效/);
  assert.equal(fixture.downloads.length, 0);
});

test('failed download initiation is reported and still cleans up the link and Blob URL', async () => {
  const fixture = setup([{ book: 'one', filename: 'a', lrcText: 'a' }]);
  const create = fixture.context.document.createElement;
  fixture.context.document.createElement = tag => {
    const link = create(tag);
    link.click = () => { throw new Error('Download unavailable'); };
    return link;
  };
  await assert.rejects(fixture.api.exportCollectionLrc('one'), /Download unavailable/);
  assert.equal(fixture.attached.size, 0);
  fixture.timers[0].callback();
  assert.equal(fixture.revoked.length, 1);
});
