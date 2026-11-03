(() => {
  'use strict';
  const { escapeHTML } = NCEUtils;

  function renderTabs(tabs, collections, current, busy, { reorderable = true } = {}) {
    tabs.innerHTML = collections.length ? collections.map(collection => `
      <button type="button" class="collection-tab" role="tab"
        data-collection="${escapeHTML(collection.id)}"
        aria-selected="${collection.id === current}" tabindex="${collection.id === current ? 0 : -1}"
        draggable="${reorderable && !busy}" title="${escapeHTML(collection.name)}${reorderable ? '（拖动排序，或按 Alt + 左右方向键调整）' : ''}"${busy ? ' disabled' : ''}>
        ${escapeHTML(collection.name)}
      </button>`).join('') : '<span class="collection-placeholder">尚未创建合集</span>';
    const selected = tabs.querySelector('[aria-selected="true"]');
    if (selected) {
      const viewport = tabs.parentElement;
      const bounds = viewport.getBoundingClientRect();
      const active = selected.getBoundingClientRect();
      if (active.left < bounds.left) viewport.scrollLeft -= bounds.left - active.left;
      else if (active.right > bounds.right) viewport.scrollLeft += active.right - bounds.right;
    }
  }

  function bindTabs(tabs, onSelect, onReorder) {
    let dragged = null;
    function clearDrag() {
      dragged = null;
      tabs.querySelectorAll('[role="tab"]').forEach(tab =>
        tab.classList.remove('is-dragging', 'drop-before', 'drop-after'));
    }
    function dropTarget(event) {
      const target = event.target.closest('[data-collection]');
      if (!target || target.disabled || target === dragged) return null;
      const bounds = target.getBoundingClientRect();
      return { target, after: event.clientX >= bounds.left + bounds.width / 2 };
    }
    tabs.addEventListener('dragstart', event => {
      const tab = event.target.closest('[data-collection]');
      if (!onReorder || !tab || tab.disabled) {
        event.preventDefault();
        return;
      }
      dragged = tab;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', tab.dataset.collection);
      tab.classList.add('is-dragging');
    });
    tabs.addEventListener('dragover', event => {
      if (!dragged || dragged.disabled) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      tabs.querySelectorAll('[role="tab"]').forEach(tab =>
        tab.classList.remove('drop-before', 'drop-after'));
      const drop = dropTarget(event);
      if (drop) drop.target.classList.add(drop.after ? 'drop-after' : 'drop-before');
      const viewport = tabs.parentElement;
      const bounds = viewport.getBoundingClientRect();
      if (event.clientX < bounds.left + 32) viewport.scrollLeft -= 20;
      else if (event.clientX > bounds.right - 32) viewport.scrollLeft += 20;
    });
    tabs.addEventListener('dragleave', event => {
      if (!tabs.contains(event.relatedTarget)) {
        tabs.querySelectorAll('[role="tab"]').forEach(tab =>
          tab.classList.remove('drop-before', 'drop-after'));
      }
    });
    tabs.addEventListener('dragend', clearDrag);
    tabs.addEventListener('drop', async event => {
      if (!dragged) return;
      event.preventDefault();
      const drop = dropTarget(event);
      const source = dragged;
      clearDrag();
      if (!drop || source.disabled) return;
      const ids = Array.from(tabs.querySelectorAll('[role="tab"]'), tab => tab.dataset.collection);
      const previous = ids.join(',');
      ids.splice(ids.indexOf(source.dataset.collection), 1);
      ids.splice(ids.indexOf(drop.target.dataset.collection) + (drop.after ? 1 : 0), 0, source.dataset.collection);
      if (ids.join(',') !== previous) await onReorder(ids, source.dataset.collection);
    });
    tabs.addEventListener('click', async event => {
      const tab = event.target.closest('[data-collection]');
      if (dragged || !tab || tab.disabled || tab.getAttribute('aria-selected') === 'true') return;
      await onSelect(tab.dataset.collection);
      tabs.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    });
    tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const buttons = Array.from(tabs.querySelectorAll('[role="tab"]:not(:disabled)'));
      const index = buttons.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey && onReorder && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const next = index + (event.key === 'ArrowRight' ? 1 : -1);
        if (next < 0 || next >= buttons.length) return;
        const ids = buttons.map(tab => tab.dataset.collection);
        [ids[index], ids[next]] = [ids[next], ids[index]];
        return onReorder(ids, buttons[index].dataset.collection);
      }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click();
    });
  }

  function bindCreateDialog(button, onCreate) {
    const dialog = document.createElement('dialog');
    dialog.id = 'createCollectionDialog';
    dialog.className = 'collection-dialog';
    dialog.setAttribute('aria-labelledby', 'createCollectionTitle');
    dialog.innerHTML = `
      <form id="createCollectionForm">
        <h2 class="modal-title" id="createCollectionTitle">创建合集</h2>
        <p class="modal-text">为课程取一个合集名称，创建后即可导入资源。</p>
        <label for="collectionName">合集名称</label>
        <input id="collectionName" class="collection-name-input" placeholder="输入合集名称"
          required maxlength="80" autocomplete="off">
        <p id="createCollectionStatus" class="library-status" role="status" aria-live="polite"></p>
        <div class="collection-dialog-actions">
          <button type="button" class="btn-quiet" id="createCollectionCancel">取消</button>
          <button type="submit" class="btn-quiet" id="createCollectionBtn">创建</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    const form = dialog.querySelector('form');
    const input = dialog.querySelector('#collectionName');
    const status = dialog.querySelector('#createCollectionStatus');
    const submit = dialog.querySelector('#createCollectionBtn');
    const cancel = dialog.querySelector('#createCollectionCancel');
    let submitting = false;
    button.addEventListener('click', () => {
      if (button.disabled || dialog.open) return;
      status.textContent = '';
      dialog.showModal();
      input.focus();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => {
      if (submitting) event.preventDefault();
    });
    dialog.addEventListener('close', () => button.focus());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submitting) return;
      submitting = true;
      input.disabled = submit.disabled = cancel.disabled = true;
      status.textContent = '正在创建…';
      try {
        await onCreate(input.value);
        input.value = '';
        dialog.close();
      } catch (error) {
        console.error('创建合集失败：', error);
        status.textContent = '创建合集失败：' + (error.message || error);
      } finally {
        submitting = false;
        input.disabled = submit.disabled = cancel.disabled = false;
      }
    });
  }

  window.NCE_COLLECTIONS = { renderTabs, bindTabs, bindCreateDialog };
})();
