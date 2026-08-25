(() => {
  'use strict';

  const DEFAULT_AVATAR_COUNT = 100;
  const AVATAR_GROUP_SIZE = 20;
  const AVATAR_GROUPS = Object.freeze(['星光', '影院', '海岸', '森林', '夜幕']);
  const AVATAR_IMAGE_SELECTOR = '.profile-avatar img, .member-avatar img, .member-profile-avatar img, .member-mini-avatar img, #accountAvatar img';
  let activeGroup = 0;
  let previewOverlay = null;
  let previewReturnFocus = null;
  let touchPreview = { source: '', at: 0 };
  let pendingAvatarClick = null;
  let suppressAvatarClickUntil = 0;
  let replayingAvatarClick = false;

  function avatarPath(id) {
    return `/default-avatar/${id}.svg`;
  }

  function selectedAvatarId(value) {
    const match = String(value || '').match(/^\/default-avatar\/([1-9]\d?|100)\.svg$/);
    return match ? Number(match[1]) : 0;
  }

  function groupForAvatar(id) {
    return Math.max(0, Math.min(AVATAR_GROUPS.length - 1, Math.floor((id - 1) / AVATAR_GROUP_SIZE)));
  }

  function avatarMatchesSearch(id, query) {
    if (!query) return true;
    const groupName = AVATAR_GROUPS[groupForAvatar(id)];
    const haystack = `${id} ${String(id).padStart(3, '0')} 默认头像 ${groupName}`.toLocaleLowerCase();
    return haystack.includes(query.toLocaleLowerCase());
  }

  function avatarIds(query) {
    const ids = Array.from({ length: DEFAULT_AVATAR_COUNT }, (_, index) => index + 1);
    if (query) return ids.filter((id) => avatarMatchesSearch(id, query));
    const first = activeGroup * AVATAR_GROUP_SIZE + 1;
    return ids.slice(first - 1, first - 1 + AVATAR_GROUP_SIZE);
  }

  function syncPickerSelection(picker, input) {
    const selected = selectedAvatarId(input.value);
    picker.querySelectorAll('[data-avatar-id]').forEach((button) => {
      const active = Number(button.dataset.avatarId) === selected;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const status = picker.querySelector('[data-avatar-selection]');
    if (status) status.textContent = selected ? `已选择默认头像 ${selected}` : '尚未选择默认头像';
  }

  function renderAvatarGrid(picker, input) {
    const search = picker.querySelector('[data-avatar-search]');
    const query = String(search?.value || '').trim();
    const ids = avatarIds(query);
    const grid = picker.querySelector('[data-avatar-grid]');
    if (!grid) return;
    grid.replaceChildren();
    if (!ids.length) {
      const empty = document.createElement('p');
      empty.className = 'default-avatar-empty';
      empty.textContent = '没有匹配的默认头像';
      grid.appendChild(empty);
    } else {
      const fragment = document.createDocumentFragment();
      for (const id of ids) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'default-avatar-option';
        button.dataset.avatarId = String(id);
        button.setAttribute('aria-label', `选择默认头像 ${id}`);
        button.setAttribute('aria-pressed', 'false');
        button.title = `默认头像 ${id}`;
        const image = document.createElement('img');
        image.src = avatarPath(id);
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.draggable = false;
        button.appendChild(image);
        fragment.appendChild(button);
      }
      grid.appendChild(fragment);
    }
    picker.querySelectorAll('[data-avatar-group]').forEach((button) => {
      const active = !query && Number(button.dataset.avatarGroup) === activeGroup;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    const result = picker.querySelector('[data-avatar-result]');
    if (result) result.textContent = query ? `找到 ${ids.length} 个` : `${AVATAR_GROUPS[activeGroup]} · ${ids.length} 个`;
    syncPickerSelection(picker, input);
  }

  function previewSelectedAvatar(input) {
    const hero = document.querySelector('#accountContent .profile-avatar');
    const id = selectedAvatarId(input.value);
    if (!hero || !id) return;
    const image = document.createElement('img');
    image.src = avatarPath(id);
    image.alt = '';
    image.decoding = 'async';
    hero.replaceChildren(image);
  }

  function createAvatarPicker(input) {
    const picker = document.createElement('section');
    picker.className = 'default-avatar-picker';
    picker.dataset.defaultAvatarPicker = '';
    picker.innerHTML = `
      <div class="default-avatar-heading">
        <div><strong>选择默认头像</strong><small>100 种离线头像</small></div>
        <span data-avatar-result>星光 · 20 个</span>
      </div>
      <label class="default-avatar-search"><span>搜索头像</span><input type="search" data-avatar-search placeholder="输入编号或系列名称" autocomplete="off"></label>
      <div class="default-avatar-groups" role="tablist" aria-label="默认头像系列">
        ${AVATAR_GROUPS.map((name, index) => `<button type="button" role="tab" data-avatar-group="${index}" aria-selected="${index === 0}">${name}</button>`).join('')}
      </div>
      <div class="default-avatar-grid" data-avatar-grid></div>
      <div class="default-avatar-footer"><span data-avatar-selection>尚未选择默认头像</span><small>选择后使用下方“保存资料”按钮保存</small></div>`;

    picker.addEventListener('click', (event) => {
      const groupButton = event.target.closest('[data-avatar-group]');
      if (groupButton) {
        activeGroup = Number(groupButton.dataset.avatarGroup) || 0;
        const search = picker.querySelector('[data-avatar-search]');
        if (search) search.value = '';
        renderAvatarGrid(picker, input);
        return;
      }
      const avatarButton = event.target.closest('[data-avatar-id]');
      if (!avatarButton) return;
      const id = Number(avatarButton.dataset.avatarId);
      if (!Number.isInteger(id) || id < 1 || id > DEFAULT_AVATAR_COUNT) return;
      input.value = avatarPath(id);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      previewSelectedAvatar(input);
      syncPickerSelection(picker, input);
      const saveButton = document.querySelector('[data-profile-action="save-profile"]');
      saveButton?.classList.add('avatar-save-ready');
    });
    picker.querySelector('[data-avatar-search]')?.addEventListener('input', () => renderAvatarGrid(picker, input));
    input.addEventListener('input', () => syncPickerSelection(picker, input));
    return picker;
  }

  function injectAvatarPicker() {
    const input = document.getElementById('profileAvatarInput');
    if (!(input instanceof HTMLInputElement)) return;
    const existing = document.querySelector('[data-default-avatar-picker]');
    if (existing) {
      syncPickerSelection(existing, input);
      return;
    }
    const label = input.closest('label');
    if (!label) return;
    const selected = selectedAvatarId(input.value);
    if (selected) activeGroup = groupForAvatar(selected);
    const picker = createAvatarPicker(input);
    label.insertAdjacentElement('afterend', picker);
    renderAvatarGrid(picker, input);
  }

  function ensurePreviewOverlay() {
    if (previewOverlay) return previewOverlay;
    previewOverlay = document.createElement('div');
    previewOverlay.className = 'avatar-preview-overlay is-hidden';
    previewOverlay.setAttribute('role', 'dialog');
    previewOverlay.setAttribute('aria-modal', 'true');
    previewOverlay.setAttribute('aria-label', '头像预览');
    previewOverlay.innerHTML = `
      <div class="avatar-preview-shell">
        <button class="avatar-preview-close" data-avatar-preview-close type="button" aria-label="关闭头像预览" title="关闭">×</button>
        <img data-avatar-preview-image alt="头像预览">
        <strong data-avatar-preview-title>头像预览</strong>
      </div>`;
    previewOverlay.addEventListener('click', (event) => {
      if (event.target === previewOverlay || event.target.closest('[data-avatar-preview-close]')) closeAvatarPreview();
    });
    document.body.appendChild(previewOverlay);
    return previewOverlay;
  }

  function avatarPreviewTitle(image) {
    const owner = image.closest('[data-username]');
    if (owner?.dataset.username) return `${owner.dataset.username} 的头像`;
    const profile = image.closest('.profile-item, .profile-hero, .member-profile-hero');
    const name = profile?.querySelector('strong, h2')?.textContent?.trim();
    return name ? `${name} 的头像` : '头像预览';
  }

  function openAvatarPreview(image) {
    if (!(image instanceof HTMLImageElement) || !image.src) return;
    cancelPendingAvatarClick();
    const overlay = ensurePreviewOverlay();
    const fullscreenRoot = document.fullscreenElement;
    if (fullscreenRoot && !fullscreenRoot.contains(overlay)) fullscreenRoot.appendChild(overlay);
    else if (!fullscreenRoot && overlay.parentElement !== document.body) document.body.appendChild(overlay);
    const preview = overlay.querySelector('[data-avatar-preview-image]');
    const title = avatarPreviewTitle(image);
    preview.src = image.currentSrc || image.src;
    preview.alt = title;
    overlay.querySelector('[data-avatar-preview-title]').textContent = title;
    previewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.remove('is-hidden');
    document.body.classList.add('avatar-preview-open');
    overlay.querySelector('[data-avatar-preview-close]')?.focus({ preventScroll: true });
  }

  function closeAvatarPreview() {
    if (!previewOverlay || previewOverlay.classList.contains('is-hidden')) return;
    previewOverlay.classList.add('is-hidden');
    document.body.classList.remove('avatar-preview-open');
    const preview = previewOverlay.querySelector('[data-avatar-preview-image]');
    if (preview) preview.removeAttribute('src');
    if (previewReturnFocus?.isConnected) previewReturnFocus.focus({ preventScroll: true });
    previewReturnFocus = null;
  }

  function matchingAvatarImage(target) {
    if (!(target instanceof Element)) return null;
    const image = target.closest(AVATAR_IMAGE_SELECTOR);
    if (image) return image;
    return target.closest('.member-avatar, .member-profile-avatar, .member-mini-avatar, .profile-avatar, #accountAvatar')?.querySelector('img') || null;
  }

  function cancelPendingAvatarClick() {
    if (!pendingAvatarClick) return;
    clearTimeout(pendingAvatarClick.timer);
    pendingAvatarClick = null;
  }

  function delayedClickControl(image) {
    return image.closest('.member-avatar, .location-member-row, #accountMenuBtn');
  }

  function delayedClickTarget(control) {
    if (control.matches('.member-avatar')) {
      return { kind: 'member', key: control.closest('[data-username]')?.dataset.username || '', control };
    }
    if (control.matches('.location-member-row')) {
      return { kind: 'location', key: control.dataset.locationProfile || '', control };
    }
    return { kind: 'account', key: '', control };
  }

  function currentDelayedClickControl(target) {
    if (target.control.isConnected) return target.control;
    if (target.kind === 'account') return document.getElementById('accountMenuBtn');
    const selector = target.kind === 'member'
      ? '.user-card[data-username]'
      : '.location-member-row[data-location-profile]';
    const keyName = target.kind === 'member' ? 'username' : 'locationProfile';
    const owner = [...document.querySelectorAll(selector)]
      .find((candidate) => candidate.dataset[keyName] === target.key);
    return target.kind === 'member' ? owner?.querySelector('.member-avatar') : owner;
  }

  function handleAvatarClick(event) {
    if (replayingAvatarClick) return;
    const image = matchingAvatarImage(event.target);
    const control = image && delayedClickControl(image);
    if (!control) return;
    const now = Date.now();
    if (now < suppressAvatarClickUntil || event.detail > 1) {
      cancelPendingAvatarClick();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelPendingAvatarClick();
    const target = delayedClickTarget(control);
    const timer = setTimeout(() => {
      pendingAvatarClick = null;
      const currentControl = currentDelayedClickControl(target);
      if (!currentControl) return;
      replayingAvatarClick = true;
      try { currentControl.click(); } finally { replayingAvatarClick = false; }
    }, 440);
    pendingAvatarClick = { timer, target };
  }

  function initialize() {
    const accountContent = document.getElementById('accountContent');
    if (accountContent) {
      const observer = new MutationObserver(() => requestAnimationFrame(injectAvatarPicker));
      observer.observe(accountContent, { childList: true, subtree: true });
      injectAvatarPicker();
    }
    document.addEventListener('click', handleAvatarClick, true);
    document.addEventListener('dblclick', (event) => {
      const image = matchingAvatarImage(event.target);
      if (!image) return;
      cancelPendingAvatarClick();
      suppressAvatarClickUntil = Date.now() + 420;
      event.preventDefault();
      event.stopImmediatePropagation();
      openAvatarPreview(image);
    }, true);
    document.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') return;
      const image = matchingAvatarImage(event.target);
      if (!image) return;
      const source = image.currentSrc || image.src;
      const now = Date.now();
      if (touchPreview.source === source && now - touchPreview.at < 420) {
        cancelPendingAvatarClick();
        suppressAvatarClickUntil = now + 520;
        event.preventDefault();
        event.stopImmediatePropagation();
        openAvatarPreview(image);
        touchPreview = { source: '', at: 0 };
      } else touchPreview = { source, at: now };
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAvatarPreview();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
