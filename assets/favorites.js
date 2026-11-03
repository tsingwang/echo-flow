(() => {
  const {
    escapeHTML, clampRate, normalizeLoop, rateLabel, loopLabel, parseLrcText,
    loadCustomShortcuts, matchesShortcut, getKeyDisplayName, SHORTCUTS_KEY,
    loadPlaybackVolume, createVolumeToast, clamp,
    isNoveltyVoiceName, voiceScore, NOVELTY_VOICE_RE, PREFERRED_VOICE_NAMES
  } = NCEUtils;

  const SENTENCE_FAV_KEY = 'nce_sentence_favs_v1';
  const TTS_RATE_KEY = 'nce_tts_rate';
  const TTS_LOOP_KEY = 'nce_tts_loop'; // 'off' | 'one' | 'all'
  const TTS_VOICE_KEY = 'nce_tts_voice';

  function qs(sel) { return document.querySelector(sel); }
  function supportsTTS() {
    return typeof window !== 'undefined'
      && 'speechSynthesis' in window
      && typeof window.SpeechSynthesisUtterance === 'function';
  }

  function loadFavs() {
    try {
      const raw = localStorage.getItem(SENTENCE_FAV_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.filter(x => x && typeof x.id === 'string' && typeof x.en === 'string');
    } catch (_) { return []; }
  }
  function saveFavs(arr) {
    localStorage.setItem(SENTENCE_FAV_KEY, JSON.stringify(arr || []));
  }

  document.addEventListener('DOMContentLoaded', () => {
    const favSub = qs('#favSub');
    const listEl = qs('#favSentences');
    const collectionBar = qs('#favoriteCollectionBar');
    const collectionTabs = qs('#favoriteCollectionTabs');
    const collectionStatus = qs('#favoriteCollectionStatus');
    const audio = qs('#favoriteAudio');

    const ttsSettingsBtn = qs('#ttsSettingsBtn');
    const ttsPrev = qs('#ttsPrev');
    const ttsPlayPause = qs('#ttsPlayPause');
    const ttsNext = qs('#ttsNext');
    const ttsOverlay = qs('#ttsOverlay');
    const ttsPanel = qs('#ttsPanel');
    const ttsClose = qs('#ttsClose');
    const ttsVoiceSelect = qs('#ttsVoice');
    const ttsLoopSelect = qs('#ttsLoopSelect');
    const ttsRateSelect = qs('#ttsRateSelect');
    const clearListBtn = qs('#clearListBtn');
    const clearListDescription = qs('#clearListDescription');
    const favDataExportBtn = qs('#favDataExportBtn');
    const favDataImportBtn = qs('#favDataImportBtn');
    const favDataImportFile = qs('#favDataImportFile');

    // --------------------------
    // 移动端浏览器：自动隐藏上下栏（非 PWA）
    // --------------------------
    (function initAutoHideBars(){
      try {
        const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator && window.navigator.standalone === true);
        const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        if (isStandalone || !isCoarse) return;
        const body = document.body;
        if (!body) return;

        let hidden = false;
        let lastY = window.scrollY || 0;
        let idleTimer = 0;
        const HIDE_CLASS = 'ui-bars-hidden';

        const isPanelOpen = () => {
          const ttsOpen = ttsPanel && !ttsPanel.hasAttribute('hidden');
          return ttsOpen;
        };

        const show = () => {
          if (hidden) { body.classList.remove(HIDE_CLASS); hidden = false; }
          resetIdle();
        };
        const hide = () => {
          if (isPanelOpen()) return;
          const y = window.scrollY || 0;
          if (y < 40) return;
          if (!hidden) { body.classList.add(HIDE_CLASS); hidden = true; }
        };
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => hide(), 2200);
        };
        const onScroll = () => {
          const y = window.scrollY || 0;
          const dy = y - lastY;
          if (Math.abs(dy) < 8) { resetIdle(); lastY = y; return; }
          if (dy > 0) hide(); else show();
          lastY = y;
        };

        window.addEventListener('scroll', onScroll, { passive: true });
        ['touchstart','pointerdown'].forEach(t => document.addEventListener(t, show, { passive: true }));
        document.addEventListener('focusin', show, { passive: true });
        resetIdle();
      } catch (_) {}
    })();

    let allFavs = loadFavs();
    let favs = allFavs.slice();
    let currentIndex = favs.length ? 0 : -1;
    let collections = [];
    let collectionFiltersReady = false;
    let selectedCollection = 'all';
    const lessonAvailability = new Map();

    function favoriteLessonId(item) {
      if (typeof item.lessonId === 'string' && item.lessonId) return item.lessonId;
      if (typeof item.book === 'string' && typeof item.base === 'string' && item.book && item.base) {
        return `${item.book}/${item.base}`;
      }
      const lessonId = item.id.split('::')[0];
      return lessonId.includes('/') ? lessonId : '';
    }

    function favoriteBook(item) {
      if (typeof item.book === 'string' && item.book) return item.book;
      const lessonId = favoriteLessonId(item);
      const slash = lessonId.indexOf('/');
      return slash > 0 ? lessonId.slice(0, slash) : '';
    }

    function sourceMissing(item) {
      const lessonId = favoriteLessonId(item);
      return !lessonId || lessonAvailability.get(lessonId) === false;
    }

    function setLessonAvailable(lessonId, available) {
      lessonAvailability.set(lessonId, available);
      favs.forEach((item, index) => {
        if (favoriteLessonId(item) !== lessonId) return;
        const button = listEl?.querySelector(`.fav-item[data-i="${index}"] [data-action="jump"]`);
        if (!button) return;
        button.disabled = !available;
        const label = available ? '原文' : '缺失';
        button.setAttribute('aria-label', available ? '回到原文' : label);
        button.setAttribute('title', available ? '回到原文' : label);
        const text = button.querySelector('.source-link-label');
        if (text) text.textContent = label;
      });
    }

    function filteredFavorites() {
      if (selectedCollection === 'all') return allFavs.slice();
      const known = new Set(collections.map(collection => collection.id));
      return allFavs.filter(item => selectedCollection === 'deleted'
        ? !known.has(favoriteBook(item))
        : favoriteBook(item) === selectedCollection);
    }

    function renderCollectionFilters() {
      if (!collectionFiltersReady) return;
      const counts = new Map();
      allFavs.forEach(item => {
        const book = favoriteBook(item);
        counts.set(book, (counts.get(book) || 0) + 1);
      });
      const filters = [{ id: 'all', name: `全部 (${allFavs.length})` }];
      const known = new Set(collections.map(collection => collection.id));
      collections.forEach(collection => {
        filters.push({ id: collection.id, name: `${collection.name} (${counts.get(collection.id) || 0})` });
      });
      const deletedCount = allFavs.filter(item => !known.has(favoriteBook(item))).length;
      if (deletedCount || selectedCollection === 'deleted') {
        filters.push({ id: 'deleted', name: `已删除合集 (${deletedCount})` });
      }
      if (!filters.some(filter => filter.id === selectedCollection)) selectedCollection = 'all';
      NCE_COLLECTIONS.renderTabs(collectionTabs, filters, selectedCollection, false, { reorderable: false });
    }

    function collectionScopeLabel() {
      if (selectedCollection === 'all') return '全部收藏';
      if (selectedCollection === 'deleted') return '已删除合集的收藏';
      const collection = collections.find(item => item.id === selectedCollection);
      return `合集「${collection.name}」的收藏`;
    }

    function selectCollection(id) {
      if (id === selectedCollection) return;
      stopPlayback();
      selectedCollection = id;
      renderCollectionFilters();
      favs = filteredFavorites();
      currentIndex = favs.length ? 0 : -1;
      setSubtitle();
      renderList();
      updateTtsPos();
    }

    // 原音频和 TTS 共用播放状态及取消序号。
    const synth = supportsTTS() ? window.speechSynthesis : null;
    const RATE_OPTIONS = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.5, 1.75, 2.0];
    let playbackState = 'stopped'; // 'stopped' | 'loading' | 'playing' | 'paused'
    let playbackSeq = 0;
    let playbackKind = '';
    let audioUrl = '';
    let audioSourceKey = '';
    let segmentEnd = 0;
    let segmentTimer = 0;
    let cancelAudioWait = null;
    let ttsVoices = [];
    let ttsVoiceName = '';
    let ttsVoice = null;
    let ttsRate = 1.0;
    let ttsLoop = 'off';
    let pendingUtterance = null;
    let currentShortcuts = loadCustomShortcuts(localStorage);
    let playbackVolume = loadPlaybackVolume(localStorage);
    const showVolumeToast = createVolumeToast(document);
    if (audio) audio.volume = playbackVolume;

    function updateShortcutHints() {
      for (const [button, action, label] of [
        [ttsPrev, 'prevSentence', '上一句'],
        [ttsNext, 'nextSentence', '下一句'],
        [ttsPlayPause, 'playPause', '播放/暂停']
      ]) {
        if (!button) continue;
        const key = currentShortcuts[action].key;
        button.setAttribute('title', `${label}（${getKeyDisplayName(key)}）`);
        button.setAttribute('aria-keyshortcuts', key.replace(/^Ctrl\+/, 'Control+').replace(/ $/, 'Space'));
      }
    }

    function applyVolume(volume) {
      playbackVolume = volume;
      if (audio) audio.volume = volume;
      if (playbackKind === 'tts' && ['playing', 'paused'].includes(playbackState)) restartSpeech();
    }

    function changeVolume(delta) {
      const volume = clamp(Math.round((playbackVolume + delta) * 100) / 100, 0, 1);
      if (volume !== playbackVolume) applyVolume(volume);
      try { localStorage.setItem('nce_volume', String(volume)); }
      catch (error) { console.warn('无法保存音量设置', error); }
      showVolumeToast(volume);
    }

    function syncPlaybackSettings() {
      currentShortcuts = loadCustomShortcuts(localStorage);
      updateShortcutHints();
      const volume = loadPlaybackVolume(localStorage);
      if (volume !== playbackVolume) applyVolume(volume);
    }

    function showNotification(message) {
      const n = document.createElement('div');
      n.style.cssText = `
        position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
        background: var(--surface); color: var(--text); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 12px 20px; box-shadow: var(--shadow);
        z-index: 1000; backdrop-filter: saturate(120%) blur(10px); animation: slideDown 0.3s ease-out;
      `;
      n.textContent = message; document.body.appendChild(n);
      setTimeout(()=>{ n.style.animation='slideUp 0.3s ease-out'; setTimeout(()=>{ document.body.removeChild(n); },300); },2000);
    }

    function setPlayIcon(isPlaying) {
      const playIcon = ttsPlayPause?.querySelector('.play-icon');
      const pauseIcon = ttsPlayPause?.querySelector('.pause-icon');
      if (playIcon) playIcon.style.display = isPlaying ? 'none' : '';
      if (pauseIcon) pauseIcon.style.display = isPlaying ? '' : 'none';
      if (ttsPlayPause) ttsPlayPause.setAttribute('aria-label', isPlaying ? '暂停' : '播放');
    }
    function setPlaybackState(state) {
      playbackState = state;
      setPlayIcon(state === 'playing' || state === 'loading');
      ttsPlayPause?.setAttribute('aria-busy', String(state === 'loading'));
    }

    function pickDefaultVoice(voices, { preferredLangPrefix = 'en' } = {}) {
      if (!voices?.length) return null;
      if (ttsVoiceName) {
        const found = voices.find(v => v && v.name === ttsVoiceName);
        if (found) return found;
      }
      let best = null;
      let bestScore = -1e9;
      for (const v of voices) {
        const s = voiceScore(v, { preferredLangPrefix });
        if (s > bestScore) { bestScore = s; best = v; }
      }
      return best || voices[0] || null;
    }

    function refreshVoiceSelect() {
      if (!ttsVoiceSelect) return;
      if (!supportsTTS()) {
        ttsVoiceSelect.innerHTML = `<option value="">当前浏览器不支持朗读</option>`;
        ttsVoiceSelect.disabled = true;
        return;
      }
      ttsVoices = synth.getVoices() || [];
      if (!ttsVoices.length) {
        ttsVoiceSelect.innerHTML = `<option value="">正在加载音色…</option>`;
        ttsVoiceSelect.disabled = true;
        return;
      }
      ttsVoiceSelect.disabled = false;

      // 如果之前保存的是“搞怪音色”，自动回退为推荐音色
      if (ttsVoiceName && isNoveltyVoiceName(ttsVoiceName)) {
        ttsVoiceName = '';
        try { localStorage.removeItem(TTS_VOICE_KEY); } catch (_) {}
      }

      const preferredLangPrefix = 'en';
      const sorted = ttsVoices.slice().sort((a, b) => {
        const sa = voiceScore(a, { preferredLangPrefix });
        const sb = voiceScore(b, { preferredLangPrefix });
        if (sb !== sa) return sb - sa;
        return String(a?.name || '').localeCompare(String(b?.name || ''));
      });

      const selected = pickDefaultVoice(sorted, { preferredLangPrefix });
      if (selected) {
        ttsVoice = selected;
        // 默认音色不自动写入 localStorage，避免在不同设备上“锁定”怪异默认值
        if (!ttsVoiceName) ttsVoiceName = selected.name;
      }

      ttsVoiceSelect.innerHTML = sorted.map(v => {
        const name = escapeHTML(v.name || '');
        const lang = escapeHTML(v.lang || '');
        return `<option value="${name}">${name}${lang ? ` (${lang})` : ''}</option>`;
      }).join('');
      if (ttsVoiceName) ttsVoiceSelect.value = ttsVoiceName;
      if (!ttsVoiceSelect.value && sorted[0]) {
        ttsVoiceName = sorted[0].name;
        ttsVoiceSelect.value = ttsVoiceName;
        ttsVoice = sorted[0];
      } else {
        ttsVoice = sorted.find(v => v.name === ttsVoiceSelect.value) || ttsVoice;
      }
    }

    function clearSegmentTimer() {
      if (segmentTimer) clearTimeout(segmentTimer);
      segmentTimer = 0;
    }

    function releaseAudioSource() {
      if (!audioUrl) return;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(audioUrl);
      audioUrl = '';
      audioSourceKey = '';
    }

    function stopPlayback() {
      playbackSeq++;
      playbackKind = '';
      pendingUtterance = null;
      if (cancelAudioWait) cancelAudioWait();
      clearSegmentTimer();
      audio?.pause();
      if (synth) synth.cancel();
      setPlaybackState('stopped');
    }

    function finishPlayback(seq, index, scroll = true) {
      if (seq !== playbackSeq) return;
      stopPlayback();
      if (ttsLoop === 'one') playIndex(index, { scroll });
      else if (ttsLoop === 'all' && favs.length) playIndex((index + 1) % favs.length, { scroll });
    }

    function checkAudioBoundary() {
      if (playbackKind !== 'audio' || playbackState !== 'playing') return false;
      if (audio.currentTime < segmentEnd && !audio.ended) return false;
      finishPlayback(playbackSeq, currentIndex);
      return true;
    }

    function scheduleAudioBoundary() {
      clearSegmentTimer();
      if (playbackKind !== 'audio' || playbackState !== 'playing') return;
      if (checkAudioBoundary()) return;
      if (audio.paused) return;
      const seq = playbackSeq;
      segmentTimer = setTimeout(() => {
        segmentTimer = 0;
        if (seq === playbackSeq) scheduleAudioBoundary();
      }, Math.max(10, (segmentEnd - audio.currentTime) / audio.playbackRate * 1000));
    }

    function waitForAudio(event, action, ready) {
      return new Promise((resolve, reject) => {
        let timer = 0;
        const cleanup = () => {
          audio.removeEventListener(event, done);
          audio.removeEventListener('error', failed);
          clearTimeout(timer);
          cancelAudioWait = null;
        };
        const done = () => { if (ready()) { cleanup(); resolve(true); } };
        const failed = () => { cleanup(); reject(new Error('原音频无法加载或解码')); };
        cancelAudioWait = () => { cleanup(); resolve(false); };
        audio.addEventListener(event, done);
        audio.addEventListener('error', failed);
        timer = setTimeout(() => { cleanup(); reject(new Error('原音频加载或定位超时')); }, 10000);
        try { action(); done(); }
        catch (error) { cleanup(); reject(error); }
      });
    }

    function reportPlaybackError(seq, error) {
      if (seq !== playbackSeq) return;
      console.error('收藏播放失败', error);
      stopPlayback();
      showNotification('播放失败：' + (error.message || error));
    }

    function startTts(index, { scroll = true } = {}, seq) {
      if (seq !== playbackSeq) return;
      playbackKind = '';
      clearSegmentTimer();
      audio?.pause();
      releaseAudioSource();
      if (!supportsTTS()) {
        setPlaybackState('stopped');
        showNotification('当前浏览器不支持语音朗读');
        return;
      }
      const it = favs[index];
      const text = String((it?.en || it?.cn || '')).trim();
      if (!text) { reportPlaybackError(seq, new Error('当前句子为空')); return; }
      playbackKind = 'tts';
      setPlaybackState('playing');

      const u = new SpeechSynthesisUtterance(text);
      u.rate = ttsRate;
      u.volume = playbackVolume;
      if (ttsVoice) u.voice = ttsVoice;
      u.onend = () => finishPlayback(seq, index, scroll);
      u.onerror = event => reportPlaybackError(seq, new Error('语音朗读失败：' + (event.error || '未知错误')));
      pendingUtterance = u;

      // iOS/Safari 上 cancel 后立即 speak 偶发失效，延迟一帧更稳
      setTimeout(() => {
        if (seq !== playbackSeq || playbackState !== 'playing' || pendingUtterance !== u) return;
        pendingUtterance = null;
        try { synth.resume(); synth.speak(u); } catch (error) { reportPlaybackError(seq, error); }
      }, 0);
    }

    function restartSpeech() {
      const paused = playbackState === 'paused';
      stopPlayback();
      startTts(currentIndex, {}, playbackSeq);
      if (paused && playbackKind === 'tts') setPlaybackState('paused');
    }

    async function playIndex(i, { scroll = true } = {}) {
      if (!favs.length) return;
      stopPlayback();
      const next = Math.max(0, Math.min(favs.length - 1, i | 0));
      setCurrent(next, { scroll });
      const seq = playbackSeq;
      setPlaybackState('loading');
      try {
        const item = favs[next];
        const lessonId = favoriteLessonId(item);
        const slash = lessonId.indexOf('/');
        if (slash < 1 || slash === lessonId.length - 1) {
          startTts(next, { scroll }, seq);
          return;
        }
        const record = await NCE_RESOURCES.getLesson(lessonId.slice(0, slash), lessonId.slice(slash + 1));
        if (seq !== playbackSeq) return;
        const available = !!(record?.audioBlob && record.lrcText);
        setLessonAvailable(lessonId, available);
        if (!available) {
          startTts(next, { scroll }, seq);
          return;
        }
        if (!audio) throw new Error('原音频播放器不可用');
        const { items } = parseLrcText(record.lrcText);
        const idIndex = /::(\d+)$/.exec(item.id);
        const index = Number.isInteger(item.idx) ? item.idx : (idIndex ? Number(idIndex[1]) : -1);
        const sentence = items[index];
        if (!sentence) throw new Error('原字幕中找不到这句收藏');
        if (!Number.isFinite(sentence.start) || sentence.start < 0 ||
          (index + 1 < items.length && (!Number.isFinite(sentence.end) || sentence.end <= sentence.start))) {
          throw new Error('原字幕的句子时间无效');
        }

        playbackKind = 'audio';
        const sourceKey = JSON.stringify([lessonId, record.importedAt, record.audioBlob.size, record.audioBlob.type]);
        const newSource = audioSourceKey !== sourceKey;
        if (newSource) {
          releaseAudioSource();
          audioUrl = URL.createObjectURL(record.audioBlob);
          audioSourceKey = sourceKey;
        }
        if (newSource || audio.readyState < 1) {
          const loaded = await waitForAudio('loadedmetadata', () => {
            if (newSource) {
              audio.src = audioUrl;
              audio.load();
            }
          }, () => audio.readyState >= 1);
          if (!loaded || seq !== playbackSeq) return;
        }
        const duration = audio.duration;
        segmentEnd = index + 1 < items.length ? sentence.end : duration;
        if (!Number.isFinite(duration) || duration <= 0 || sentence.start >= duration ||
          !Number.isFinite(segmentEnd) || segmentEnd <= sentence.start || segmentEnd > duration) {
          throw new Error('原字幕时间超出音频范围');
        }
        const sought = await waitForAudio('seeked', () => {
          audio.currentTime = sentence.start;
        }, () => !audio.seeking && Math.abs(audio.currentTime - sentence.start) < 0.05);
        if (!sought || seq !== playbackSeq) return;
        audio.playbackRate = ttsRate;
        await audio.play();
        if (seq !== playbackSeq) return;
        setPlaybackState('playing');
        scheduleAudioBoundary();
      } catch (error) {
        if (seq !== playbackSeq) return;
        if (error.name === 'NotAllowedError' && playbackKind === 'audio') {
          setPlaybackState('paused');
          showNotification('原音频已就绪；浏览器阻止了自动播放，请点击播放重试。');
        } else {
          console.error('原音频不可用，改用语音朗读', error);
          showNotification('原音频播放失败，改用语音朗读：' + (error.message || error));
          startTts(next, { scroll }, seq);
        }
      }
    }

    if (audio) {
      audio.addEventListener('timeupdate', checkAudioBoundary);
      audio.addEventListener('ended', () => { if (audio.ended) checkAudioBoundary(); });
      audio.addEventListener('pause', () => {
        if (playbackKind === 'audio' && playbackState === 'playing' && !audio.ended) {
          clearSegmentTimer();
          setPlaybackState('paused');
        }
      });
      audio.addEventListener('error', () => {
        if (playbackKind !== 'audio' || playbackState === 'loading') return;
        if (playbackState === 'paused') reportPlaybackError(playbackSeq, new Error('原音频播放失败'));
        else {
          showNotification('原音频播放失败，改用语音朗读');
          startTts(currentIndex, {}, playbackSeq);
        }
      });
    }

    function setSubtitle() {
      favSub.textContent = selectedCollection === 'all'
        ? (allFavs.length ? `共收藏 ${allFavs.length} 句` : '')
        : `当前分类 ${favs.length} 句 · 共收藏 ${allFavs.length} 句`;
      if (clearListBtn) clearListBtn.disabled = !favs.length;
      if (clearListDescription) {
        clearListDescription.textContent = selectedCollection === 'all'
          ? `清空全部收藏（${favs.length} 句），包括所有合集。`
          : `仅清空${collectionScopeLabel()}（${favs.length} 句），其他分类不受影响。`;
      }
    }

    function updateTtsPos() {
      const ttsPos = qs('#ttsPos');
      if (!ttsPos) return;
      const pos = (currentIndex >= 0 && currentIndex < favs.length) ? `${currentIndex + 1}/${favs.length}` : `0/${favs.length || 0}`;
      ttsPos.textContent = pos;
    }

    function renderList() {
      if (!listEl) return;
      if (!favs.length) {
        listEl.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
              </svg>
            </div>
            <h3>${selectedCollection === 'all' ? '还没有收藏句子' : '当前分类还没有收藏句子'}</h3>
            <p>在学习课文时，点击句子旁的 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:text-bottom"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg> 即可加入收藏。<br>收藏后可在此进行循环播放、复读等强化训练。</p>
            <a href="index.html" class="empty-action-btn">去学习</a>
          </div>
        `;
        return;
      }

      listEl.innerHTML = favs.map((it, i) => {
        const meta = it.title || it.lessonId || '';
        const missing = sourceMissing(it);
        return `
          <div class="sentence fav-item ${i === currentIndex ? 'active' : ''}" data-i="${i}" data-id="${escapeHTML(it.id)}">
            <button class="sentence-fav-btn active" type="button" data-action="remove" data-id="${escapeHTML(it.id)}" aria-label="从收藏移除" aria-pressed="true">
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M8 12.027 3.297 14.5l.9-5.243L.1 5.997l5.258-.764L8 0l2.642 5.233 5.258.764-4.097 3.26.9 5.243L8 12.027Z"></path>
              </svg>
            </button>
            <div class="en">${escapeHTML(it.en)}</div>
            ${it.cn ? `<div class="cn">${escapeHTML(it.cn)}</div>` : ''}
            <div class="fav-actions" aria-label="操作">
              <button class="sentence-jump-btn" type="button" data-action="jump" data-i="${i}" aria-label="${missing ? '缺失' : '回到原文'}" title="${missing ? '缺失' : '回到原文'}"${missing ? ' disabled' : ''}>
                <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                  <path d="M11 3h6v6h-2V6.41l-7.29 7.3-1.42-1.42 7.3-7.29H11V3Z" fill="currentColor"></path>
                  <path d="M5 5h4V3H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4h-2v4H5V5Z" fill="currentColor"></path>
                </svg>
                <span class="source-link-label">${missing ? '缺失' : '原文'}</span>
              </button>
            </div>
            ${meta ? `<div class="fav-meta">${escapeHTML(meta)}</div>` : ''}
          </div>
        `;
      }).join('');
    }

    function setCurrent(i, { scroll = true } = {}) {
      if (!favs.length) { currentIndex = -1; updateTtsPos(); return; }
      const next = Math.max(0, Math.min(favs.length - 1, i | 0));
      const changed = next !== currentIndex;
      currentIndex = next;

      if (listEl) {
        if (changed) {
          const prevActive = listEl.querySelector('.fav-item.active');
          if (prevActive) prevActive.classList.remove('active');
        }
        const cur = listEl.querySelector(`.fav-item[data-i="${currentIndex}"]`);
        if (cur) {
          cur.classList.add('active');
          if (scroll) { try { cur.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {} }
        }
      }

      updateTtsPos();
    }

    function replaceFavorites(next) {
      const currentId = favs[currentIndex]?.id;
      try {
        saveFavs(next);
      } catch (error) {
        console.error('保存收藏失败', error);
        showNotification('保存收藏失败：' + (error.message || error));
        return false;
      }
      allFavs = next;
      stopPlayback();
      renderCollectionFilters();
      favs = filteredFavorites();
      const current = favs.findIndex(item => item.id === currentId);
      currentIndex = current >= 0 ? current : Math.min(currentIndex, favs.length - 1);
      setSubtitle();
      renderList();
      updateTtsPos();
      return true;
    }

    function removeById(id) {
      if (!id || !allFavs.some(item => item.id === id)) return;
      replaceFavorites(allFavs.filter(item => item.id !== id));
    }

    function jumpToSource(i) {
      const it = favs[i];
      if (!it) return;
      const lessonId = favoriteLessonId(it);
      if (!lessonId || sourceMissing(it)) return;

      try {
        const map = JSON.parse(localStorage.getItem('nce_lastpos') || '{}');
        map[lessonId] = {
          t: Math.max(0, Number(it.start) || 0),
          idx: Math.max(0, Number(it.idx) || 0),
          ts: Date.now()
        };
        localStorage.setItem('nce_lastpos', JSON.stringify(map));
        sessionStorage.setItem('nce_resume', lessonId);
        sessionStorage.removeItem('nce_resume_play');
      } catch (_) {}

      location.href = `lesson.html#${lessonId}?from=favorites`;
    }

    function openPanel(overlay, panel) {
      if (!overlay || !panel) return;
      overlay.hidden = false;
      panel.hidden = false;
      requestAnimationFrame(() => {
        overlay.classList.add('show');
        panel.classList.add('show');
      });
    }
    function closePanel(overlay, panel) {
      if (!overlay || !panel) return;
      overlay.classList.remove('show');
      panel.classList.remove('show');
      setTimeout(() => {
        overlay.hidden = true;
        panel.hidden = true;
      }, 220);
    }

    // Init
    try { ttsRate = clampRate(localStorage.getItem(TTS_RATE_KEY)); } catch (_) { ttsRate = 1.0; }
    try { ttsLoop = normalizeLoop(localStorage.getItem(TTS_LOOP_KEY)); } catch (_) { ttsLoop = 'off'; }
    try { ttsVoiceName = String(localStorage.getItem(TTS_VOICE_KEY) || ''); } catch (_) { ttsVoiceName = ''; }
    setPlayIcon(false);
    updateShortcutHints();
    if (ttsRateSelect) {
      const opts = RATE_OPTIONS.map(r => `<option value="${r}">${rateLabel(r)}</option>`).join('');
      ttsRateSelect.innerHTML = opts;
      const current = String(ttsRate);
      if (Array.from(ttsRateSelect.options).some(o => o.value === current)) {
        ttsRateSelect.value = current;
      } else {
        const extra = document.createElement('option');
        extra.value = current;
        extra.textContent = rateLabel(ttsRate);
        ttsRateSelect.appendChild(extra);
        ttsRateSelect.value = current;
      }
    }
    if (ttsLoopSelect) {
      ttsLoopSelect.value = ttsLoop;
    }

    setSubtitle();
    renderList();
    updateTtsPos();
    NCE_COLLECTIONS.bindTabs(collectionTabs, selectCollection);
    NCE_RESOURCES.listCollections().then(result => {
      collections = result;
      collectionFiltersReady = true;
      collectionBar.hidden = false;
      renderCollectionFilters();
      collectionStatus.hidden = true;
    }).catch(error => {
      console.error('加载收藏合集分类失败', error);
      collectionStatus.textContent = '加载合集分类失败，请刷新重试；仍可查看全部收藏。' + (error.message || error);
    });
    NCE_RESOURCES.listLessons().then(result => {
      const available = new Map(result.map(item => [item.id, item.hasAudio && item.hasLrc]));
      allFavs.forEach(item => {
        const id = favoriteLessonId(item);
        if (!lessonAvailability.has(id)) setLessonAvailable(id, available.get(id) === true);
      });
    }).catch(error => {
      console.error('加载收藏原文信息失败', error);
      showNotification('加载原文信息失败：' + (error.message || error));
    });
    if (window.NCE_APP && typeof NCE_APP.initSegmented === 'function') {
      try { NCE_APP.initSegmented(document); } catch (_) {}
    }
    refreshVoiceSelect();
    if (supportsTTS()) {
      try {
        if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', refreshVoiceSelect);
        else synth.onvoiceschanged = refreshVoiceSelect;
      } catch (_) {}
    }

    // Events
    if (clearListBtn) {
      clearListBtn.addEventListener('click', () => {
        if (!favs.length) return;
        const ok = confirm(`确定清空${collectionScopeLabel()}（${favs.length} 句）吗？此操作不可撤销。`);
        if (!ok) return;
        const ids = new Set(favs.map(item => item.id));
        if (replaceFavorites(allFavs.filter(item => !ids.has(item.id)))) {
          closePanel(ttsOverlay, ttsPanel);
        }
      });
    }

    if (ttsSettingsBtn) ttsSettingsBtn.addEventListener('click', () => openPanel(ttsOverlay, ttsPanel));
    if (ttsOverlay) ttsOverlay.addEventListener('click', () => closePanel(ttsOverlay, ttsPanel));
    if (ttsClose) ttsClose.addEventListener('click', () => closePanel(ttsOverlay, ttsPanel));

    // 数据导出 / 导入（复用 assets/storage.js 的共享实现）
    if (window.NCE_STORAGE) {
      NCE_STORAGE.bindDataControls({
        exportBtn: favDataExportBtn,
        importBtn: favDataImportBtn,
        importFile: favDataImportFile,
        notify: showNotification
      });
    }

    document.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        if (action === 'remove') {
          e.preventDefault();
          e.stopPropagation();
          removeById(actionBtn.dataset.id);
          return;
        }
        if (action === 'jump') {
          e.preventDefault();
          e.stopPropagation();
          const i = parseInt(actionBtn.dataset.i, 10);
          if (Number.isFinite(i)) jumpToSource(i);
          return;
        }
      }

      const item = e.target.closest('.fav-item');
      if (item && listEl && listEl.contains(item)) {
        const i = parseInt(item.dataset.i, 10);
        if (Number.isFinite(i)) {
          playIndex(i, { scroll: true });
        }
      }
    }, { passive: false });

    function navigateSentence(delta) {
      if (!favs.length) return;
      const next = Math.max(0, Math.min(favs.length - 1, currentIndex >= 0 ? currentIndex + delta : 0));
      playIndex(next, { scroll: true });
    }
    if (ttsPrev) ttsPrev.addEventListener('click', () => navigateSentence(-1));
    if (ttsNext) ttsNext.addEventListener('click', () => navigateSentence(1));
    document.addEventListener('keydown', e => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable || target.closest?.('[role="tablist"]'))) return;
      if (document.querySelector('dialog[open], [role="dialog"]:not([hidden]), #searchModal:not([hidden]), #dataConfirmOverlay')) return;
      const action = ['playPause', 'replay', 'prevSentence', 'nextSentence', 'volumeUp', 'volumeDown']
        .find(name => matchesShortcut(e, name, currentShortcuts));
      if (!action) return;
      if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const button = target?.closest?.('button, a[href], summary');
        if (button && button !== ttsPlayPause) return;
      }
      if (!favs.length && action !== 'volumeUp' && action !== 'volumeDown') return;
      e.preventDefault();
      if (e.repeat && (action === 'playPause' || action === 'replay')) return;
      if (action === 'playPause') togglePlayback();
      else if (action === 'replay') playIndex(currentIndex >= 0 ? currentIndex : 0, { scroll: true });
      else if (action === 'prevSentence' || action === 'nextSentence') navigateSentence(action === 'prevSentence' ? -1 : 1);
      else changeVolume(action === 'volumeUp' ? 0.1 : -0.1);
    });
    async function togglePlayback() {
      if (!favs.length) return;
      if (playbackState === 'loading') {
        stopPlayback();
        return;
      }
      if (playbackState === 'playing') {
        if (playbackKind === 'audio') {
          audio.pause();
          clearSegmentTimer();
        } else if (synth) synth.pause();
        setPlaybackState('paused');
        return;
      }
      if (playbackState === 'paused') {
        const seq = playbackSeq;
        try {
          if (playbackKind === 'audio') {
            setPlaybackState('loading');
            await audio.play();
            if (seq !== playbackSeq) return;
          } else if (pendingUtterance) {
            const utterance = pendingUtterance;
            pendingUtterance = null;
            synth.resume();
            synth.speak(utterance);
          } else synth.resume();
          setPlaybackState('playing');
          if (playbackKind === 'audio') scheduleAudioBoundary();
        } catch (error) {
          if (seq !== playbackSeq) return;
          if (error.name === 'NotAllowedError') {
            setPlaybackState('paused');
            showNotification('浏览器阻止了播放，请点击播放重试。');
          } else reportPlaybackError(seq, error);
        }
        return;
      }
      const start = (currentIndex >= 0) ? currentIndex : 0;
      playIndex(start, { scroll: true });
    }
    if (ttsPlayPause) ttsPlayPause.addEventListener('click', togglePlayback);
    if (ttsLoopSelect) ttsLoopSelect.addEventListener('change', () => {
      ttsLoop = normalizeLoop(ttsLoopSelect.value);
      try { localStorage.setItem(TTS_LOOP_KEY, ttsLoop); } catch (_) {}
      showNotification(loopLabel(ttsLoop));
    });
    if (ttsRateSelect) ttsRateSelect.addEventListener('change', () => {
      ttsRate = clampRate(ttsRateSelect.value);
      try { localStorage.setItem(TTS_RATE_KEY, String(ttsRate)); } catch (_) {}
      if (playbackKind === 'audio') {
        audio.playbackRate = ttsRate;
        scheduleAudioBoundary();
      } else if (playbackKind === 'tts' && ['playing', 'paused'].includes(playbackState)) restartSpeech();
      showNotification(`倍速：${rateLabel(ttsRate)}`);
    });
    if (ttsVoiceSelect) ttsVoiceSelect.addEventListener('change', () => {
      if (!supportsTTS()) return;
      ttsVoiceName = ttsVoiceSelect.value || '';
      try { localStorage.setItem(TTS_VOICE_KEY, ttsVoiceName); } catch (_) {}
      ttsVoice = (ttsVoices || []).find(v => v && v.name === ttsVoiceName) || null;
      if (playbackKind === 'tts' && ['playing', 'paused'].includes(playbackState)) restartSpeech();
      showNotification('已切换音色');
    });

    window.addEventListener('pagehide', () => {
      stopPlayback();
      releaseAudioSource();
    });
    window.addEventListener('storage', event => {
      if (event.key === null || event.key === SHORTCUTS_KEY || event.key === 'nce_volume') syncPlaybackSettings();
    });
    window.addEventListener('focus', syncPlaybackSettings);
  });
})();
