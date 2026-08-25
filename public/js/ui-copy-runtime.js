'use strict';

(function exposeUiCopyRuntime(global) {
  const COPY_ATTRIBUTES = Object.freeze(['placeholder', 'title', 'aria-label', 'alt']);
  const INPUT_VALUE_TYPES = new Set(['button', 'submit', 'reset']);
  const GENERATED_KEY_PATTERN = /^ui\.auto\.[a-z0-9][a-z0-9_-]{0,47}\.(?:text|option|placeholder|title|aria-label|alt|value)\.[a-f0-9]{8}$/;
  const MAX_COPY_LENGTH = 240;
  const MAX_CATALOG_ENTRIES = 5000;
  const MAX_SLOT_VARIANTS = 12;
  const catalog = new Map();
  const bindingsByKey = new Map();
  const textBindings = new WeakMap();
  const attributeBindings = new WeakMap();
  const slotVariants = new WeakMap();
  let dictionary = {};
  let observer = null;
  let onCatalogChange = null;
  let catalogNotificationQueued = false;

  function cleanCopyText(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_COPY_LENGTH);
  }

  function validCopyText(value) {
    if (typeof value !== 'string' || value.length > MAX_COPY_LENGTH) return false;
    const text = cleanCopyText(value);
    return Boolean(text) && !/[<>]/.test(text) && !/(?:javascript|data):/i.test(text);
  }

  function validCopyKey(key, legacyDefaults = {}) {
    return Object.prototype.hasOwnProperty.call(legacyDefaults, key) || GENERATED_KEY_PATTERN.test(String(key || ''));
  }

  function hashText(value) {
    let hash = 0x811c9dc5;
    for (const char of String(value)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function slug(value, fallback = 'document') {
    const result = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return result || fallback;
  }

  function textParts(value) {
    const raw = String(value ?? '');
    const match = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return { leading: match?.[1] || '', text: cleanCopyText(match?.[2] || ''), trailing: match?.[3] || '' };
  }

  function isCopyText(value) {
    const text = cleanCopyText(value);
    return Boolean(text) && text.length <= MAX_COPY_LENGTH && /[^\s]/u.test(text);
  }

  function ignoredElement(element) {
    if (!(element instanceof Element)) return true;
    if (element.closest('script, style, noscript, template, [contenteditable="true"], [data-copy-ignore="true"]')) return true;
    return Boolean(element.closest('[data-copy-dynamic="true"]') && !element.dataset.copyKey);
  }

  function dynamicDataElement(element) {
    if (!(element instanceof Element) || element.dataset.copyKey) return false;
    const actionControl = element.closest('button, [role="button"]');
    if (actionControl && [...actionControl.attributes].some((attribute) => /^data-(?:[a-z0-9-]*-)?(?:action|page|mode|tab|section)$/.test(attribute.name))) return false;
    if (element.closest('[data-copy-dynamic="true"], .chat-history, .friend-chat-history, .file-list, .user-list, .toast-region, .reaction-layer, .danmaku-container')) return true;
    if (element.matches('[role="status"], [role="alert"], [aria-live]')) return true;
    const id = element.id || '';
    return /(?:roomName|roomCode|roomId|Username|DisplayName|Avatar|DeviceIp|Address|Sender|FileName|CurrentTime|Duration|Online|Latency|ProgressText|ProgressDetail|Status)$/i.test(id);
  }

  function isFunctionalGlyph(value) {
    const text = cleanCopyText(value);
    if (!text) return true;
    return !/[\p{L}\p{N}]/u.test(text) && /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u200d\ufe0f]/u.test(text);
  }

  function ignoredButton(button) {
    return Boolean(button.closest('[data-copy-ignore="true"]')) || Boolean(button.matches('[data-chat-emoji], [data-reaction], [data-emoji]')) || isFunctionalGlyph(button.textContent);
  }

  function stableControlId(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) return element.id;
    if (element.matches('label')) {
      const explicit = element.htmlFor && document.getElementById(element.htmlFor);
      const control = explicit || element.querySelector('input[id], select[id], textarea[id], button[id]');
      if (control?.id) return control.id;
    }
    if (element.matches('option')) {
      const select = element.closest('select[id]');
      if (select?.id) return select.id;
    }
    const control = element.closest('button[id], a[id], label[id], [role="button"][id]');
    return control?.id || '';
  }

  function nearestScopeId(element) {
    const direct = stableControlId(element);
    if (direct) return direct;
    return element.closest('[id]')?.id || 'document';
  }

  function structuralDescriptor(element) {
    const pieces = [];
    let current = element;
    while (current && current !== document.body && pieces.length < 5) {
      if (current.id) { pieces.unshift(`#${current.id}`); break; }
      const action = [...current.attributes].find((attribute) => /^data-(?:[a-z0-9-]*-)?(?:action|page|mode|tab|section|owner-exit|desktop-close)$/.test(attribute.name));
      const stableValue = current.matches('option[value]') ? `value=${current.getAttribute('value')}` : '';
      const classes = [...current.classList].filter((name) => !/^(?:is-|has-|active|selected|open|hidden)/.test(name)).slice(0, 2);
      const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
      const index = !action && !stableValue && siblings.length > 1 ? siblings.indexOf(current) + 1 : 0;
      pieces.unshift(`${current.tagName.toLowerCase()}${classes.length ? `.${classes.join('.')}` : ''}${action ? `[${action.name}=${action.value}]` : stableValue ? `[${stableValue}]` : ''}${index ? `:${index}` : ''}`);
      current = current.parentElement;
    }
    return pieces.join('>') || element.tagName.toLowerCase();
  }

  function generatedKey(element, kind, defaultText, suffix = '') {
    const scope = nearestScopeId(element);
    const identity = `${scope}|${structuralDescriptor(element)}|${kind}|${suffix}`;
    return `ui.auto.${slug(scope)}.${kind}.${hashText(identity)}`;
  }

  function notifyCatalogChanged() {
    if (!onCatalogChange || catalogNotificationQueued) return;
    catalogNotificationQueued = true;
    queueMicrotask(() => {
      catalogNotificationQueued = false;
      onCatalogChange?.();
    });
  }

  function addCatalogEntry(key, defaultText, kind, element, legacy = false) {
    if (catalog.has(key)) {
      const existing = catalog.get(key);
      if (!existing.legacy && existing.bindingCount === 0) existing.defaultText = cleanCopyText(defaultText);
      return existing;
    }
    if (catalog.size >= MAX_CATALOG_ENTRIES) return null;
    const entry = {
      key,
      defaultText: cleanCopyText(defaultText),
      kind,
      scope: nearestScopeId(element),
      legacy: Boolean(legacy),
      bindingCount: 0
    };
    catalog.set(key, entry);
    notifyCatalogChanged();
    return entry;
  }

  function addBinding(binding) {
    const entry = addCatalogEntry(binding.key, binding.defaultText, binding.kind, binding.element, binding.legacy);
    if (!entry) return false;
    if (!bindingsByKey.has(binding.key)) bindingsByKey.set(binding.key, new Set());
    bindingsByKey.get(binding.key).add(binding);
    entry.bindingCount += 1;
    return true;
  }

  function removeBinding(binding) {
    if (!binding) return;
    const bindings = bindingsByKey.get(binding.key);
    if (bindings?.delete(binding) && !bindings.size) bindingsByKey.delete(binding.key);
    const entry = catalog.get(binding.key);
    if (entry) entry.bindingCount = Math.max(0, entry.bindingCount - 1);
  }

  function cleanupRemovedNode(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      const binding = textBindings.get(root);
      if (binding) removeBinding(binding);
      return;
    }
    if (!(root instanceof Element)) return;
    const elements = [root, ...root.querySelectorAll('*')];
    for (const element of elements) {
      const attributes = attributeBindings.get(element);
      if (attributes) for (const binding of attributes.values()) removeBinding(binding);
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const binding = textBindings.get(node);
        if (binding) removeBinding(binding);
      }
    }
  }

  function desiredText(binding) {
    const candidate = dictionary[binding.key];
    return validCopyText(candidate) ? cleanCopyText(candidate) : binding.defaultText;
  }

  function applyBinding(binding) {
    const text = desiredText(binding);
    if (binding.kind === 'text' || binding.kind === 'option') {
      if (!binding.node.isConnected) return;
      const value = `${binding.leading}${text}${binding.trailing}`;
      if (binding.node.nodeValue !== value) binding.node.nodeValue = value;
      return;
    }
    if (!binding.element.isConnected) return;
    if (binding.kind === 'value') {
      if (binding.element.value !== text) binding.element.value = text;
      return;
    }
    if (binding.element.getAttribute(binding.kind) !== text) binding.element.setAttribute(binding.kind, text);
  }

  function markEditable(binding) {
    const element = binding.element;
    if (!element?.dataset) return;
    if (binding.kind === 'text' || binding.kind === 'option') {
      if (!element.dataset.uiCopyTextKey) element.dataset.uiCopyTextKey = binding.key;
    } else {
      const keys = new Set(String(element.dataset.uiCopyAttributeKeys || '').split(' ').filter(Boolean));
      keys.add(binding.key);
      element.dataset.uiCopyAttributeKeys = [...keys].join(' ');
    }
  }

  function variantAllowed(element, slot, defaultText) {
    let slots = slotVariants.get(element);
    if (!slots) { slots = new Map(); slotVariants.set(element, slots); }
    let variants = slots.get(slot);
    if (!variants) { variants = new Set(); slots.set(slot, variants); }
    const signature = hashText(defaultText);
    if (variants.has(signature)) return true;
    if (variants.size >= MAX_SLOT_VARIANTS) return false;
    variants.add(signature);
    return true;
  }

  function bindTextNode(node, options = {}) {
    if (!(node instanceof Text) || !node.parentElement || ignoredElement(node.parentElement)) return null;
    const parts = textParts(node.nodeValue);
    if (!isCopyText(parts.text)) return null;
    const element = node.parentElement;
    if (!options.legacy && (element.matches('[aria-hidden="true"]') || dynamicDataElement(element) || isFunctionalGlyph(parts.text))) return null;
    const kind = element.matches('option') ? 'option' : 'text';
    const directTextNodes = [...element.childNodes].filter((item) => item.nodeType === Node.TEXT_NODE && isCopyText(item.nodeValue));
    const nodeIndex = Math.max(0, directTextNodes.indexOf(node));
    const key = options.key || generatedKey(element, kind, parts.text, String(nodeIndex));
    if (!options.legacy && !GENERATED_KEY_PATTERN.test(key)) return null;
    const existing = textBindings.get(node);
    if (existing) {
      if (existing.key === key && existing.defaultText === parts.text) return existing;
      removeBinding(existing);
    }
    if (!variantAllowed(element, `${kind}:${nodeIndex}`, parts.text)) return null;
    const binding = { key, kind, defaultText: options.defaultText || parts.text, leading: parts.leading, trailing: parts.trailing, node, element, legacy: Boolean(options.legacy) };
    if (!addBinding(binding)) return null;
    textBindings.set(node, binding);
    markEditable(binding);
    applyBinding(binding);
    return binding;
  }

  function bindAttribute(element, attribute, options = {}) {
    if (!(element instanceof Element) || ignoredElement(element)) return null;
    if (!options.legacy && dynamicDataElement(element)) return null;
    const raw = attribute === 'value' ? element.value : element.getAttribute(attribute);
    const defaultText = cleanCopyText(raw);
    if (!isCopyText(defaultText)) return null;
    const key = options.key || generatedKey(element, attribute, defaultText);
    if (!options.legacy && !GENERATED_KEY_PATTERN.test(key)) return null;
    let bindings = attributeBindings.get(element);
    if (!bindings) { bindings = new Map(); attributeBindings.set(element, bindings); }
    const existing = bindings.get(attribute);
    if (existing) {
      if (existing.key === key && existing.defaultText === defaultText) return existing;
      removeBinding(existing);
    }
    if (!variantAllowed(element, attribute, defaultText)) return null;
    const binding = { key, kind: attribute, defaultText: options.defaultText || defaultText, element, legacy: Boolean(options.legacy) };
    if (!addBinding(binding)) return null;
    bindings.set(attribute, binding);
    markEditable(binding);
    applyBinding(binding);
    return binding;
  }

  function explicitTextTarget(element) {
    return element.querySelector('[data-copy-value], .button-label, strong') || element;
  }

  function bindExplicitElement(element, legacyDefaults) {
    const key = String(element.dataset.copyKey || '');
    if (!Object.prototype.hasOwnProperty.call(legacyDefaults, key)) return;
    const attribute = String(element.dataset.copyAttr || '');
    if (attribute) {
      bindAttribute(element, attribute, { key, defaultText: legacyDefaults[key], legacy: true });
      return;
    }
    const target = explicitTextTarget(element);
    const node = [...target.childNodes].find((item) => item.nodeType === Node.TEXT_NODE && isCopyText(item.nodeValue));
    if (node) bindTextNode(node, { key, defaultText: legacyDefaults[key], legacy: true });
  }

  function dynamicTextAllowed(node) {
    const element = node.parentElement;
    if (!element || dynamicDataElement(element) || isFunctionalGlyph(node.nodeValue)) return false;
    if (element.id || stableControlId(element)) return true;
    const semantic = element.closest('button, label, option, legend, summary, h1, h2, h3, h4, h5, h6, th, caption');
    if (!semantic) return false;
    if (semantic.id || stableControlId(semantic)) return true;
    if (semantic.matches('button') && [...semantic.attributes].some((attribute) => /^data-(?:[a-z0-9-]*-)?(?:action|page|mode|tab|section)$/.test(attribute.name))) return true;
    const scope = semantic.closest('[id]');
    if (!scope) return false;
    return !/(?:list|history|content|messages|directory|results|preview|viewer|region|layer)$/i.test(scope.id);
  }

  function scan(root = document, { dynamic = false, legacyDefaults = {} } = {}) {
    const rootElement = root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
    if (!(rootElement instanceof Element)) return;
    const elements = [rootElement, ...rootElement.querySelectorAll('*')];
    for (const element of elements) {
      if (ignoredElement(element)) continue;
      if (element.dataset.copyKey) bindExplicitElement(element, legacyDefaults);
      for (const attribute of COPY_ATTRIBUTES) {
        if (element.hasAttribute(attribute) && element.dataset.copyAttr !== attribute && (!dynamic || element.id || element.dataset.copyKey)) bindAttribute(element, attribute);
      }
      if (element instanceof HTMLInputElement && INPUT_VALUE_TYPES.has(element.type) && element.value && (!dynamic || element.id)) bindAttribute(element, 'value');
    }
    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (!textBindings.has(node) && (!dynamic || dynamicTextAllowed(node))) bindTextNode(node);
      node = walker.nextNode();
    }
  }

  function refreshTextBinding(node, legacyDefaults) {
    const binding = textBindings.get(node);
    if (!binding) { if (dynamicTextAllowed(node)) bindTextNode(node); return; }
    const current = textParts(node.nodeValue).text;
    if (current === desiredText(binding)) return;
    if (binding.legacy) { applyBinding(binding); return; }
    if (current === binding.defaultText) { applyBinding(binding); return; }
    bindTextNode(node, { legacyDefaults });
  }

  function refreshAttributeBinding(element, attribute) {
    const binding = attributeBindings.get(element)?.get(attribute);
    if (!binding) { if (element.id || element.dataset.copyKey) bindAttribute(element, attribute); return; }
    const current = cleanCopyText(attribute === 'value' ? element.value : element.getAttribute(attribute));
    if (current === desiredText(binding)) return;
    if (binding.legacy || current === binding.defaultText) { applyBinding(binding); return; }
    bindAttribute(element, attribute);
  }

  function startObserver(legacyDefaults) {
    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.removedNodes) cleanupRemovedNode(node);
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) scan(node, { dynamic: true, legacyDefaults });
            else if (node.nodeType === Node.TEXT_NODE && dynamicTextAllowed(node)) bindTextNode(node);
          }
        } else if (mutation.type === 'characterData') refreshTextBinding(mutation.target, legacyDefaults);
        else if (mutation.type === 'attributes') refreshAttributeBinding(mutation.target, mutation.attributeName);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...COPY_ATTRIBUTES, 'value'] });
  }

  function initialize({ legacyDefaults = {}, onChange = null } = {}) {
    onCatalogChange = typeof onChange === 'function' ? onChange : null;
    for (const [key, defaultText] of Object.entries(legacyDefaults)) {
      if (!catalog.has(key)) catalog.set(key, { key, defaultText, kind: 'legacy', scope: key.split('.')[0], legacy: true, bindingCount: 0 });
    }
    scan(document, { legacyDefaults });
    startObserver(legacyDefaults);
    notifyCatalogChanged();
    return coverage();
  }

  function apply(value = {}) {
    dictionary = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    for (const bindings of bindingsByKey.values()) for (const binding of bindings) applyBinding(binding);
  }

  function entries() {
    return [...catalog.values()].map((entry) => ({ ...entry })).sort((left, right) => left.scope.localeCompare(right.scope, 'zh-CN') || left.key.localeCompare(right.key, 'zh-CN'));
  }

  function defaultText(key) {
    return catalog.get(String(key || ''))?.defaultText || '';
  }

  function keyForTarget(target) {
    let element = target instanceof Element ? target : target?.parentElement;
    while (element && element !== document.body) {
      if (element.dataset.uiCopyTextKey) return element.dataset.uiCopyTextKey;
      const descendant = element.querySelector?.('[data-ui-copy-text-key]');
      if (descendant?.dataset.uiCopyTextKey) return descendant.dataset.uiCopyTextKey;
      const attributeKey = String(element.dataset.uiCopyAttributeKeys || '').split(' ').find(Boolean);
      if (attributeKey) return attributeKey;
      element = element.parentElement;
    }
    return '';
  }

  function coverage(root = document) {
    const rootElement = root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
    const connectedBindings = [...bindingsByKey.values()].flatMap((set) => [...set]).filter((binding) => binding.element?.isConnected && rootElement.contains(binding.element));
    const buttons = [...rootElement.querySelectorAll('button')].filter((button) => !ignoredElement(button) && !ignoredButton(button));
    const coveredButtons = buttons.filter((button) => {
      if (attributeBindings.get(button)?.size) return true;
      return [...button.querySelectorAll('*'), button].some((element) => element.dataset?.uiCopyTextKey || element.dataset?.uiCopyAttributeKeys);
    });
    const byKind = {};
    for (const binding of connectedBindings) byKind[binding.kind] = (byKind[binding.kind] || 0) + 1;
    return {
      catalogEntries: catalog.size,
      boundSlots: connectedBindings.length,
      totalButtons: buttons.length,
      coveredButtons: coveredButtons.length,
      buttonCoveragePercent: buttons.length ? Math.round((coveredButtons.length / buttons.length) * 10000) / 100 : 100,
      byKind
    };
  }

  global.SyncWatchUiCopy = Object.freeze({
    GENERATED_KEY_PATTERN,
    MAX_COPY_LENGTH,
    initialize,
    scan,
    apply,
    entries,
    defaultText,
    keyForTarget,
    coverage,
    validCopyKey,
    validCopyText
  });
})(window);
