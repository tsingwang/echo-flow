/**
 * EchoFlow · resource-store.js
 * 用户导入的课程资源（音频 Blob + LRC 文本）本地持久化封装。
 * 存储介质：IndexedDB（音频文件较大，localStorage 无法容纳）。
 *
 * 记录结构（object store "lessons"，keyPath "id"）：
 *   {
 *     id: `${book}/${filename}`,   // book 为用户创建的合集 ID
 *     book: "book-...",
 *     filename: "01 Morning Dialogue",
 *     title: "Morning Dialogue",   // 取自 lrc [ti:]，否则为文件名
 *     audioBlob: Blob,             // audio/mpeg
 *     lrcText: "string",           // 原始 .lrc 文本
 *     lrcFilename: "01 Morning Dialogue.lrc", // 上传的字幕文件名（含原始扩展名）
 *     importedAt: <ms>
 *   }
 *
 * 暴露为全局 window.NCE_RESOURCES。
 */
(function () {
  'use strict';

  const DB_NAME = 'echoflow-collections';
  const DB_VERSION = 1;
  const STORE = 'lessons';
  const COLLECTIONS = 'collections';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      let blocked = false;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('book', 'book', { unique: false });
        }
        if (!db.objectStoreNames.contains(COLLECTIONS)) {
          db.createObjectStore(COLLECTIONS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        if (blocked) { req.result.close(); return; }
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        blocked = true;
        reject(new Error('请关闭其他 EchoFlow 页面后重试，以升级合集存储'));
      };
    });
    dbPromise = dbPromise.catch(error => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('资源存储事务已中止'));
      transaction.onerror = () => reject(transaction.error || new Error('资源存储事务失败'));
    });
  }

  function sortCollections(collections) {
    return collections.sort((a, b) =>
      (a.order ?? Infinity) - (b.order ?? Infinity) ||
      a.createdAt - b.createdAt || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  async function listCollections() {
    const db = await openDB();
    const collections = await reqToPromise(db.transaction(COLLECTIONS, 'readonly').objectStore(COLLECTIONS).getAll());
    return sortCollections(collections);
  }

  async function reorderCollections(ids) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) {
      throw new Error('合集排序无效');
    }
    const db = await openDB();
    const transaction = db.transaction(COLLECTIONS, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(COLLECTIONS);
    let invalid = false;
    const request = store.getAll();
    request.onsuccess = () => {
      const collections = new Map(request.result.map(item => [item.id, item]));
      if (collections.size !== ids.length || ids.some(id => !collections.has(id))) {
        invalid = true;
        transaction.abort();
        return;
      }
      ids.forEach((id, order) => store.put({ ...collections.get(id), order }));
    };
    try {
      await done;
    } catch (error) {
      if (invalid) throw new Error('合集列表已变化，请刷新后重新排序');
      throw error;
    }
  }

  async function createCollection(name) {
    name = String(name || '').trim();
    if (!name || name.length > 80) throw new Error('合集名称须为 1–80 个字符');
    const db = await openDB();
    const transaction = db.transaction(COLLECTIONS, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(COLLECTIONS);
    let collection;
    const request = store.getAll();
    request.onsuccess = () => {
      if (request.result.some(item => item.name === name)) return;
      const existing = sortCollections(request.result);
      existing.forEach((item, order) => {
        if (item.order !== order) store.put({ ...item, order });
      });
      const id = 'book-' + Array.from(crypto.getRandomValues(new Uint32Array(4)),
        value => value.toString(16).padStart(8, '0')).join('');
      collection = { id, name, createdAt: Date.now(), order: existing.length };
      store.add(collection);
    };
    await done;
    if (!collection) throw new Error('已存在同名合集，请直接切换');
    return collection;
  }

  function makeId(book, filename) {
    return `${book}/${filename}`;
  }

  /** 写入 / 覆盖一课资源。record 需含 book、filename；可含 title、audioBlob、lrcText。 */
  async function putLesson(record) {
    if (!record || !record.book || !record.filename) {
      throw new Error('putLesson 需要 book 与 filename');
    }
    const db = await openDB();
    const transaction = db.transaction([STORE, COLLECTIONS], 'readwrite');
    const store = transaction.objectStore(STORE);
    const full = Object.assign(
      { id: makeId(record.book, record.filename), importedAt: Date.now() },
      record
    );
    const done = transactionDone(transaction);
    let missingCollection = false;
    const request = transaction.objectStore(COLLECTIONS).get(record.book);
    request.onsuccess = () => {
      if (!request.result) {
        missingCollection = true;
        transaction.abort();
        return;
      }
      store.put(full);
    };
    try {
      await done;
    } catch (error) {
      if (missingCollection) throw new Error('请先创建并选择合集');
      throw error;
    }
    return full.id;
  }

  /** 读取一课（含 Blob 与 lrcText）。找不到返回 null。 */
  async function getLesson(book, filename) {
    const store = await tx('readonly');
    const rec = await reqToPromise(store.get(makeId(book, filename)));
    return rec || null;
  }

  async function updateLessonLrc(book, filename, expectedText, lrcText) {
    if (typeof expectedText !== 'string' || typeof lrcText !== 'string') {
      throw new Error('字幕内容无效');
    }
    const db = await openDB();
    const transaction = db.transaction(STORE, 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE);
    let conflict;
    const request = store.get(makeId(book, filename));
    request.onsuccess = () => {
      const record = request.result;
      if (!record || record.lrcText !== expectedText) {
        conflict = new Error(record ? '字幕已在其他页面更新，请刷新后重新编辑' : '课程已删除，无法保存句子');
        transaction.abort();
        return;
      }
      store.put({ ...record, lrcText });
    };
    try {
      await done;
    } catch (error) {
      throw conflict || error;
    }
  }

  /** 是否已导入某课。 */
  async function hasLesson(book, filename) {
    const store = await tx('readonly');
    const key = await reqToPromise(store.getKey(makeId(book, filename)));
    return key != null;
  }

  /**
   * 列出已导入课程的轻量元信息（不含 Blob，避免一次性载入大量音频）。
   * 返回 [{ id, book, filename, title, importedAt, hasAudio, hasLrc }]。
   * 可传 book 过滤。
   */
  async function listLessons(book) {
    const store = await tx('readonly');
    const all = await reqToPromise(book ? store.index('book').getAll(book) : store.getAll());
    return all
      .filter((r) => !book || r.book === book)
      .map((r) => ({
        id: r.id,
        book: r.book,
        filename: r.filename,
        title: r.title || '',
        importedAt: r.importedAt || 0,
        hasAudio: !!r.audioBlob,
        hasLrc: !!r.lrcText
      }));
  }

  async function listLrcFiles(book) {
    if (!book) throw new Error('请选择需要导出的合集');
    const store = await tx('readonly');
    const records = await reqToPromise(store.index('book').getAll(book));
    return records
      .filter(record => record.book === book && typeof record.lrcText === 'string')
      .map(record => ({
        filename: record.lrcFilename || `${record.filename}.lrc`,
        lrcText: record.lrcText
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename, 'zh-Hans-CN', { numeric: true }));
  }

  /** 已导入课程总数。 */
  async function count() {
    const store = await tx('readonly');
    return await reqToPromise(store.count());
  }

  async function deleteLesson(book, filename) {
    if (!book || !filename) throw new Error('请选择需要删除的课程');
    const store = await tx('readwrite');
    const done = transactionDone(store.transaction);
    store.delete(makeId(book, filename));
    await done;
  }

  async function clearAll() {
    const store = await tx('readwrite');
    const done = transactionDone(store.transaction);
    store.clear();
    await done;
  }

  async function deleteCollection(book) {
    if (!book) throw new Error('请选择需要清理的合集');
    const db = await openDB();
    const transaction = db.transaction([STORE, COLLECTIONS], 'readwrite');
    const store = transaction.objectStore(STORE);
    const done = transactionDone(transaction);
    transaction.objectStore(COLLECTIONS).delete(book);
    const request = store.index('book').openCursor(book);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await done;
  }

  window.NCE_RESOURCES = {
    putLesson,
    getLesson,
    updateLessonLrc,
    hasLesson,
    listLessons,
    listLrcFiles,
    count,
    deleteLesson,
    clearAll,
    deleteCollection,
    listCollections,
    reorderCollections,
    createCollection,
    makeId
  };
})();
