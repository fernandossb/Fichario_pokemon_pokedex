'use strict';

/*
 * Recuperação de artes v12
 * Mantém a arte PT-BR quando disponível e tenta a mesma carta em inglês quando
 * o catálogo local/português não possuir imagem.
 */
(() => {
  const CACHE_KEY = 'fichario-pokemon-image-fallback-cache-v1';
  const API_ROOT = 'https://api.tcgdex.net/v2';
  const attempts = new Map();
  let activeCardId = '';
  let cache = {};

  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
  } catch (_) {
    cache = {};
  }

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
  }

  function cardFor(cardId) {
    try {
      if (typeof cardMap !== 'undefined' && cardMap?.get) return cardMap.get(cardId) || null;
      if (typeof catalog !== 'undefined' && Array.isArray(catalog?.cards)) {
        return catalog.cards.find(item => String(item.id) === String(cardId)) || null;
      }
    } catch (_) {}
    return null;
  }

  function imageUrl(value, quality = 'low') {
    const source = String(value || '').trim();
    if (!source) return '';
    if (/\.(?:webp|png|jpe?g)(?:\?.*)?$/i.test(source)) return source;
    return `${source.replace(/\/$/, '')}/${quality}.webp`;
  }

  function englishTwin(value) {
    const source = String(value || '').trim();
    if (!source) return '';
    return source.replace('://assets.tcgdex.net/pt/', '://assets.tcgdex.net/en/');
  }

  function remember(cardId, url, source = 'tcgdex') {
    if (!cardId || !url) return;
    cache[cardId] = { url, source, savedAt: Date.now() };
    saveCache();
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiImage(card, language) {
    if (!card) return '';
    const id = encodeURIComponent(String(card.id || ''));
    const setId = encodeURIComponent(String(card.setId || ''));
    const localId = encodeURIComponent(String(card.localId || '').replace(/^0+(?=\d)/, '') || String(card.localId || ''));
    const endpoints = [];
    if (id) endpoints.push(`${API_ROOT}/${language}/cards/${id}`);
    if (setId && localId) endpoints.push(`${API_ROOT}/${language}/sets/${setId}/${localId}`);

    for (const endpoint of endpoints) {
      const detail = await fetchJson(endpoint);
      if (detail?.image) return imageUrl(detail.image);
    }
    return '';
  }

  function classForTarget(target) {
    if (target?.closest?.('.registration-header')) return 'registration-card-image';
    if (target?.closest?.('.deck-card-row')) return 'deck-card-image';
    if (target?.closest?.('.card-row')) return 'card-thumb';
    return 'modal-card-image';
  }

  function makeImage(cardId, url, cssClass, alt = 'Arte da carta') {
    const img = document.createElement('img');
    img.className = cssClass || 'card-thumb';
    img.src = url;
    img.alt = alt;
    img.loading = cssClass === 'registration-card-image' ? 'eager' : 'lazy';
    img.dataset.cardArtId = cardId;
    img.dataset.cardArtUrl = url;
    img.addEventListener('load', () => {
      remember(cardId, img.currentSrc || img.src);
      img.classList.remove('card-art-loading');
    }, { once: true });
    img.addEventListener('error', () => handleFailure(img, cardId), { once: true });
    return img;
  }

  function makePlaceholder(cardId, cssClass, message = 'Buscando arte…') {
    const placeholder = document.createElement('div');
    placeholder.className = `${cssClass || 'card-placeholder'} card-art-fallback`;
    placeholder.dataset.cardArtId = cardId;
    placeholder.innerHTML = `<span>${message}</span>`;
    return placeholder;
  }

  function makeRetry(cardId, target) {
    const cssClass = target?.closest?.('.registration-header') ? 'registration-placeholder' : 'card-placeholder';
    const placeholder = makePlaceholder(cardId, cssClass, 'Arte indisponível');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card-art-retry';
    button.textContent = 'Recarregar arte';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      attempts.delete(cardId);
      delete cache[cardId];
      saveCache();
      placeholder.innerHTML = '<span>Buscando arte…</span>';
      resolveAndApply(cardId, true);
    });
    placeholder.appendChild(button);
    return placeholder;
  }

  function targetsFor(cardId) {
    return [...document.querySelectorAll(`[data-card-art-id="${CSS.escape(String(cardId))}"]`)];
  }

  function applyUrl(cardId, url) {
    if (!url) return;
    const card = cardFor(cardId);
    if (card && !card.imageUrl) card.imageUrl = url;
    for (const target of targetsFor(cardId)) {
      if (target.tagName === 'IMG' && target.src === url) continue;
      const cssClass = classForTarget(target);
      target.replaceWith(makeImage(cardId, url, cssClass, card?.name || 'Arte da carta'));
    }
  }

  function applyRetry(cardId) {
    for (const target of targetsFor(cardId)) {
      if (target.querySelector?.('.card-art-retry')) continue;
      target.replaceWith(makeRetry(cardId, target));
    }
  }

  async function resolveAndApply(cardId, force = false, failedUrl = '') {
    const card = cardFor(cardId);
    if (!card) return;
    const tried = attempts.get(cardId) || new Set();
    attempts.set(cardId, tried);
    if (failedUrl) tried.add(failedUrl);

    const local = imageUrl(card.imageUrl);
    const cached = !force ? imageUrl(cache[cardId]?.url) : '';
    const twin = englishTwin(local);
    const directCandidates = [cached, local, twin].filter(Boolean);
    for (const candidate of directCandidates) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      applyUrl(cardId, candidate);
      return;
    }

    for (const language of ['pt', 'en']) {
      const found = await apiImage(card, language);
      if (!found || tried.has(found)) continue;
      tried.add(found);
      remember(cardId, found, `tcgdex-${language}`);
      applyUrl(cardId, found);
      return;
    }

    applyRetry(cardId);
  }

  function handleFailure(img, cardId) {
    const failedUrl = img.currentSrc || img.src || '';
    const placeholderClass = img.closest('.registration-header') ? 'registration-placeholder' : 'card-placeholder';
    const placeholder = makePlaceholder(cardId, placeholderClass, 'Tentando outra fonte…');
    img.replaceWith(placeholder);
    resolveAndApply(cardId, false, failedUrl);
  }

  function parseCardId(value, functionName) {
    const text = String(value || '');
    const pattern = new RegExp(`${functionName}\\(\\s*['\"]([^'\"]+)['\"]`);
    return text.match(pattern)?.[1] || '';
  }

  function prepareTarget(target, cardId) {
    if (!target || !cardId || target.dataset.cardArtPrepared === '1') return;
    target.dataset.cardArtPrepared = '1';
    target.dataset.cardArtId = cardId;
    if (target.tagName === 'IMG') {
      const url = target.currentSrc || target.src || '';
      target.dataset.cardArtUrl = url;
      target.addEventListener('load', () => remember(cardId, target.currentSrc || target.src), { once: true });
      target.addEventListener('error', () => handleFailure(target, cardId), { once: true });
      return;
    }
    target.classList.add('card-art-fallback');
    target.innerHTML = '<span>Buscando arte…</span>';
    resolveAndApply(cardId, false);
  }

  function scanCards() {
    document.querySelectorAll('.card-row').forEach(row => {
      const cardId = parseCardId(row.getAttribute('onclick'), 'openCard');
      const target = row.querySelector('.card-thumb, .card-placeholder');
      prepareTarget(target, cardId);
    });

    document.querySelectorAll('.deck-card-row').forEach(row => {
      const button = [...row.querySelectorAll('[onclick]')].find(item => String(item.getAttribute('onclick')).includes('changeDeckCard'));
      const cardId = parseCardId(button?.getAttribute('onclick'), 'changeDeckCard');
      const target = row.querySelector('img, .card-placeholder');
      if (target) prepareTarget(target, cardId);
      else if (cardId) {
        const holder = makePlaceholder(cardId, 'card-placeholder', 'Buscando arte…');
        row.prepend(holder);
        resolveAndApply(cardId, false);
      }
    });

    if (activeCardId) {
      const modal = document.getElementById('modal-content');
      const target = modal?.querySelector('.registration-card-image, .registration-placeholder');
      prepareTarget(target, activeCardId);
    }
  }

  try {
    if (typeof openCard === 'function') {
      const originalOpenCard = openCard;
      openCard = function(cardId, ...args) {
        activeCardId = String(cardId || '');
        const result = originalOpenCard.call(this, cardId, ...args);
        requestAnimationFrame(scanCards);
        return result;
      };
    }
  } catch (_) {}

  const observer = new MutationObserver(() => requestAnimationFrame(scanCards));
  const start = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    scanCards();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.FicharioImageFallback = {
    retry(cardId) {
      attempts.delete(cardId);
      delete cache[cardId];
      saveCache();
      resolveAndApply(cardId, true);
    },
    clearCache() {
      cache = {};
      attempts.clear();
      saveCache();
      scanCards();
    },
  };
})();
