/**
 * EchoFlow · utils.js · Shared utilities
 * UMD: browser exposes window.NCEUtils, Node.js uses module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NCEUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── lesson.js helpers ──

  function timeTagsToSeconds(tags) {
    var m = /\[(\d+):(\d+(?:\.\d+)?)\]/.exec(tags);
    if (!m) return 0;
    return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  }

  function hasCJK(s) {
    return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(s);
  }

  function parseLrcText(text) {
    const lineRE = /^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/;
    const metaRE = /^\[(al|ar|ti|by):(.+)\]$/i;
    const rows = text.replace(/\r/g, '').split('\n');
    const meta = { al: '', ar: '', ti: '', by: '' };
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i].trim(); if (!raw) continue;
      const mm = raw.match(metaRE); if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }
      const m = raw.match(lineRE); if (!m) continue;
      const rowStart = i;
      const tags = m[1];
      const start = timeTagsToSeconds(tags);
      const body = m[2].trim();
      let en = body, cn = '';
      if (body.includes('|')) { const parts = body.split('|'); en = parts[0].trim(); cn = (parts[1] || '').trim(); }
      else if (i + 1 < rows.length) {
        const m2 = rows[i + 1].trim().match(lineRE);
        if (m2 && m2[1] === tags) {
          const text2 = m2[2].trim();
          if (hasCJK(text2)) { cn = text2; i++; }
        }
      }
      items.push({ start, en, cn, rowStart, rowEnd: i, tags });
    }
    for (let i = 0; i < items.length; i++) items[i].end = i + 1 < items.length ? items[i + 1].start : 0;
    return { meta, items };
  }

  var KEY_DISPLAY_NAMES = {
    ' ': 'Space',
    'Spacebar': 'Space',
    'ArrowUp': '↑',
    'ArrowDown': '↓',
    'ArrowLeft': '←',
    'ArrowRight': '→',
    'Enter': '↵',
    'Escape': 'Esc',
    'Backspace': '⌫',
    'Tab': 'Tab',
    'Delete': 'Del'
  };

  function getKeyDisplayName(key) {
    if (!key) return '?';
    var combination = /^(Ctrl|Alt|Shift|Meta)\+(.+)$/.exec(key);
    if (combination) return combination[1] + '+' + getKeyDisplayName(combination[2]);
    if (KEY_DISPLAY_NAMES[key]) return KEY_DISPLAY_NAMES[key];
    if (key.length === 1) return key.toUpperCase();
    return key;
  }

  function getShortcutKey(event) {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null;
    return (event.ctrlKey ? 'Ctrl+' : '') +
      (event.altKey ? 'Alt+' : '') +
      (event.shiftKey ? 'Shift+' : '') +
      (event.metaKey ? 'Meta+' : '') + event.key;
  }

  function findConflict(shortcuts, action, newKey) {
    var normalizedNew = newKey.toLowerCase();
    for (var act in shortcuts) {
      if (shortcuts.hasOwnProperty(act) && act !== action && shortcuts[act].key.toLowerCase() === normalizedNew) {
        return act;
      }
    }
    return null;
  }

  var SHORTCUTS_KEY = 'nce_shortcuts';
  var DEFAULT_SHORTCUTS = {
    playPause: { key: ' ', label: '播放 / 暂停', group: '播放控制' },
    replay: { key: 'r', label: '重播当前句', group: '播放控制' },
    prevSentence: { key: 'ArrowLeft', label: '上一句', group: '句子导航' },
    nextSentence: { key: 'ArrowRight', label: '下一句', group: '句子导航' },
    prevLesson: { key: 'Ctrl+ArrowLeft', label: '上一课', group: '课程导航' },
    nextLesson: { key: 'Ctrl+ArrowRight', label: '下一课', group: '课程导航' },
    volumeUp: { key: 'ArrowUp', label: '增加音量', group: '音量控制' },
    volumeDown: { key: 'ArrowDown', label: '减少音量', group: '音量控制' },
    toggleReveal: { key: 'v', label: '显示/隐藏当前句', group: '听读模式' },
    editSentence: { key: 'e', label: '编辑当前句', group: '句子导航' }
  };

  function loadCustomShortcuts(storage) {
    try {
      var saved = storage.getItem(SHORTCUTS_KEY);
      if (saved) {
        var parsed = JSON.parse(saved);
        var result = JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
        for (var action of Object.keys(result)) {
          if (typeof parsed[action] === 'string' && parsed[action]) result[action].key = parsed[action];
        }
        for (var name of Object.keys(result)) {
          if (findConflict(result, name, result[name].key)) {
            console.warn('已保存的快捷键与新默认键位冲突，已恢复默认快捷键');
            return JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
          }
        }
        return result;
      }
    } catch (error) {
      console.warn('无法加载快捷键配置，使用默认快捷键', error);
    }
    return JSON.parse(JSON.stringify(DEFAULT_SHORTCUTS));
  }

  function matchesShortcut(event, action, shortcuts) {
    var key = shortcuts[action]?.key;
    return !!key && getShortcutKey(event)?.toLowerCase() === key.toLowerCase();
  }

  function loadPlaybackVolume(storage) {
    try {
      var saved = storage.getItem('nce_volume');
      if (saved !== null) {
        var volume = Number(saved);
        if (saved.trim() && Number.isFinite(volume) && volume >= 0 && volume <= 1) return volume;
        console.warn('已保存的音量无效，使用默认音量');
      }
    } catch (error) {
      console.warn('无法恢复音量设置', error);
    }
    return 1;
  }

  function createVolumeToast(doc) {
    var timer = 0;
    return function (volume) {
      var toast = doc.getElementById('volumeToast');
      if (!toast) {
        toast = doc.createElement('div');
        toast.id = 'volumeToast';
        toast.style.cssText = `
          position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
          background: var(--surface); color: var(--text); border: 1px solid var(--border);
          border-radius: var(--radius); padding: 20px 30px; box-shadow: var(--shadow);
          z-index: 2000; backdrop-filter: saturate(120%) blur(10px);
          font-size: 18px; font-weight: 500; min-width: 120px; text-align: center;
          opacity: 0; transition: opacity 0.2s ease;
        `;
        toast.setAttribute('role', 'status');
        doc.body.appendChild(toast);
      }
      toast.textContent = `音量 ${Math.round(volume * 100)}%`;
      toast.style.opacity = '1';
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { toast.style.opacity = '0'; }, 1000);
    };
  }

  function normalizeShadowRepeat(value) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return 2;
    return Math.min(9, Math.max(1, n));
  }

  function normalizeAutoStopCount(value) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return 3;
    return Math.min(50, Math.max(1, n));
  }

  function shouldSkipLine(item, index, opts) {
    opts = opts || {};
    var en = item.en.trim();
    var cn = item.cn ? item.cn.trim() : '';
    var skipQuestions = !!opts.skipQuestions;
    if (!en) return true;

    if (/^Lesson\s+\d+$/i.test(en) && /^第\d+课$/.test(cn)) {
      return true;
    }

    if (/Listen to the tape/i.test(en)) {
      return true;
    }

    if (cn && en.length < 80 && cn.length < 80) {
      if (item.start < 7) {
        return true;
      }
      if (item.start < 10 && !en.endsWith('?')) {
        return true;
      }
    }

    var isQuestion = en.endsWith('?') || cn.endsWith('？');
    if (skipQuestions && isQuestion && item.start < 20 && index < 6) {
      return true;
    }

    return false;
  }

  function findFirstContentIndex(items, opts) {
    opts = opts || {};
    if (!items || items.length === 0) return 0;

    var checkLimit = Math.min(10, items.length);
    var skipCount = 0;

    for (var i = 0; i < checkLimit; i++) {
      if (shouldSkipLine(items[i], i, opts)) {
        skipCount++;
      } else {
        if (skipCount > 0) {
          return i;
        } else {
          return 0;
        }
      }
    }

    return 0;
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00.000';
    var totalMs = Math.round(seconds * 1000);
    var mins = Math.floor(totalMs / 60000);
    var secs = Math.floor(totalMs / 1000) % 60;
    var ms = totalMs % 1000;
    return mins + ':' + String(secs).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
  }

  function countWords(text) {
    if (!text) return 0;
    var parts = text.trim().split(/\s+/).filter(Boolean);
    return parts.length;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function seekLooksOk(target, actual, eps) {
    eps = eps || 0.25;
    if (!Number.isFinite(target) || target <= 0.5) return true;
    return Math.abs((actual || 0) - target) <= eps;
  }

  // ── favorites.js helpers ──

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function clampRate(v) {
    if (v == null || (typeof v === 'string' && !v.trim())) return 1.0;
    var n = Number(v);
    if (!Number.isFinite(n)) return 1.0;
    return Math.max(0.5, Math.min(2.5, n));
  }

  function normalizeLoop(v) {
    return (v === 'off' || v === 'one' || v === 'all') ? v : 'off';
  }

  function rateLabel(r) {
    var s = (Math.round(r * 100) % 25 === 0) ? String(r) : r.toFixed(2);
    return s + 'x';
  }

  function loopLabel(mode) {
    if (mode === 'one') return '循环：单句';
    if (mode === 'all') return '循环：当前分类';
    return '循环：关';
  }

  var NOVELTY_VOICE_RE = /\b(bad news|good news|bahh|bells|boing|bubbles|cellos|jester|junior|whisper|trinoids?)\b/i;

  function isNoveltyVoiceName(name) {
    var n = String(name || '').trim();
    if (!n) return false;
    return NOVELTY_VOICE_RE.test(n);
  }

  var PREFERRED_VOICE_NAMES = [
    'Siri', 'Samantha', 'Alex', 'Daniel', 'Karen',
    'Tessa', 'Moira', 'Oliver', 'Arthur', 'Aaron',
    'Allison', 'Ava'
  ];

  function preferredVoiceBonus(name) {
    var n = String(name || '');
    var idx = PREFERRED_VOICE_NAMES.findIndex(function (k) {
      return k && (n === k || n.startsWith(k + ' '));
    });
    return idx >= 0 ? (220 - idx * 10) : 0;
  }

  function voiceScore(v, opts) {
    opts = opts || {};
    var preferredLangPrefix = opts.preferredLangPrefix || 'en';
    if (!v) return -1e9;
    var name = String(v.name || '');
    var lang = String(v.lang || '').toLowerCase();
    var s = 0;
    if (lang.startsWith(preferredLangPrefix)) s += 120;
    else if (preferredLangPrefix === 'en' && lang.startsWith('en')) s += 120;
    if (v.localService) s += 30;
    if (v.default) s += 20;
    s += preferredVoiceBonus(name);
    if (isNoveltyVoiceName(name)) s -= 1000;
    return s;
  }

  // ── search.js helpers ──

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlightText(text, query) {
    if (!query) return text;
    var regex = new RegExp('(' + escapeRegExp(query) + ')', 'gi');
    return text.replace(regex, '<span class="search-highlight">$1</span>');
  }

  // ── Public API ──

  return {
    timeTagsToSeconds: timeTagsToSeconds,
    hasCJK: hasCJK,
    parseLrcText: parseLrcText,
    KEY_DISPLAY_NAMES: KEY_DISPLAY_NAMES,
    getKeyDisplayName: getKeyDisplayName,
    getShortcutKey: getShortcutKey,
    findConflict: findConflict,
    SHORTCUTS_KEY: SHORTCUTS_KEY,
    DEFAULT_SHORTCUTS: DEFAULT_SHORTCUTS,
    loadCustomShortcuts: loadCustomShortcuts,
    matchesShortcut: matchesShortcut,
    loadPlaybackVolume: loadPlaybackVolume,
    createVolumeToast: createVolumeToast,
    normalizeShadowRepeat: normalizeShadowRepeat,
    normalizeAutoStopCount: normalizeAutoStopCount,
    shouldSkipLine: shouldSkipLine,
    findFirstContentIndex: findFirstContentIndex,
    formatTime: formatTime,
    countWords: countWords,
    clamp: clamp,
    seekLooksOk: seekLooksOk,
    escapeHTML: escapeHTML,
    clampRate: clampRate,
    normalizeLoop: normalizeLoop,
    rateLabel: rateLabel,
    loopLabel: loopLabel,
    NOVELTY_VOICE_RE: NOVELTY_VOICE_RE,
    PREFERRED_VOICE_NAMES: PREFERRED_VOICE_NAMES,
    isNoveltyVoiceName: isNoveltyVoiceName,
    preferredVoiceBonus: preferredVoiceBonus,
    voiceScore: voiceScore,
    escapeRegExp: escapeRegExp,
    highlightText: highlightText
  };
});
