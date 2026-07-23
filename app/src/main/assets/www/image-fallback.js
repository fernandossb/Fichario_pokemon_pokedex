'use strict';

/*
 * Sistema de imagens em cascata v13
 *
 * Ordem:
 * 1. foto salva pelo usuário / URL do catálogo
 * 2. cache de arte previamente validada
 * 3. TCGdex PT-BR por ID e coleção+número
 * 4. TCGdex EN por ID e coleção+número
 * 5. Pokémon TCG API por nome+número+coleção
 * 6. mapa local de exceções
 * 7. placeholder com botão "Recarregar arte"
 */
(() => {
  const CACHE_KEY = 'fichario-pokemon-image-cascade-cache-v3';
  const DIAGNOSTIC_KEY = 'fichario-pokemon-image-cascade-diagnostics-v3';
  const CACHE_TTL = 90 * 24 * 60 * 60 * 1000;
  const TCGDEX_ROOT = 'https://api.tcgdex.net/v2';
  const POKEMON_TCG_ROOT = 'https://api.pokemontcg.io/v2/cards';
  const attempts = new Map();
  const resolving = new Map();
  let activeCardId = '';
  let cache = {};
  let diagnostics = {};

  /*
   * Exceções podem ser adicionadas aqui quando uma carta ainda não estiver
   * indexada nas APIs. Use sempre uma URL de imagem estável e pública.
   */
  const IMAGE_OVERRIDES = Object.freeze({
    // Coleções de energia cujo endpoint pode omitir o campo image.
    'sve-003': 'https://assets.tcgdex.net/en/sv/sve/003',
    'sve-011': 'https://assets.tcgdex.net/en/sv/sve/011',
    'sve-019': 'https://assets.tcgdex.net/en/sv/sve/019',
    'mee-003': 'https://assets.tcgdex.net/en/me/mee/003',
  });

  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (_) { cache = {}; }
  try { diagnostics = JSON.parse(localStorage.getItem(DIAGNOSTIC_KEY) || '{}') || {}; } catch (_) { diagnostics = {}; }

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
  }

  function saveDiagnostics() {
    try { localStorage.setItem(DIAGNOSTIC_KEY, JSON.stringify(diagnostics)); } catch (_) {}
  }

  function normalize(value) {
    return String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function record(cardId, provider, status, detail = '') {
    if (!cardId) return;
    const list = Array.isArray(diagnostics[cardId]) ? diagnostics[cardId] : [];
    list.push({ provider, status, detail: String(detail || '').slice(0, 500), at: Date.now() });
    diagnostics[cardId] = list.slice(-20);
    saveDiagnostics();
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

  function setFor(card) {
    try {
      return (catalog?.sets || []).find(item => String(item.id) === String(card?.setId)) || null;
    } catch (_) {
      return null;
    }
  }

  function imageCandidates(value) {
    const source = String(value || '').trim();
    if (!source) return [];
    if (/\.(?:webp|png|jpe?g)(?:\?.*)?$/i.test(source)) return [source];
    const root = source.replace(/\/$/, '');
    return [`${root}/high.webp`, `${root}/high.png`, `${root}/low.webp`, `${root}/low.png`];
  }

  function englishTwin(value) {
    const source = String(value || '').trim();
    if (!source) return '';
    return source
      .replace('://assets.tcgdex.net/pt-br/', '://assets.tcgdex.net/en/')
      .replace('://assets.tcgdex.net/pt/', '://assets.tcgdex.net/en/');
  }


  const ENERGY_NAME_MAP = Object.freeze({
    agua: { english: 'Basic Water Energy', type: 'Water', number: '003' },
    water: { english: 'Basic Water Energy', type: 'Water', number: '003' },
    fogo: { english: 'Basic Fire Energy', type: 'Fire', number: '002' },
    fire: { english: 'Basic Fire Energy', type: 'Fire', number: '002' },
    grama: { english: 'Basic Grass Energy', type: 'Grass', number: '001' },
    planta: { english: 'Basic Grass Energy', type: 'Grass', number: '001' },
    grass: { english: 'Basic Grass Energy', type: 'Grass', number: '001' },
    eletrica: { english: 'Basic Lightning Energy', type: 'Lightning', number: '004' },
    eletrico: { english: 'Basic Lightning Energy', type: 'Lightning', number: '004' },
    lightning: { english: 'Basic Lightning Energy', type: 'Lightning', number: '004' },
    psiquica: { english: 'Basic Psychic Energy', type: 'Psychic', number: '005' },
    psychic: { english: 'Basic Psychic Energy', type: 'Psychic', number: '005' },
    lutador: { english: 'Basic Fighting Energy', type: 'Fighting', number: '006' },
    fighting: { english: 'Basic Fighting Energy', type: 'Fighting', number: '006' },
    noturna: { english: 'Basic Darkness Energy', type: 'Darkness', number: '007' },
    escuridao: { english: 'Basic Darkness Energy', type: 'Darkness', number: '007' },
    darkness: { english: 'Basic Darkness Energy', type: 'Darkness', number: '007' },
    metal: { english: 'Basic Metal Energy', type: 'Metal', number: '008' },
  });

  function energyInfo(card) {
    const normalized = normalize(card?.name);
    if (!normalized.includes('energia') && !normalized.includes('energy')) return null;
    for (const [token, info] of Object.entries(ENERGY_NAME_MAP)) {
      if (normalized.includes(token)) return info;
    }
    return { english: 'Basic Energy', type: '', number: '' };
  }

  function tcgdexSeriesForSet(setId) {
    const id = String(setId || '').toLowerCase();
    if (id.startsWith('sv') || id === 'sve' || id === 'svp') return 'sv';
    if (id.startsWith('me') || id === 'mee' || id === 'mep') return 'me';
    if (id.startsWith('swsh')) return 'swsh';
    if (id.startsWith('sm')) return 'sm';
    if (id.startsWith('xy')) return 'xy';
    if (id.startsWith('bw')) return 'bw';
    if (id.startsWith('hgss')) return 'hgss';
    if (id.startsWith('dp')) return 'dp';
    if (id.startsWith('base')) return 'base';
    return '';
  }

  function directTcgdexAssetCandidates(card) {
    const setId = String(card?.setId || '').trim();
    const series = tcgdexSeriesForSet(setId);
    if (!series || !setId) return [];
    const urls = [];
    for (const localId of localIdVariants(card)) {
      for (const language of ['pt', 'en']) {
        const root = `https://assets.tcgdex.net/${language}/${series}/${setId}/${localId}`;
        urls.push(...imageCandidates(root));
      }
    }
    return [...new Set(urls)];
  }

  function remember(cardId, url, source) {
    if (!cardId || !url) return;
    cache[cardId] = { url, source: source || 'unknown', savedAt: Date.now() };
    saveCache();
    record(cardId, source || 'cache', 'success', url);
  }

  async function fetchJson(url, provider, cardId, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        record(cardId, provider, `http-${response.status}`, url);
        return null;
      }
      const data = await response.json();
      record(cardId, provider, 'response', url);
      return data;
    } catch (error) {
      record(cardId, provider, error?.name === 'AbortError' ? 'timeout' : 'network-error', error?.message || url);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function localIdVariants(card) {
    const raw = String(card?.localId || card?.number || '').split('/')[0].trim();
    const values = new Set([raw]);
    if (/^\d+$/.test(raw)) {
      values.add(String(Number(raw)));
      values.add(raw.padStart(2, '0'));
      values.add(raw.padStart(3, '0'));
    }
    return [...values].filter(Boolean);
  }

  function cardIdVariants(card) {
    const ids = new Set([String(card?.id || '').trim()]);
    const setId = String(card?.setId || '').trim();
    for (const localId of localIdVariants(card)) {
      if (setId && localId) ids.add(`${setId}-${localId}`);
    }
    return [...ids].filter(Boolean);
  }

  async function tcgdexImages(card, language) {
    const provider = `tcgdex-${language}`;
    const endpoints = [];
    for (const id of cardIdVariants(card)) {
      endpoints.push(`${TCGDEX_ROOT}/${language}/cards/${encodeURIComponent(id)}`);
    }
    const setId = String(card?.setId || '').trim();
    for (const localId of localIdVariants(card)) {
      if (setId && localId) endpoints.push(`${TCGDEX_ROOT}/${language}/sets/${encodeURIComponent(setId)}/${encodeURIComponent(localId)}`);
    }

    const urls = [];
    for (const endpoint of [...new Set(endpoints)]) {
      const detail = await fetchJson(endpoint, provider, card.id);
      if (detail?.image) urls.push(...imageCandidates(detail.image));
    }
    return [...new Set(urls)];
  }

  function escapeLucene(value) {
    return String(value || '').replace(/([+\-!(){}\[\]^"~*?:\\/])/g, '\\$1');
  }

  function pokemonApiScore(candidate, card, set) {
    let score = 0;
    const expectedName = normalize(card?.name);
    const candidateName = normalize(candidate?.name);
    if (expectedName && candidateName === expectedName) score += 60;
    else if (expectedName && candidateName.includes(expectedName)) score += 35;

    const expectedNumbers = new Set(localIdVariants(card).map(value => String(Number(value) || value)));
    const candidateNumber = String(candidate?.number || '').replace(/^0+(?=\d)/, '');
    if (expectedNumbers.has(candidateNumber)) score += 45;

    const expectedSetNames = [set?.name, set?.nameEn, card?.setName].map(normalize).filter(Boolean);
    const candidateSetName = normalize(candidate?.set?.name);
    if (expectedSetNames.some(name => name === candidateSetName)) score += 50;
    else if (expectedSetNames.some(name => name && (candidateSetName.includes(name) || name.includes(candidateSetName)))) score += 25;

    const expectedSetId = normalize(card?.setId);
    const candidateSetId = normalize(candidate?.set?.id);
    if (expectedSetId && candidateSetId === expectedSetId) score += 35;
    return score;
  }


  function pokemonEnergyScore(candidate, card, set, info) {
    let score = pokemonApiScore(candidate, card, set);
    const supertype = normalize(candidate?.supertype);
    const subtypes = Array.isArray(candidate?.subtypes) ? candidate.subtypes.map(normalize) : [];
    const types = Array.isArray(candidate?.types) ? candidate.types.map(normalize) : [];
    if (supertype === 'energy') score += 80;
    if (subtypes.includes('basic')) score += 30;
    if (info?.type && types.includes(normalize(info.type))) score += 70;
    const candidateName = normalize(candidate?.name);
    if (info?.english && candidateName === normalize(info.english)) score += 70;
    return score;
  }

  async function pokemonTcgEnergyImages(card) {
    const info = energyInfo(card);
    if (!info) return [];
    const provider = 'pokemontcg-energy-api';
    const set = setFor(card);
    const number = String(card?.localId || card?.number || '').split('/')[0].replace(/^0+(?=\d)/, '');
    const queries = [];
    if (info.english && number) queries.push(`name:"${escapeLucene(info.english)}" number:${escapeLucene(number)} supertype:Energy`);
    if (info.english) queries.push(`name:"${escapeLucene(info.english)}" supertype:Energy`);
    if (number) queries.push(`number:${escapeLucene(number)} supertype:Energy`);
    queries.push('supertype:Energy');

    let candidates = [];
    for (const query of queries) {
      const url = `${POKEMON_TCG_ROOT}?q=${encodeURIComponent(query)}&pageSize=250&select=id,name,number,supertype,subtypes,types,set,images`;
      const response = await fetchJson(url, provider, card.id, 18000);
      if (Array.isArray(response?.data) && response.data.length) {
        candidates = response.data;
        const rankedNow = candidates
          .map(item => ({ item, score: pokemonEnergyScore(item, card, set, info) }))
          .sort((a, b) => b.score - a.score);
        if (rankedNow[0]?.score >= 150) break;
      }
    }

    const ranked = candidates
      .map(item => ({ item, score: pokemonEnergyScore(item, card, set, info) }))
      .filter(row => row.score >= 120)
      .sort((a, b) => b.score - a.score);
    const urls = [];
    for (const row of ranked.slice(0, 5)) {
      if (row.item?.images?.large) urls.push(row.item.images.large);
      if (row.item?.images?.small) urls.push(row.item.images.small);
    }
    if (!urls.length) record(card.id, provider, 'no-confident-energy-match', `${info.english} #${number}`);
    return [...new Set(urls)];
  }

  async function pokemonTcgImages(card) {
    const provider = 'pokemontcg-api';
    const set = setFor(card);
    const number = String(card?.localId || card?.number || '').split('/')[0].replace(/^0+(?=\d)/, '');
    const name = String(card?.name || '').trim();
    if (!name) return [];

    const queries = [];
    if (number && set?.name) queries.push(`name:"${escapeLucene(name)}" number:${escapeLucene(number)} set.name:"${escapeLucene(set.name)}"`);
    if (number) queries.push(`name:"${escapeLucene(name)}" number:${escapeLucene(number)}`);
    if (set?.name) queries.push(`name:"${escapeLucene(name)}" set.name:"${escapeLucene(set.name)}"`);
    queries.push(`name:"${escapeLucene(name)}"`);

    let candidates = [];
    for (const query of queries) {
      const url = `${POKEMON_TCG_ROOT}?q=${encodeURIComponent(query)}&pageSize=100&select=id,name,number,set,images`;
      const response = await fetchJson(url, provider, card.id, 15000);
      if (Array.isArray(response?.data) && response.data.length) {
        candidates = response.data;
        break;
      }
    }

    const ranked = candidates
      .map(item => ({ item, score: pokemonApiScore(item, card, set) }))
      .filter(row => row.score >= 80)
      .sort((a, b) => b.score - a.score);

    const urls = [];
    for (const row of ranked.slice(0, 3)) {
      if (row.item?.images?.large) urls.push(row.item.images.large);
      if (row.item?.images?.small) urls.push(row.item.images.small);
    }
    if (!urls.length) record(card.id, provider, 'no-confident-match', `${name} #${number}`);
    return [...new Set(urls)];
  }

  function classForTarget(target) {
    if (target?.closest?.('.registration-header')) return 'registration-card-image';
    if (target?.closest?.('.deck-card-row')) return 'deck-card-image';
    if (target?.closest?.('.card-row')) return 'card-thumb';
    return 'modal-card-image';
  }

  function makeImage(cardId, url, cssClass, alt = 'Arte da carta', source = '') {
    const img = document.createElement('img');
    img.className = cssClass || 'card-thumb';
    img.src = url;
    img.alt = alt;
    img.loading = cssClass === 'registration-card-image' ? 'eager' : 'lazy';
    img.dataset.cardArtId = cardId;
    img.dataset.cardArtUrl = url;
    if (source) img.dataset.cardArtSource = source;
    img.addEventListener('load', () => {
      remember(cardId, img.currentSrc || img.src, source || img.dataset.cardArtSource || 'validated');
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
      resolving.delete(cardId);
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

  function applyUrl(cardId, url, source = '') {
    if (!url) return;
    const card = cardFor(cardId);
    for (const target of targetsFor(cardId)) {
      if (target.tagName === 'IMG' && target.src === url) continue;
      const cssClass = classForTarget(target);
      target.replaceWith(makeImage(cardId, url, cssClass, card?.name || 'Arte da carta', source));
    }
  }

  function applyRetry(cardId) {
    for (const target of targetsFor(cardId)) {
      if (target.querySelector?.('.card-art-retry')) continue;
      target.replaceWith(makeRetry(cardId, target));
    }
  }

  async function providerCandidates(card, force) {
    const list = [];
    const userPhoto = String(card?.userPhotoUri || card?.photoUri || card?.photo || '').trim();
    if (userPhoto) list.push({ url: userPhoto, source: 'foto-usuario' });

    const local = String(card?.imageUrl || card?.image || '').trim();
    for (const url of imageCandidates(local)) list.push({ url, source: 'catalogo' });
    for (const url of imageCandidates(englishTwin(local))) list.push({ url, source: 'catalogo-en' });

    const cached = cache[card.id];
    if (!force && cached?.url && Date.now() - Number(cached.savedAt || 0) < CACHE_TTL) {
      list.unshift({ url: cached.url, source: cached.source || 'cache' });
    }

    // Algumas coleções especiais (como SVE/MEE) possuem os arquivos no CDN,
    // mas o endpoint de detalhes pode não devolver o campo image.
    for (const url of directTcgdexAssetCandidates(card)) {
      list.push({ url, source: 'tcgdex-cdn-direto' });
    }

    for (const language of ['pt-br', 'pt', 'en']) {
      const urls = await tcgdexImages(card, language);
      for (const url of urls) list.push({ url, source: `tcgdex-${language}` });
      if (urls.length) break;
    }

    const energyUrls = await pokemonTcgEnergyImages(card);
    for (const url of energyUrls) list.push({ url, source: 'pokemontcg-energy-api' });

    const pokemonUrls = await pokemonTcgImages(card);
    for (const url of pokemonUrls) list.push({ url, source: 'pokemontcg-api' });

    const override = IMAGE_OVERRIDES[String(card.id)];
    if (override) {
      for (const url of imageCandidates(override)) list.push({ url, source: 'excecao-local' });
    }

    const seen = new Set();
    return list.filter(item => item.url && !seen.has(item.url) && seen.add(item.url));
  }

  async function resolveAndApply(cardId, force = false, failedUrl = '') {
    const id = String(cardId || '');
    const card = cardFor(id);
    if (!card) return;
    if (resolving.has(id)) return resolving.get(id);

    const promise = (async () => {
      const tried = attempts.get(id) || new Set();
      attempts.set(id, tried);
      if (failedUrl) tried.add(failedUrl);

      const candidates = await providerCandidates(card, force);
      for (const candidate of candidates) {
        if (tried.has(candidate.url)) continue;
        tried.add(candidate.url);
        record(id, candidate.source, 'trying', candidate.url);
        applyUrl(id, candidate.url, candidate.source);
        return;
      }
      record(id, 'cascade', 'exhausted', `${card.name || id}`);
      applyRetry(id);
    })().finally(() => resolving.delete(id));

    resolving.set(id, promise);
    return promise;
  }

  function handleFailure(img, cardId) {
    const failedUrl = img.currentSrc || img.src || '';
    const source = img.dataset.cardArtSource || 'unknown';
    record(cardId, source, 'image-load-error', failedUrl);
    const placeholderClass = img.closest('.registration-header') ? 'registration-placeholder' : 'card-placeholder';
    const placeholder = makePlaceholder(cardId, placeholderClass, 'Tentando outra fonte…');
    placeholder.dataset.cardArtId = cardId;
    img.replaceWith(placeholder);
    resolveAndApply(cardId, false, failedUrl);
  }

  function parseCardId(value, functionName) {
    const text = String(value || '');
    const pattern = new RegExp(`${functionName}\\(\\s*['"]([^'"]+)['"]`);
    return text.match(pattern)?.[1] || '';
  }

  function prepareTarget(target, cardId) {
    if (!target || !cardId || target.dataset.cardArtPrepared === '1') return;
    target.dataset.cardArtPrepared = '1';
    target.dataset.cardArtId = cardId;
    if (target.tagName === 'IMG') {
      const url = target.currentSrc || target.src || '';
      target.dataset.cardArtUrl = url;
      target.dataset.cardArtSource = target.dataset.cardArtSource || 'catalogo-renderizado';
      target.addEventListener('load', () => remember(cardId, target.currentSrc || target.src, target.dataset.cardArtSource), { once: true });
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
      prepareTarget(row.querySelector('.card-thumb, .card-placeholder'), cardId);
    });

    document.querySelectorAll('.deck-card-row').forEach(row => {
      const button = [...row.querySelectorAll('[onclick]')]
        .find(item => String(item.getAttribute('onclick')).includes('changeDeckCard'));
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
      prepareTarget(modal?.querySelector('.registration-card-image, .registration-placeholder'), activeCardId);
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
      const id = String(cardId || '');
      attempts.delete(id);
      resolving.delete(id);
      delete cache[id];
      saveCache();
      resolveAndApply(id, true);
    },
    clearCache() {
      cache = {};
      attempts.clear();
      resolving.clear();
      saveCache();
      scanCards();
    },
    diagnostics(cardId) {
      return cardId ? diagnostics[String(cardId)] || [] : diagnostics;
    },
  };
})();
