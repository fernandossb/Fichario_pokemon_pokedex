'use strict';

try {
  if (window.Android?.getTopInsetCss) {
    document.documentElement.style.setProperty('--safe-top', `${window.Android.getTopInsetCss()}px`);
    document.documentElement.style.setProperty('--safe-bottom', `${window.Android.getBottomInsetCss()}px`);
  }
} catch (_) {}

const STORAGE_KEY = 'fichario-pokemon-br-plus-state-v1';
const CATALOG_DB_NAME = 'fichario-pokemon-catalog-v1';
const CATALOG_DB_STORE = 'catalog';
const CATALOG_DB_KEY = 'current';
const CATALOG_META_KEY = 'fichario-pokemon-catalog-meta-v1';
const PRICE_CACHE_KEY = 'fichario-pokemon-price-cache-v1';
const FX_CACHE_KEY = 'fichario-pokemon-fx-cache-v1';
const LIGA_SET_CACHE_KEY = 'fichario-pokemon-liga-set-cache-v1';
const PRICE_LOGIC_VERSION_KEY = 'fichario-pokemon-price-logic-version';
const PRICE_LOGIC_VERSION = 9;
const PRICE_CACHE_TTL = 24 * 60 * 60 * 1000;
const FX_CACHE_TTL = 24 * 60 * 60 * 1000;
const TCGDEX_API_BASE = 'https://api.tcgdex.net/v2/pt';
const TCGDEX_API_FALLBACK = 'https://api.tcgdex.net/v2/en';
const FX_API_BASE = 'https://api.frankfurter.dev/v2';
const LIGA_POKEMON_BASES = ['https://www.ligapokemon.com.br/', 'https://ligapokemon.com.br/'];
const TAB_ITEMS = [
  ['dashboard', 'Painel'],
  ['sets', 'Coleções'],
  ['cards', 'Cartas'],
  ['pokedex', 'Pokédex'],
  ['decks', 'Decks'],
  ['wishlist', 'Wishlist'],
  ['repeated', 'Repetidas'],
];
const REGION_ORDER = ['Kanto','Johto','Hoenn','Sinnoh','Unova','Kalos','Alola','Galar','Paldea','Outros'];

let catalog = null;
let pokedex = [];
let seed = null;
let state = null;
let cards = [];
let cardMap = new Map();
let pokemonMap = new Map();
let pokemonCards = new Map();
let pokemonNameIndex = [];
let catalogUpdateMeta = {};
let catalogUpdating = false;
let catalogUpdateMessage = '';
let catalogUpdateCurrent = 0;
let catalogUpdateTotal = 1;
let priceCache = {};
let fxCache = {};
let ligaSetCache = {};
let priceRequests = new Map();
let priceUpdating = false;
let priceUpdateMessage = '';
let priceUpdateCurrent = 0;
let priceUpdateTotal = 1;
let priceUpdateFailures = 0;
let lastPriceDiagnostic = '';
let selectedDeckId = null;

const ui = {
  tab: 'dashboard',
  cardQuery: '',
  cardFilter: 'owned',
  cardSort: 'number',
  cardSet: 'all',
  cardLimit: 80,
  setQuery: '',
  dexQuery: '',
  dexRegion: 'all',
  dexType: 'all',
  dexStatus: 'all',
  dexSort: 'number',
  selectedPokemon: null,
};

const esc = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const normalize = value => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

const hasFiniteNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

const money = value => hasFiniteNumber(value)
  ? Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  : 'Sem preço';


function foreignMoney(value, currency) {
  if (!hasFiniteNumber(value)) return 'Sem preço';
  try {
    return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: currency || 'EUR' });
  } catch (_) {
    return `${currency || ''} ${Number(value).toFixed(2)}`.trim();
  }
}

function loadStoredObject(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveStoredObject(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value || {})); } catch (_) {}
}

function loadPricingState() {
  priceCache = loadStoredObject(PRICE_CACHE_KEY);
  fxCache = loadStoredObject(FX_CACHE_KEY);
  ligaSetCache = loadStoredObject(LIGA_SET_CACHE_KEY);
}

function savePriceCache() {
  saveStoredObject(PRICE_CACHE_KEY, priceCache);
}

function saveFxCache() {
  saveStoredObject(FX_CACHE_KEY, fxCache);
}

function saveLigaSetCache() {
  saveStoredObject(LIGA_SET_CACHE_KEY, ligaSetCache);
}

function priceCacheFresh(cardId) {
  const item = priceCache[cardId];
  return Boolean(item && Number(item.logicVersion) === PRICE_LOGIC_VERSION && Number(item.fetchedAt) && Date.now() - Number(item.fetchedAt) < PRICE_CACHE_TTL);
}

function finishKind(finish) {
  const normalized = normalize(finish);
  if (normalized.includes('reversa') || normalized.includes('reverse')) return 'reverse';
  if (normalized.includes('holo') || normalized.includes('especial') || normalized.includes('full art') || normalized.includes('secreta')) return 'holo';
  return 'normal';
}

function firstFinite(...values) {
  for (const value of values) {
    if (hasFiniteNumber(value) && Number(value) >= 0) return Number(value);
  }
  return null;
}

function tcgplayerVariant(tcgplayer, kind) {
  if (!tcgplayer || typeof tcgplayer !== 'object') return null;
  if (kind === 'reverse') return tcgplayer['reverse-holofoil'] || tcgplayer.reverse || tcgplayer.reverseHolofoil || null;
  if (kind === 'holo') return tcgplayer.holofoil || tcgplayer.holo || tcgplayer['1st-edition-holofoil'] || tcgplayer['unlimited-holofoil'] || null;
  return tcgplayer.normal || tcgplayer.unlimited || tcgplayer['1st-edition'] || null;
}


function parseBrazilianMoney(value) {
  const clean = String(value || '').replace(/R\$/gi, '').replace(/\s/g, '').replaceAll('.', '').replace(',', '.');
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

function ligaPlainText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<\/\s*(?:tr|td|th|div|span|p|li|section|article|strong|b|small|label)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ccedil;/gi, 'ç')
    .replace(/\s+/g, ' ').trim();
}

function ligaMoneyValues(text) {
  const matches = String(text || '').match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?/g) || [];
  return matches.map(parseBrazilianMoney).filter(value => value != null && value >= 0);
}

function ligaRowFromText(text, labelRegex) {
  const source = String(text || '');
  const globalFlags = labelRegex.flags.includes('i') ? 'gi' : 'g';
  const pattern = new RegExp(labelRegex.source, globalFlags);
  const candidates = [];
  let match;
  while ((match = pattern.exec(source))) {
    const start = match.index;
    const following = source.slice(start, start + 1200);
    const nextLabel = following.slice(match[0].length).search(/\b(?:Normal|Reverse\s*Foil|Reverse|Holo\s*Foil|Holofoil|Hologr[aá]fica)\b/i);
    const segment = nextLabel >= 0 ? following.slice(0, match[0].length + nextLabel) : following;
    const prices = ligaMoneyValues(segment);
    if (prices.length) candidates.push({ prices, segmentLength: segment.length });
    if (pattern.lastIndex === match.index) pattern.lastIndex++;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.prices.length - a.prices.length || a.segmentLength - b.segmentLength);
  const prices = candidates[0].prices;
  if (prices.length >= 3) return { low: prices[0], average: prices[1], high: prices[2] };
  if (prices.length === 2) return { low: prices[0], average: prices[1], high: prices[1] };
  return { low: prices[0], average: prices[0], high: prices[0] };
}

function parseLigaPokemonHtml(html) {
  const text = ligaPlainText(html);
  const normal = ligaRowFromText(text, /\bNormal\b/i);
  const reverse = ligaRowFromText(text, /\b(?:Reverse\s*Foil|Reverse)\b/i);
  const holo = ligaRowFromText(text, /\b(?:Holo\s*Foil|Holofoil|Hologr[aá]fica|Holo)\b/i);
  if (normal || reverse || holo) return { normal, reverse, holo };
  const averageAnchor = text.search(/Pre[cç]o\s+M[eé]dio(?:\s+de\s+Venda)?/i);
  if (averageAnchor >= 0) {
    const values = ligaMoneyValues(text.slice(averageAnchor, averageAnchor + 900));
    if (values.length) {
      const average = values.length >= 2 ? values[1] : values[0];
      return { normal: { low: values[0], average, high: values[2] ?? average }, reverse: null, holo: null };
    }
  }
  return { normal: null, reverse: null, holo: null };
}

function ligaNumberPart(value, width = 3) {
  const raw = String(value || '').trim();
  const match = raw.match(/^([A-Za-z]*)(\d+)$/);
  if (!match) return raw;
  const prefix = match[1].toUpperCase();
  const digits = match[2];
  return `${prefix}${digits.padStart(prefix ? digits.length : width, '0')}`;
}

function ligaCardNumber(card) {
  const rawNumber = String(card?.number || '');
  const [rawNumerator, rawDenominator = ''] = rawNumber.split('/');
  const rawLocal = String(card?.localId || rawNumerator || '').trim();
  const prefixMatch = rawLocal.match(/^([A-Za-z]+)(\d+)$/);
  let numerator = ligaNumberPart(rawLocal, 3);
  let denominator = String(rawDenominator || '').trim();
  if (prefixMatch && /^\d+$/.test(denominator) && /^(TG|GG|SV)$/i.test(prefixMatch[1])) {
    denominator = `${prefixMatch[1].toUpperCase()}${denominator.padStart(prefixMatch[2].length, '0')}`;
  } else if (/^\d+$/.test(denominator)) {
    denominator = denominator.padStart(3, '0');
  }
  return { numerator, full: denominator ? `${numerator}/${denominator}` : numerator };
}

async function ligaSetCode(setId) {
  const localSet = (catalog?.sets || []).find(item => item.id === setId);
  const localCode = String(localSet?.tcgOnline || '').trim();
  if (localCode) return localCode.toUpperCase();
  const cached = ligaSetCache[setId];
  if (cached && String(cached.code || '').trim()) return String(cached.code).trim().toUpperCase();
  const detail = await fetchJsonWithTimeout(`${TCGDEX_API_BASE}/sets/${encodeURIComponent(setId)}`, 30000);
  const code = String(detail?.tcgOnline || '').trim().toUpperCase();
  ligaSetCache[setId] = { code: code || null, fetchedAt: Date.now() };
  saveLigaSetCache();
  if (code && localSet) localSet.tcgOnline = code;
  return code || null;
}

function ligaPokemonCardUrls(card, setCode) {
  const number = ligaCardNumber(card);
  const cardLabel = `${card.name} (${number.full})`;
  const direct = `view=cards/card&card=${encodeURIComponent(cardLabel)}&ed=${encodeURIComponent(setCode)}&num=${encodeURIComponent(number.numerator)}`;
  const search = `view=cards/search&card=${encodeURIComponent(card.name)}&ed=${encodeURIComponent(setCode)}`;
  const urls = [];
  for (const base of LIGA_POKEMON_BASES) {
    urls.push(`${base}?${direct}`);
    urls.push(`${base}?${search}`);
  }
  return [...new Set(urls)];
}

const nativeLigaRequests = new Map();

window.receiveLigaPokemonText = function(requestId, ok, text, error) {
  const id = String(requestId || '');
  const pending = nativeLigaRequests.get(id);
  if (!pending) return;
  nativeLigaRequests.delete(id);
  clearTimeout(pending.timeout);
  if (ok) pending.resolve(String(text || ''));
  else pending.reject(new Error(error || 'A Liga Pokémon não retornou a página de preços.'));
};

function fetchLigaTextThroughAndroid(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestId = `liga-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const timeout = setTimeout(() => {
      nativeLigaRequests.delete(requestId);
      reject(new Error('A consulta da Liga Pokémon expirou.'));
    }, Math.max(40000, Number(timeoutMs) + 5000));
    nativeLigaRequests.set(requestId, { resolve, reject, timeout });
    try {
      window.Android.requestLigaPokemon(requestId, url);
    } catch (error) {
      clearTimeout(timeout);
      nativeLigaRequests.delete(requestId);
      reject(error);
    }
  });
}

function fetchTextWithTimeout(url, timeoutMs = 30000) {
  if (window.Android && typeof window.Android.requestLigaPokemon === 'function') {
    return fetchLigaTextThroughAndroid(url, timeoutMs);
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), timeoutMs);
  return fetch(url, {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml' },
    cache: 'no-store',
    credentials: 'include',
    redirect: 'follow',
    referrerPolicy: 'strict-origin-when-cross-origin',
    signal: controller?.signal,
  }).then(response => {
    if (!response.ok) throw new Error(`Liga Pokémon respondeu ${response.status}`);
    return response.text();
  }).finally(() => clearTimeout(timeout));
}

async function fetchLigaPokemonPricing(cardId) {
  const card = cardMap.get(cardId);
  if (!card) throw new Error('Carta não encontrada no catálogo.');
  const setCode = await ligaSetCode(card.setId);
  if (!setCode) throw new Error('Esta coleção não possui código de mercado brasileiro.');
  const urls = ligaPokemonCardUrls(card, setCode);
  const errors = [];
  for (const url of urls) {
    try {
      const html = await fetchTextWithTimeout(url, 35000);
      const rows = parseLigaPokemonHtml(html);
      if (rows.normal || rows.reverse || rows.holo) {
        return { ...rows, setCode, url, fetchedAt: Date.now() };
      }
      const sample = ligaPlainText(html).slice(0, 240);
      errors.push(`sem preço em ${new URL(url).host}: ${sample || 'página vazia'}`);
    } catch (error) {
      errors.push(`${new URL(url).host}: ${String(error?.message || error || 'falha')}`);
    }
  }
  lastPriceDiagnostic = errors.join(' | ');
  try { localStorage.setItem('fichario-price-last-diagnostic', lastPriceDiagnostic); } catch (_) {}
  throw new Error(`Liga indisponível. ${lastPriceDiagnostic}`);
}

function ligaPokemonAverageQuote(liga, kind) {
  if (!liga || typeof liga !== 'object') return null;
  const row = kind === 'reverse' ? liga.reverse : kind === 'holo' ? liga.holo : liga.normal;
  if (!row || !hasFiniteNumber(row.average)) return null;
  const finishLabel = kind === 'reverse' ? 'Reverse Foil' : kind === 'holo' ? 'Holográfica' : 'Normal';
  return {
    value: Number(row.average),
    currency: 'BRL',
    label: `Liga Pokémon · média ${finishLabel}`,
    source: 'ligapokemon',
    provider: 'Marketplace Liga Pokémon',
    updated: liga.fetchedAt || null,
  };
}


async function fetchTcgDexPricing(cardId) {
  const card = cardMap.get(cardId);
  if (!card) throw new Error('Carta não encontrada no catálogo local.');
  const errors = [];
  for (const base of [TCGDEX_API_BASE, TCGDEX_API_FALLBACK]) {
    try {
      const detail = await fetchJsonWithTimeout(`${base}/cards/${encodeURIComponent(card.id)}`, 25000);
      if (!detail || String(detail.id || '') !== String(card.id)) throw new Error('identificador divergente');
      return {
        detail,
        identity: cardmarketIdentityFromDetail(detail),
        cardmarket: detail?.pricing?.cardmarket || null,
        tcgplayer: detail?.pricing?.tcgplayer || null,
        locale: base.endsWith('/en') ? 'en' : 'pt',
        fetchedAt: Date.now(),
      };
    } catch (error) {
      errors.push(`${base.endsWith('/en') ? 'TCGdex EN' : 'TCGdex PT'}: ${String(error?.message || error)}`);
    }
  }
  throw new Error(errors.join(' | ') || 'TCGdex indisponível.');
}

function exactRemoteValidation(card, remote, kind) {
  const checks = [
    { key: 'id', label: 'identificador exato', ok: String(remote?.id || '') === String(card?.id || '') },
    { key: 'set', label: 'coleção exata', ok: String(remote?.setId || '') === String(card?.setId || '') },
    { key: 'number', label: 'número exato', ok: normalizeCollectorId(remote?.localId) === normalizeCollectorId(card?.localId) },
    { key: 'name', label: 'nome da carta', ok: normalize(remote?.name) === normalize(card?.name) },
  ];
  const variants = remote?.variants || {};
  const finishAvailable = kind === 'normal'
    ? variants.normal !== false
    : kind === 'reverse'
      ? variants.reverse === true || variants.holo === true
      : variants.holo === true || variants.reverse === true;
  checks.push({ key: 'finish', label: 'acabamento disponível', ok: finishAvailable });
  const failed = checks.filter(item => !item.ok);
  return { verified: failed.length === 0, confidence: failed.length === 0 ? 'verified' : 'review', checks, reasons: failed.map(item => item.label) };
}

function tcgplayerMetric(tcgplayer, kind) {
  const variant = tcgplayerVariant(tcgplayer, kind);
  if (!variant || typeof variant !== 'object') return null;
  const candidates = [
    ['marketPrice', 'preço de mercado'],
    ['midPrice', 'preço médio'],
    ['directLowPrice', 'menor preço direto'],
    ['lowPrice', 'menor oferta'],
  ];
  for (const [field, label] of candidates) {
    if (hasFiniteNumber(variant[field]) && Number(variant[field]) >= 0) return { field, label, value: Number(variant[field]) };
  }
  return null;
}

function tcgplayerAverageQuote(tcgplayer, kind, card, remoteIdentity) {
  if (!tcgplayer || !card || !remoteIdentity) return null;
  const metric = tcgplayerMetric(tcgplayer, kind);
  if (!metric) return null;
  const validation = exactRemoteValidation(card, remoteIdentity, kind);
  const finishLabel = kind === 'reverse' ? 'reversa' : kind === 'holo' ? 'holográfica/foil' : 'comum';
  return {
    value: metric.value,
    currency: tcgplayer.unit || 'USD',
    label: `TCGplayer ${metric.label} · ${finishLabel}`,
    source: 'tcgplayer',
    provider: 'TCGplayer via TCGdex',
    updated: tcgplayer.updated || null,
    confidence: validation.confidence,
    verified: validation.verified,
    validation,
    fingerprint: [card.id, kind, metric.field, metric.value, tcgplayer.unit || 'USD', tcgplayer.updated || ''].join('|'),
  };
}

function quoteInBrl(quote, fetchedAt) {
  if (!quote || !hasFiniteNumber(quote.value)) return null;
  const rate = fxRate(quote.currency || 'BRL');
  if (!hasFiniteNumber(rate)) return null;
  return { ...quote, brl: Math.round(Number(quote.value) * Number(rate) * 100) / 100, rate: Number(rate), fetchedAt: fetchedAt || Date.now(), usable: quote.confidence === 'verified' };
}

function normalizeCollectorId(value) {
  const raw = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const match = raw.match(/^([A-Z]*)(\d+)$/);
  if (!match) return raw.replace(/[^A-Z0-9]/g, '');
  return `${match[1]}${Number(match[2])}`;
}

function sortedNumberList(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => Number(item)).filter(Number.isFinite).sort((a, b) => a - b);
}

function sameNumberList(left, right) {
  const a = sortedNumberList(left);
  const b = sortedNumberList(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function canonicalImageBase(value) {
  return String(value || '').split('?')[0]
    .replace(/\/(?:low|high)\.(?:webp|png|jpg|jpeg)$/i, '')
    .replace(/\/$/, '');
}

function cardmarketIdentityFromDetail(detail) {
  return {
    id: String(detail?.id || ''),
    localId: String(detail?.localId ?? ''),
    name: String(detail?.name || ''),
    category: String(detail?.category || ''),
    setId: String(detail?.set?.id || ''),
    setName: String(detail?.set?.name || ''),
    dexId: sortedNumberList(detail?.dexId),
    variants: detail?.variants && typeof detail.variants === 'object' ? detail.variants : {},
    image: String(detail?.image || ''),
    rarity: String(detail?.rarity || ''),
    illustrator: String(detail?.illustrator || ''),
  };
}

function cardmarketValidation(card, remote, kind) {
  const checks = [];
  const add = (key, label, ok) => checks.push({ key, label, ok: Boolean(ok) });
  const localPokemon = sortedNumberList(card?.pokemonIds);
  const remotePokemon = sortedNumberList(remote?.dexId);
  const variants = remote?.variants || {};

  add('id', 'identificador exato da carta', String(remote?.id || '') === String(card?.id || ''));
  add('setId', 'coleção exata', String(remote?.setId || '') === String(card?.setId || ''));
  add('setName', 'nome da coleção', normalize(remote?.setName) === normalize(card?.setName));
  add('number', 'número de colecionador', normalizeCollectorId(remote?.localId) === normalizeCollectorId(card?.localId));
  add('name', 'nome exato da carta', normalize(remote?.name) === normalize(card?.name));
  if (localPokemon.length) add('pokedex', 'número da Pokédex', sameNumberList(localPokemon, remotePokemon));

  const localImage = canonicalImageBase(card?.imageUrl);
  const remoteImage = canonicalImageBase(remote?.image);
  add('art', 'arte vinculada ao mesmo registro', Boolean(localImage && remoteImage && localImage === remoteImage));

  let finishOk = false;
  let finishReason = 'acabamento disponível';
  if (kind === 'normal') {
    finishOk = variants.normal === true;
  } else if (kind === 'reverse') {
    finishOk = variants.reverse === true && variants.holo !== true;
    if (variants.reverse === true && variants.holo === true) finishReason = 'Cardmarket agrupa reversa e holográfica no mesmo preço foil';
  } else if (kind === 'holo') {
    finishOk = variants.holo === true && variants.reverse !== true;
    if (variants.holo === true && variants.reverse === true) finishReason = 'Cardmarket agrupa holográfica e reversa no mesmo preço foil';
  }
  add('finish', finishReason, finishOk);

  const failed = checks.filter(item => !item.ok);
  return {
    verified: failed.length === 0,
    confidence: failed.length === 0 ? 'verified' : 'review',
    checks,
    reasons: failed.map(item => item.label),
  };
}

function cardmarketMetric(cardmarket, kind) {
  const holo = kind === 'holo' || kind === 'reverse';
  const candidates = holo ? [
    ['avg-holo', 'média de vendas foil'],
    ['avg7-holo', 'média foil de 7 dias'],
    ['trend-holo', 'tendência foil'],
    ['avg30-holo', 'média foil de 30 dias'],
    ['avg1-holo', 'média foil de 24 horas'],
    ['low-holo', 'menor oferta foil'],
  ] : [
    ['avg', 'média de vendas'],
    ['avg7', 'média de 7 dias'],
    ['trend', 'preço de tendência'],
    ['avg30', 'média de 30 dias'],
    ['avg1', 'média de 24 horas'],
    ['low', 'menor oferta'],
  ];
  for (const [field, label] of candidates) {
    if (hasFiniteNumber(cardmarket?.[field]) && Number(cardmarket[field]) >= 0) {
      return { field, label, value: Number(cardmarket[field]) };
    }
  }
  return null;
}

function cardmarketAverageQuote(cardmarket, kind, card, remoteIdentity) {
  if (!cardmarket || typeof cardmarket !== 'object' || !card || !remoteIdentity) return null;
  const metric = cardmarketMetric(cardmarket, kind);
  if (!metric) return null;
  const validation = exactRemoteValidation(card, remoteIdentity, kind);
  const finishLabel = kind === 'reverse' ? 'reversa' : kind === 'holo' ? 'holográfica/foil' : 'comum';
  const fingerprint = [
    card.id, kind, metric.field, metric.value, cardmarket.unit || 'EUR', cardmarket.updated || '',
    remoteIdentity.id, remoteIdentity.setId, remoteIdentity.localId, validation.confidence,
  ].join('|');
  return {
    value: metric.value,
    currency: cardmarket.unit || 'EUR',
    label: `Cardmarket ${metric.label} · ${finishLabel}`,
    source: 'cardmarket',
    provider: 'Cardmarket via TCGdex',
    updated: cardmarket.updated || null,
    confidence: validation.confidence,
    verified: validation.verified,
    validation,
    fingerprint,
    metric: metric.field,
  };
}

function fxRate(currency) {
  if (currency === 'BRL') return 1;
  const item = fxCache[currency];
  return hasFiniteNumber(item?.rate) ? Number(item.rate) : null;
}

function automaticPriceQuote(cardId, finish = 'comum') {
  const cached = priceCache[cardId];
  const card = cardMap.get(cardId);
  if (!cached || !card) return null;
  const kind = finishKind(finish);

  const ligaQuote = ligaPokemonAverageQuote(cached.ligaPokemon, kind);
  if (ligaQuote) {
    return {
      ...ligaQuote,
      brl: ligaQuote.value,
      rate: 1,
      fetchedAt: cached.fetchedAt || null,
      confidence: 'verified', verified: true, usable: true,
      fingerprint: [card.id, card.setId, card.localId, kind, ligaQuote.value, 'liga'].join('|'),
      validation: { reasons: [], checks: [
        { key: 'local-id', label: 'identificação pelo catálogo local', ok: true },
        { key: 'set', label: 'coleção exata', ok: true },
        { key: 'number', label: 'número de colecionador exato', ok: true },
      ] },
    };
  }

  const remote = cached.tcgDexIdentity;
  const cm = quoteInBrl(cardmarketAverageQuote(cached.cardmarket, kind, card, remote), cached.fetchedAt);
  const tp = quoteInBrl(tcgplayerAverageQuote(cached.tcgplayer, kind, card, remote), cached.fetchedAt);
  const verified = [cm, tp].filter(item => item?.verified && hasFiniteNumber(item.brl));
  if (verified.length >= 2) {
    const brl = Math.round((verified.reduce((sum, item) => sum + Number(item.brl), 0) / verified.length) * 100) / 100;
    return {
      brl,
      value: brl,
      currency: 'BRL',
      rate: 1,
      label: `Média internacional · ${verified.map(item => item.source === 'cardmarket' ? 'Cardmarket' : 'TCGplayer').join(' + ')}`,
      source: 'multifonte',
      provider: 'TCGdex · múltiplos mercados',
      fetchedAt: cached.fetchedAt || null,
      confidence: 'verified', verified: true, usable: true,
      fingerprint: [card.id, kind, ...verified.map(item => item.fingerprint)].join('|'),
      validation: { reasons: [], checks: verified.flatMap(item => item.validation?.checks || []) },
    };
  }
  return verified[0] || cm || tp || null;
}

function legacyPriceQuote(cardId) {
  const value = entryFor(cardId).priceBrl;
  return hasFiniteNumber(value) ? { brl: Number(value), label: 'Preço antigo importado', legacy: true } : null;
}

function storedAutomaticPriceQuote(variant) {
  if (!hasFiniteNumber(variant?.automaticEstimatedValue)) return null;
  const confidence = variant.automaticPriceConfidence || 'review';
  const userValidated = Boolean(variant.automaticPriceUserValidated)
    && Boolean(variant.automaticPriceFingerprint)
    && variant.automaticPriceFingerprint === variant.automaticPriceAcceptedFingerprint;
  return {
    brl: Number(variant.automaticEstimatedValue),
    label: variant.automaticPriceLabel || 'Liga Pokémon',
    source: variant.automaticPriceSource || 'ligapokemon',
    provider: variant.automaticPriceProvider || 'Marketplace Liga Pokémon',
    value: nullableNumber(variant.automaticPriceOriginalValue),
    currency: variant.automaticPriceCurrency || 'BRL',
    fetchedAt: variant.automaticPriceUpdatedAt || null,
    stored: true,
    confidence,
    verified: confidence === 'verified',
    userValidated,
    usable: confidence === 'verified' || userValidated,
    fingerprint: variant.automaticPriceFingerprint || '',
    validation: {
      reasons: Array.isArray(variant.automaticPriceValidationReasons) ? variant.automaticPriceValidationReasons : [],
      checks: Array.isArray(variant.automaticPriceValidationChecks) ? variant.automaticPriceValidationChecks : [],
    },
  };
}

function applyAutomaticPriceToVariant(cardId, variant) {
  if (!variant) return false;
  const quote = automaticPriceQuote(cardId, variant.finish || 'comum');
  if (!quote || !hasFiniteNumber(quote.brl)) return false;
  const nextValue = Math.round(Number(quote.brl) * 100) / 100;
  const nextUpdated = quote.fetchedAt ? new Date(Number(quote.fetchedAt)).toISOString() : new Date().toISOString();
  const previouslyAccepted = Boolean(variant.automaticPriceUserValidated)
    && variant.automaticPriceAcceptedFingerprint === quote.fingerprint;
  const nextUserValidated = quote.confidence === 'review' ? previouslyAccepted : false;
  const nextReasons = quote.validation?.reasons || [];
  const nextChecks = quote.validation?.checks || [];
  const changed = Number(variant.automaticEstimatedValue) !== nextValue
    || variant.automaticPriceSource !== quote.source
    || variant.automaticPriceLabel !== quote.label
    || variant.automaticPriceCurrency !== quote.currency
    || Number(variant.automaticPriceOriginalValue) !== Number(quote.value)
    || variant.automaticPriceUpdatedAt !== nextUpdated
    || variant.automaticPriceConfidence !== quote.confidence
    || variant.automaticPriceFingerprint !== quote.fingerprint
    || Boolean(variant.automaticPriceUserValidated) !== nextUserValidated
    || JSON.stringify(variant.automaticPriceValidationReasons || []) !== JSON.stringify(nextReasons)
    || JSON.stringify(variant.automaticPriceValidationChecks || []) !== JSON.stringify(nextChecks);
  variant.automaticEstimatedValue = nextValue;
  variant.automaticPriceSource = quote.source || 'ligapokemon';
  variant.automaticPriceLabel = quote.label || 'Liga Pokémon';
  variant.automaticPriceProvider = quote.provider || 'Marketplace Liga Pokémon';
  variant.automaticPriceOriginalValue = nullableNumber(quote.value);
  variant.automaticPriceCurrency = quote.currency || 'BRL';
  variant.automaticPriceUpdatedAt = nextUpdated;
  variant.automaticPriceConfidence = quote.confidence;
  variant.automaticPriceFingerprint = quote.fingerprint;
  variant.automaticPriceValidationReasons = nextReasons;
  variant.automaticPriceValidationChecks = nextChecks;
  variant.automaticPriceUserValidated = nextUserValidated;
  if (!nextUserValidated) variant.automaticPriceAcceptedFingerprint = '';
  return changed;
}

function persistAutomaticPricesForCard(cardId, save = true) {
  const entry = state?.entries?.[cardId];
  if (!entry || !Array.isArray(entry.variants) || !entry.variants.length) return false;
  let changed = false;
  for (const variant of entry.variants) changed = applyAutomaticPriceToVariant(cardId, variant) || changed;
  if (changed) {
    syncEntry(cardId);
    if (save) saveState();
  }
  return changed;
}

function effectiveVariantPrice(cardId, variant) {
  if (hasFiniteNumber(variant?.manualEstimatedValue)) {
    return { brl: Number(variant.manualEstimatedValue), label: 'Valor manual', manual: true, usable: true };
  }
  const stored = storedAutomaticPriceQuote(variant);
  if (stored?.usable) return stored;
  const live = automaticPriceQuote(cardId, variant?.finish || 'comum');
  if (live?.confidence === 'verified') return { ...live, usable: true };
  if (live && variant?.automaticPriceUserValidated && variant?.automaticPriceAcceptedFingerprint === live.fingerprint) {
    return { ...live, userValidated: true, usable: true };
  }
  return null;
}

function priceBadgeForCard(cardId) {
  const variants = variantsFor(cardId);
  const ownedVariant = variants.find(item => Number(item.quantity) > 0 && effectiveVariantPrice(cardId, item)?.brl != null);
  const fallbackVariant = variants.find(item => effectiveVariantPrice(cardId, item)?.brl != null);
  const quote = ownedVariant ? effectiveVariantPrice(cardId, ownedVariant)
    : fallbackVariant ? effectiveVariantPrice(cardId, fallbackVariant)
    : automaticPriceQuote(cardId, 'comum');
  return quote?.brl != null ? money(quote.brl) : null;
}

function formatPriceDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'data indisponível';
}

async function loadFxRates(force = false) {
  const currencies = ['EUR', 'USD'];
  const pending = currencies.filter(currency => force || !fxCache[currency] || Date.now() - Number(fxCache[currency].fetchedAt || 0) >= FX_CACHE_TTL);
  if (!pending.length) return fxCache;
  const results = await Promise.allSettled(pending.map(async currency => {
    const data = await fetchJsonWithTimeout(`${FX_API_BASE}/rate/${currency}/BRL`, 20000);
    if (!hasFiniteNumber(data?.rate)) throw new Error(`Cotação ${currency}/BRL indisponível`);
    return [currency, { rate: Number(data.rate), date: data.date || null, fetchedAt: Date.now() }];
  }));
  for (const result of results) {
    if (result.status === 'fulfilled') fxCache[result.value[0]] = result.value[1];
  }
  saveFxCache();
  return fxCache;
}

async function fetchCardPricing(cardId, force = false) {
  if (!force && priceCacheFresh(cardId)) return priceCache[cardId];
  if (priceRequests.has(cardId)) return priceRequests.get(cardId);
  const request = (async () => {
    const card = cardMap.get(cardId);
    if (!card) throw new Error('Carta não encontrada no catálogo local.');
    try { await loadFxRates(false); } catch (_) {}
    const [tcgResult, ligaResult] = await Promise.allSettled([
      fetchTcgDexPricing(cardId),
      fetchLigaPokemonPricing(cardId),
    ]);
    const tcg = tcgResult.status === 'fulfilled' ? tcgResult.value : null;
    const ligaPokemon = ligaResult.status === 'fulfilled' ? ligaResult.value : null;
    const errors = [];
    if (tcgResult.status === 'rejected') errors.push(String(tcgResult.reason?.message || tcgResult.reason));
    if (ligaResult.status === 'rejected') errors.push(String(ligaResult.reason?.message || ligaResult.reason));
    if (!ligaPokemon && !tcg?.cardmarket && !tcg?.tcgplayer) throw new Error(errors.join(' | ') || 'Nenhuma fonte retornou preço.');
    priceCache[cardId] = {
      logicVersion: PRICE_LOGIC_VERSION,
      fetchedAt: Date.now(),
      ligaPokemon,
      cardmarket: tcg?.cardmarket || null,
      tcgplayer: tcg?.tcgplayer || null,
      tcgDexIdentity: tcg?.identity || null,
      diagnostics: errors,
      identity: { id: card.id, setId: card.setId, localId: card.localId, name: card.name },
    };
    savePriceCache();
    return priceCache[cardId];
  })().finally(() => priceRequests.delete(cardId));
  priceRequests.set(cardId, request);
  return request;
}

function notify(message) {
  if (window.Android?.toast) window.Android.toast(message);
}

async function loadJson(path) {
  if (path.endsWith('catalog.json') && window.__CATALOG__) return window.__CATALOG__;
  if (path.endsWith('pokedex.json') && window.__POKEDEX__) return window.__POKEDEX__;
  if (path.endsWith('collection-seed.json') && window.__COLLECTION_SEED__) return window.__COLLECTION_SEED__;
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Falha ao carregar ${path}`);
  return response.json();
}

function openCatalogDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('O armazenamento de atualizações não está disponível neste aparelho.'));
      return;
    }
    const request = indexedDB.open(CATALOG_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CATALOG_DB_STORE)) {
        database.createObjectStore(CATALOG_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Falha ao abrir o catálogo local.'));
  });
}

async function readUpdatedCatalog() {
  let database;
  try {
    database = await openCatalogDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(CATALOG_DB_STORE, 'readonly');
      const request = transaction.objectStore(CATALOG_DB_STORE).get(CATALOG_DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Falha ao ler a atualização.'));
    });
  } catch (_) {
    return null;
  } finally {
    try { database?.close(); } catch (_) {}
  }
}

async function saveUpdatedCatalog(value) {
  const database = await openCatalogDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(CATALOG_DB_STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Falha ao salvar a atualização.'));
      transaction.onabort = () => reject(transaction.error || new Error('Atualização cancelada ao salvar.'));
      transaction.objectStore(CATALOG_DB_STORE).put(value, CATALOG_DB_KEY);
    });
  } finally {
    database.close();
  }
}

function loadCatalogUpdateMeta() {
  try {
    return JSON.parse(localStorage.getItem(CATALOG_META_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function saveCatalogUpdateMeta(value) {
  catalogUpdateMeta = value || {};
  try { localStorage.setItem(CATALOG_META_KEY, JSON.stringify(catalogUpdateMeta)); } catch (_) {}
}

async function loadCatalogData() {
  const bundled = await loadJson('data/catalog.json');
  const updated = await readUpdatedCatalog();
  return updated?.cards?.length && updated?.sets?.length ? updated : bundled;
}

function inferPokemonIds(cardName) {
  const normalized = normalize(cardName);
  if (!normalized) return [];
  const found = [];
  for (const item of pokemonNameIndex) {
    const pattern = item.normalized;
    if (normalized === pattern || normalized.startsWith(`${pattern} `) || normalized.includes(` ${pattern} `)) {
      found.push(item.id);
    }
  }
  return [...new Set(found)];
}

function rebuildCatalogIndexes() {
  cards = Array.isArray(catalog?.cards) ? catalog.cards : [];
  catalog.sets = Array.isArray(catalog?.sets) ? catalog.sets : [];
  pokemonMap = new Map(pokedex.map(item => [item.id, item]));
  pokemonNameIndex = pokedex
    .map(item => ({ id: item.id, normalized: normalize(item.name) }))
    .filter(item => item.normalized)
    .sort((a, b) => b.normalized.length - a.normalized.length);
  for (const card of cards) {
    if (!Array.isArray(card.pokemonIds) || !card.pokemonIds.length) card.pokemonIds = inferPokemonIds(card.name);
  }
  cardMap = new Map(cards.map(card => [card.id, card]));
  pokemonCards = new Map(pokedex.map(item => [item.id, []]));
  for (const card of cards) {
    for (const pokemonId of card.pokemonIds || []) {
      if (pokemonCards.has(pokemonId)) pokemonCards.get(pokemonId).push(card.id);
    }
  }
}

async function init() {
  try {
    [catalog, pokedex, seed] = await Promise.all([
      loadCatalogData(),
      loadJson('data/pokedex.json'),
      loadJson('data/collection-seed.json'),
    ]);
    rebuildCatalogIndexes();
    catalogUpdateMeta = loadCatalogUpdateMeta();
    catalogUpdating = false;
    loadPricingState();
    state = loadState();
    // Ao mudar para a média brasileira, removemos uma vez os valores internacionais antigos.
    const storedLogicVersion = Number(localStorage.getItem(PRICE_LOGIC_VERSION_KEY) || 0);
    if (storedLogicVersion < PRICE_LOGIC_VERSION) {
      let cleared = false;
      for (const entry of Object.values(state.entries || {})) {
        for (const variant of entry.variants || []) {
          if (variant.manualEstimatedValue != null) continue;
          if (variant.automaticEstimatedValue != null || variant.automaticPriceSource) {
            variant.automaticEstimatedValue = null;
            variant.automaticPriceSource = '';
            variant.automaticPriceLabel = '';
            variant.automaticPriceProvider = '';
            variant.automaticPriceOriginalValue = null;
            variant.automaticPriceCurrency = '';
            variant.automaticPriceUpdatedAt = null;
            variant.automaticPriceConfidence = '';
            variant.automaticPriceFingerprint = '';
            variant.automaticPriceValidationReasons = [];
            variant.automaticPriceValidationChecks = [];
            variant.automaticPriceUserValidated = false;
            variant.automaticPriceAcceptedFingerprint = '';
            variant.automaticPriceUserValidatedAt = null;
            cleared = true;
          }
        }
      }
      if (cleared) saveState();
      localStorage.setItem(PRICE_LOGIC_VERSION_KEY, String(PRICE_LOGIC_VERSION));
    }
    // Apenas caches produzidos pela lógica atual podem ser persistidos.
    let migratedCachedPrices = false;
    for (const cardId of Object.keys(state.entries)) {
      if (priceCacheFresh(cardId)) migratedCachedPrices = persistAutomaticPricesForCard(cardId, false) || migratedCachedPrices;
    }
    if (migratedCachedPrices) saveState();
    renderTabs();
    render();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
  } catch (error) {
    document.getElementById('loading').innerHTML = `
      <strong>Não consegui abrir o fichário</strong>
      <span>${esc(error.message)}</span>`;
  }
}

function defaultVariant(quantity = 0, overrides = {}) {
  return {
    id: overrides.id || `v-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    quantity: Math.max(0, Math.trunc(Number(quantity) || 0)),
    language: overrides.language || 'Portugues BR',
    finish: overrides.finish || 'comum',
    condition: overrides.condition || 'Near Mint',
    storageLocation: overrides.storageLocation || 'fichario',
    isWishlist: Boolean(overrides.isWishlist),
    isForTrade: Boolean(overrides.isForTrade),
    isForSale: Boolean(overrides.isForSale),
    paidPrice: nullableNumber(overrides.paidPrice),
    manualEstimatedValue: nullableNumber(overrides.manualEstimatedValue),
    automaticEstimatedValue: nullableNumber(overrides.automaticEstimatedValue),
    automaticPriceSource: String(overrides.automaticPriceSource || ''),
    automaticPriceLabel: String(overrides.automaticPriceLabel || ''),
    automaticPriceProvider: String(overrides.automaticPriceProvider || ''),
    automaticPriceOriginalValue: nullableNumber(overrides.automaticPriceOriginalValue),
    automaticPriceCurrency: String(overrides.automaticPriceCurrency || ''),
    automaticPriceUpdatedAt: overrides.automaticPriceUpdatedAt || null,
    automaticPriceConfidence: String(overrides.automaticPriceConfidence || ''),
    automaticPriceFingerprint: String(overrides.automaticPriceFingerprint || ''),
    automaticPriceValidationReasons: Array.isArray(overrides.automaticPriceValidationReasons) ? overrides.automaticPriceValidationReasons : [],
    automaticPriceValidationChecks: Array.isArray(overrides.automaticPriceValidationChecks) ? overrides.automaticPriceValidationChecks : [],
    automaticPriceUserValidated: Boolean(overrides.automaticPriceUserValidated),
    automaticPriceAcceptedFingerprint: String(overrides.automaticPriceAcceptedFingerprint || ''),
    automaticPriceUserValidatedAt: overrides.automaticPriceUserValidatedAt || null,
    artConfirmed: Boolean(overrides.artConfirmed),
    notes: String(overrides.notes || ''),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
  };
}

function nullableNumber(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function syncEntry(cardId) {
  const entry = state.entries[cardId];
  if (!entry) return;
  entry.variants = Array.isArray(entry.variants) ? entry.variants : [];
  entry.quantity = entry.variants.reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.quantity) || 0)), 0);
  entry.wishlist = Boolean(entry.wishlist) || entry.variants.some(item => item.isWishlist);
  entry.forTrade = entry.variants.some(item => item.isForTrade);
  entry.forSale = entry.variants.some(item => item.isForSale);
  const hasMetadata = entry.variants.some(item => item.isWishlist || item.isForTrade || item.isForSale || item.artConfirmed || item.notes || item.paidPrice != null || item.manualEstimatedValue != null);
  if (entry.quantity === 0 && !entry.wishlist && !hasMetadata) delete state.entries[cardId];
}

function migrateState(saved) {
  if (!saved?.entries) return null;
  const migrated = { version: 2, entries: {}, decks: Array.isArray(saved.decks) ? saved.decks : [], importedAt: saved.importedAt || null };
  for (const [cardId, raw] of Object.entries(saved.entries)) {
    const entry = {
      priceBrl: nullableNumber(raw.priceBrl),
      wishlist: Boolean(raw.wishlist),
      variants: [],
    };
    if (Array.isArray(raw.variants) && raw.variants.length) {
      entry.variants = raw.variants.map(item => defaultVariant(item.quantity, item));
    } else if ((Number(raw.quantity) || 0) > 0 || raw.wishlist) {
      entry.variants = [defaultVariant(raw.quantity, {
        id: `imported-${cardId}`,
        isWishlist: Boolean(raw.wishlist),
        notes: 'Cadastro importado da versão anterior.',
      })];
    }
    migrated.entries[cardId] = entry;
  }
  state = migrated;
  for (const cardId of Object.keys(migrated.entries)) syncEntry(cardId);
  return migrated;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const migrated = migrateState(saved);
    if (migrated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch (_) {}
  // Instalações novas começam vazias. Dados pessoais nunca são distribuídos no APK.
  const initial = { version: 2, entries: {}, decks: [], importedAt: null };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
  return initial;
}

function saveState() {
  state.version = 2;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function entryFor(cardId) {
  return state.entries[cardId] || { quantity: 0, priceBrl: null, wishlist: false, variants: [] };
}

function variantsFor(cardId) {
  const entry = entryFor(cardId);
  return Array.isArray(entry.variants) ? entry.variants : [];
}

function quantityFor(cardId) {
  return variantsFor(cardId).reduce((sum, item) => sum + Math.max(0, Math.trunc(Number(item.quantity) || 0)), 0);
}

function primaryVariant(cardId, create = false) {
  let entry = state.entries[cardId];
  if (!entry && create) {
    entry = { quantity: 0, priceBrl: null, wishlist: false, variants: [] };
    state.entries[cardId] = entry;
  }
  if (!entry) return null;
  entry.variants = Array.isArray(entry.variants) ? entry.variants : [];
  if (!entry.variants.length && create) entry.variants.push(defaultVariant(0));
  return entry.variants[0] || null;
}

function setQuantity(cardId, nextQuantity) {
  const target = Math.max(0, Math.trunc(Number(nextQuantity) || 0));
  const current = quantityFor(cardId);
  let difference = target - current;
  if (difference > 0) {
    const variant = primaryVariant(cardId, true);
    variant.quantity += difference;
    variant.updatedAt = new Date().toISOString();
  } else if (difference < 0) {
    let remaining = Math.abs(difference);
    const variants = variantsFor(cardId);
    for (const variant of variants) {
      if (!remaining) break;
      const removable = Math.min(remaining, Math.max(0, Number(variant.quantity) || 0));
      variant.quantity -= removable;
      remaining -= removable;
      variant.updatedAt = new Date().toISOString();
    }
  }
  syncEntry(cardId);
  saveState();
  renderKeepingScroll();
}

function changeQuantity(event, cardId, delta) {
  event?.stopPropagation();
  setQuantity(cardId, quantityFor(cardId) + delta);
}

function toggleWishlist(cardId) {
  const entry = state.entries[cardId] || { quantity: 0, priceBrl: null, wishlist: false, variants: [] };
  state.entries[cardId] = entry;
  const next = !Boolean(entry.wishlist);
  entry.wishlist = next;
  const variant = primaryVariant(cardId, next);
  if (variant) variant.isWishlist = next;
  syncEntry(cardId);
  saveState();
  closeModal();
  renderKeepingScroll();
  notify(next ? 'Carta adicionada à wishlist' : 'Carta removida da wishlist');
}

function parseCurrencyInput(value) {
  let clean = String(value || '').trim().replace(/\s/g, '').replace('R$', '');
  if (!clean) return null;
  if (clean.includes(',')) clean = clean.replaceAll('.', '').replace(',', '.');
  const parsed = Number(clean);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatInputNumber(value) {
  return value == null || !Number.isFinite(Number(value)) ? '' : String(Number(value)).replace('.', ',');
}

function variantLabel(variant) {
  return `${variant.finish} · ${variant.language} · ${variant.condition} · x${Math.max(0, Number(variant.quantity) || 0)}`;
}

function saveCardVariant(cardId, variantId) {
  const card = cardMap.get(cardId);
  if (!card) return;
  const entry = state.entries[cardId] || { quantity: 0, priceBrl: null, wishlist: false, variants: [] };
  state.entries[cardId] = entry;
  entry.variants = Array.isArray(entry.variants) ? entry.variants : [];
  const index = variantId ? entry.variants.findIndex(item => item.id === variantId) : -1;
  const previous = index >= 0 ? entry.variants[index] : null;
  const quantity = Math.max(0, Math.trunc(Number(document.getElementById('regQuantity')?.value) || 0));
  const nextFinish = document.getElementById('regFinish')?.value || 'comum';
  const keepAutomatic = previous && finishKind(previous.finish) === finishKind(nextFinish);
  const draft = defaultVariant(quantity, {
    id: variantId || undefined,
    condition: document.getElementById('regCondition')?.value,
    finish: nextFinish,
    language: document.getElementById('regLanguage')?.value,
    storageLocation: document.getElementById('regStorage')?.value,
    isWishlist: document.getElementById('regWishlist')?.checked,
    isForTrade: document.getElementById('regTrade')?.checked,
    isForSale: document.getElementById('regSale')?.checked,
    artConfirmed: document.getElementById('regArt')?.checked,
    paidPrice: parseCurrencyInput(document.getElementById('regPaidPrice')?.value),
    manualEstimatedValue: parseCurrencyInput(document.getElementById('regManualValue')?.value),
    automaticEstimatedValue: keepAutomatic ? previous.automaticEstimatedValue : null,
    automaticPriceSource: keepAutomatic ? previous.automaticPriceSource : '',
    automaticPriceLabel: keepAutomatic ? previous.automaticPriceLabel : '',
    automaticPriceProvider: keepAutomatic ? previous.automaticPriceProvider : '',
    automaticPriceOriginalValue: keepAutomatic ? previous.automaticPriceOriginalValue : null,
    automaticPriceCurrency: keepAutomatic ? previous.automaticPriceCurrency : '',
    automaticPriceUpdatedAt: keepAutomatic ? previous.automaticPriceUpdatedAt : null,
    automaticPriceConfidence: keepAutomatic ? previous.automaticPriceConfidence : '',
    automaticPriceFingerprint: keepAutomatic ? previous.automaticPriceFingerprint : '',
    automaticPriceValidationReasons: keepAutomatic ? previous.automaticPriceValidationReasons : [],
    automaticPriceValidationChecks: keepAutomatic ? previous.automaticPriceValidationChecks : [],
    automaticPriceUserValidated: keepAutomatic ? previous.automaticPriceUserValidated : false,
    automaticPriceAcceptedFingerprint: keepAutomatic ? previous.automaticPriceAcceptedFingerprint : '',
    automaticPriceUserValidatedAt: keepAutomatic ? previous.automaticPriceUserValidatedAt : null,
    notes: document.getElementById('regNotes')?.value,
  });
  // Se já há preço consultado para este acabamento, ele é gravado junto do cadastro.
  applyAutomaticPriceToVariant(cardId, draft);
  if (index >= 0) entry.variants[index] = draft;
  else entry.variants.push(draft);
  entry.wishlist = entry.variants.some(item => item.isWishlist);
  syncEntry(cardId);
  saveState();
  render();
  openCard(cardId, draft.id);
  notify(index >= 0 ? 'Cadastro atualizado' : 'Nova variante cadastrada');
}

function deleteCardVariant(cardId, variantId) {
  const entry = state.entries[cardId];
  if (!entry) return;
  if (!window.confirm('Excluir esta variante da carta?')) return;
  entry.variants = variantsFor(cardId).filter(item => item.id !== variantId);
  entry.wishlist = entry.variants.some(item => item.isWishlist);
  syncEntry(cardId);
  saveState();
  render();
  const next = variantsFor(cardId)[0];
  openCard(cardId, next?.id || null);
  notify('Variante excluída');
}

function renderKeepingScroll() {
  const y = window.scrollY;
  render();
  requestAnimationFrame(() => window.scrollTo(0, y));
}

function renderTabs() {
  const root = document.getElementById('tabs');
  root.innerHTML = TAB_ITEMS.map(([value, label]) => `
    <button class="tab ${ui.tab === value ? 'active' : ''}" onclick="setTab('${value}')">${label}</button>
  `).join('');
}

function setTab(tab) {
  ui.tab = tab;
  ui.selectedPokemon = null;
  ui.cardLimit = 80;
  renderTabs();
  render();
  window.scrollTo(0, 0);
}

function render() {
  updateHeader();
  const content = document.getElementById('content');
  if (!content) return;
  if (ui.tab === 'dashboard') content.innerHTML = renderDashboard();
  else if (ui.tab === 'sets') content.innerHTML = renderSets();
  else if (ui.tab === 'pokedex') content.innerHTML = renderPokedex();
  else if (ui.tab === 'decks') content.innerHTML = renderDecks();
  else content.innerHTML = renderCards();
}

function updateHeader() {
  const cardIds = Object.keys(state.entries);
  const unique = cardIds.filter(cardId => quantityFor(cardId) > 0).length;
  const total = cardIds.reduce((sum, cardId) => sum + quantityFor(cardId), 0);
  document.getElementById('header-status').textContent = `${unique} cartas únicas · ${total} cartas no total`;
}

function collectionSummary() {
  let totalCopies = 0;
  let uniqueOwned = 0;
  let repeated = 0;
  let wishlist = 0;
  let estimatedValue = 0;
  for (const [cardId, entry] of Object.entries(state.entries)) {
    const quantity = quantityFor(cardId);
    totalCopies += quantity;
    if (quantity > 0) uniqueOwned++;
    if (quantity > 1) repeated += quantity - 1;
    if (entry.wishlist) wishlist++;
    if (quantity > 0) {
      const variants = variantsFor(cardId);
      if (variants.length) {
        for (const variant of variants) {
          const variantQuantity = Math.max(0, Math.trunc(Number(variant.quantity) || 0));
          const quote = effectiveVariantPrice(cardId, variant);
          if (variantQuantity && quote?.brl != null) estimatedValue += Number(quote.brl) * variantQuantity;
        }
      } else if (hasFiniteNumber(entry.priceBrl)) {
        estimatedValue += Number(entry.priceBrl) * quantity;
      }
    }
  }
  const pokemonStats = buildPokemonStats();
  const pokemonOwned = [...pokemonStats.values()].filter(item => item.copies > 0).length;
  return { totalCopies, uniqueOwned, repeated, wishlist, estimatedValue, pokemonOwned };
}

function buildPokemonStats() {
  const stats = new Map(pokedex.map(item => [item.id, { copies: 0, cardIds: new Set() }]));
  for (const [cardId, entry] of Object.entries(state.entries)) {
    const quantity = quantityFor(cardId);
    if (!quantity) continue;
    const card = cardMap.get(cardId);
    if (!card) continue;
    for (const pokemonId of card.pokemonIds || []) {
      const item = stats.get(pokemonId);
      if (!item) continue;
      item.copies += quantity;
      item.cardIds.add(cardId);
    }
  }
  return stats;
}


function pricedOwnedCount() {
  let priced = 0;
  let owned = 0;
  let pending = 0;
  for (const cardId of Object.keys(state.entries)) {
    if (quantityFor(cardId) <= 0) continue;
    owned++;
    const variants = variantsFor(cardId);
    const hasPrice = variants.length
      ? variants.some(variant => effectiveVariantPrice(cardId, variant)?.brl != null)
      : automaticPriceQuote(cardId, 'comum')?.confidence === 'verified';
    if (hasPrice) priced++;
    if (variants.some(variant => {
      const stored = storedAutomaticPriceQuote(variant);
      return stored && stored.confidence === 'review' && !stored.userValidated;
    })) pending++;
  }
  return { priced, owned, pending };
}

function latestPriceFetch() {
  return Object.values(priceCache).reduce((latest, item) => Math.max(latest, Number(item?.fetchedAt) || 0), 0);
}

function pricingPanel() {
  const counts = pricedOwnedCount();
  const progress = priceUpdateTotal > 0 ? Math.max(0, Math.min(100, Math.round((priceUpdateCurrent / priceUpdateTotal) * 100))) : 0;
  const latest = latestPriceFetch();
  return `<section class="price-update-card">
    <div class="catalog-update-heading">
      <div><strong>Preços brasileiros</strong><span>${counts.priced} de ${counts.owned} cartas próprias com valor aceito${counts.pending ? ` · ${counts.pending} aguardando validação` : ''}${latest ? ` · última consulta ${esc(formatPriceDate(latest))}` : ''}</span></div>
      <span class="online-badge">Liga + Cardmarket + TCGplayer</span>
    </div>
    <p>Prioridade: valor manual → Liga Pokémon → média Cardmarket/TCGplayer via TCGdex. A identificação usa coleção e número exatos do catálogo local.</p>
    ${priceUpdating ? `<div class="catalog-progress"><div class="progress"><span style="width:${progress}%"></span></div><small>${esc(priceUpdateMessage || 'Consultando preços...')}</small></div>` : ''}
    <button class="primary-btn" ${priceUpdating ? 'disabled' : ''} onclick="startOwnedPriceUpdate()">${priceUpdating ? 'Atualizando...' : 'Atualizar preços da coleção'}</button>
    ${priceUpdateFailures ? `<div class="catalog-last-result">${priceUpdateFailures} carta(s) não retornaram preço em nenhuma fonte nesta tentativa.</div>` : ''}
  </section>`;
}

function setPriceUpdateProgress(message, current, total) {
  priceUpdateMessage = String(message || 'Consultando preços...');
  priceUpdateCurrent = Number(current) || 0;
  priceUpdateTotal = Math.max(1, Number(total) || 1);
  if (ui.tab === 'dashboard' && (current === 0 || current === total || current % 8 === 0)) renderKeepingScroll();
}

async function startOwnedPriceUpdate() {
  if (priceUpdating) return;
  const ownedIds = Object.keys(state.entries).filter(cardId => quantityFor(cardId) > 0 && cardMap.has(cardId));
  if (!ownedIds.length) return notify('Nenhuma carta cadastrada para atualizar.');
  priceUpdating = true;
  priceUpdateFailures = 0;
  setPriceUpdateProgress('Atualizando cotações para reais...', 0, ownedIds.length);
  try { await loadFxRates(false); } catch (_) {}

  // Migra imediatamente os preços já consultados no Checkpoint 4 para dentro das cartas.
  let restoredFromCache = 0;
  for (const cardId of ownedIds) {
    if (priceCache[cardId] && persistAutomaticPricesForCard(cardId, false)) restoredFromCache++;
  }
  if (restoredFromCache) saveState();

  const targets = ownedIds.filter(cardId => !priceCacheFresh(cardId));
  if (!targets.length) {
    priceUpdating = false;
    priceUpdateMessage = '';
    renderKeepingScroll();
    notify(restoredFromCache
      ? `${restoredFromCache} preço(s) foram salvos nas cartas.`
      : 'Os preços já foram consultados e estão salvos nas cartas.');
    return;
  }

  priceUpdateTotal = targets.length;
  let cursor = 0;
  let completed = 0;
  let savedCards = restoredFromCache;
  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor++;
      const cardId = targets[index];
      const card = cardMap.get(cardId);
      setPriceUpdateProgress(`Consultando ${card?.name || cardId}...`, completed, targets.length);
      try {
        await fetchCardPricing(cardId, true);
        if (persistAutomaticPricesForCard(cardId, false)) savedCards++;
      } catch (_) {
        priceUpdateFailures++;
      }
      completed++;
      await new Promise(resolve => setTimeout(resolve, 350));
      if (completed % 10 === 0 || completed === targets.length) saveState();
      setPriceUpdateProgress(`Preços salvos: ${completed} de ${targets.length}`, completed, targets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
  saveState();
  priceUpdating = false;
  priceUpdateMessage = '';
  renderKeepingScroll();
  notify(`Preços consultados: ${targets.length - priceUpdateFailures} · salvos nas cartas: ${savedCards}${priceUpdateFailures ? ` · ${priceUpdateFailures} falha(s)` : ''}.`);
}

function renderDashboard() {
  const summary = collectionSummary();
  const setStats = buildSetStats().filter(item => item.ownedUnique > 0)
    .sort((a, b) => b.progress - a.progress || b.ownedUnique - a.ownedUnique).slice(0, 10);
  return `
    <section class="screen">
      <h2 class="screen-title">Sua coleção</h2>
      <p class="screen-subtitle">Cópia importada do Fichário Pokémon BR e salva somente neste celular.</p>
      <div class="stats-grid">
        ${statCard(summary.totalCopies, 'Cartas cadastradas')}
        ${statCard(summary.uniqueOwned, 'Cartas únicas que tenho')}
        ${statCard(summary.pokemonOwned, 'Pokémon encontrados')}
        ${statCard(summary.repeated, 'Cartas repetidas')}
        ${statCard(summary.wishlist, 'Wishlist')}
        ${statCard(money(summary.estimatedValue), 'Valor estimado', true)}
      </div>
      ${pricingPanel()}
      <div class="notice"><strong>Pokédex automática:</strong> ao aumentar ou diminuir uma carta, o Pokémon correspondente é atualizado na mesma hora.</div>
      <button class="secondary-btn" onclick="setTab('pokedex')">Abrir Pokédex</button>
      <h3 class="section-title">Coleções mais completas</h3>
      <div class="set-list">
        ${setStats.length ? setStats.map(renderSetCard).join('') : '<div class="empty">Nenhuma coleção cadastrada.</div>'}
      </div>
    </section>`;
}

function statCard(value, label, wide = false) {
  return `<div class="stat-card ${wide ? 'wide' : ''}"><span class="stat-value">${esc(value)}</span><span class="stat-label">${esc(label)}</span></div>`;
}

function buildSetStats() {
  const stats = new Map(catalog.sets.map(set => [set.id, {
    ...set, ownedUnique: 0, ownedCopies: 0, progress: 0,
  }]));
  for (const [cardId, entry] of Object.entries(state.entries)) {
    const quantity = quantityFor(cardId);
    if (!quantity) continue;
    const card = cardMap.get(cardId);
    if (!card) continue;
    if (!stats.has(card.setId)) {
      stats.set(card.setId, { id: card.setId, name: card.setName, officialCardCount: 0, totalCardCount: 0, ownedUnique: 0, ownedCopies: 0, progress: 0 });
    }
    const item = stats.get(card.setId);
    item.ownedUnique++;
    item.ownedCopies += quantity;
  }
  for (const item of stats.values()) {
    const total = item.officialCardCount || item.totalCardCount || 1;
    item.progress = Math.min(100, Math.round((item.ownedUnique / total) * 100));
  }
  return [...stats.values()];
}

function formatCatalogUpdateDate(value) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : 'Ainda não atualizado online';
}

function catalogUpdatePanel() {
  const progress = catalogUpdateTotal > 0
    ? Math.max(0, Math.min(100, Math.round((catalogUpdateCurrent / catalogUpdateTotal) * 100)))
    : 0;
  const lastResult = catalogUpdateMeta.updatedAt
    ? `${formatCatalogUpdateDate(catalogUpdateMeta.updatedAt)} · ${catalogUpdateMeta.setsTotal || catalog.sets.length} coleções · ${catalogUpdateMeta.cardsTotal || cards.length} cartas`
    : `${catalog.sets.length} coleções e ${cards.length} cartas disponíveis no catálogo instalado.`;
  return `<section class="catalog-update-card">
    <div class="catalog-update-heading">
      <div><strong>Atualização das coleções</strong><span>${esc(lastResult)}</span></div>
      <span class="online-badge">TCGdex PT-BR</span>
    </div>
    <p>Verifica novas expansões e cartas sem apagar quantidades, variantes, observações ou outros dados da sua coleção.</p>
    ${catalogUpdating ? `<div class="catalog-progress"><div class="progress"><span style="width:${progress}%"></span></div><small>${esc(catalogUpdateMessage || 'Preparando atualização...')}</small></div>` : ''}
    <button class="primary-btn" ${catalogUpdating ? 'disabled' : ''} onclick="startCatalogUpdate()">${catalogUpdating ? 'Atualizando...' : 'Verificar novas coleções'}</button>
    ${catalogUpdateMeta.cardsAdded || catalogUpdateMeta.setsAdded ? `<div class="catalog-last-result">Último resultado: +${catalogUpdateMeta.setsAdded || 0} coleções · +${catalogUpdateMeta.cardsAdded || 0} cartas</div>` : ''}
  </section>`;
}

function setCatalogUpdateProgress(message, current, total, forceRender = false) {
  catalogUpdateMessage = String(message || 'Atualizando...');
  catalogUpdateCurrent = Number(current) || 0;
  catalogUpdateTotal = Math.max(1, Number(total) || 1);
  if (ui.tab === 'sets' && (forceRender || current === 0 || current === total || current % 3 === 0)) {
    renderKeepingScroll();
  }
}

function fetchJsonWithTimeout(url, timeoutMs = 30000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), timeoutMs);
  return fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: controller?.signal,
  }).then(response => {
    if (!response.ok) throw new Error(`Servidor respondeu ${response.status}`);
    return response.json();
  }).finally(() => clearTimeout(timeout));
}

function remoteSetCounts(remote) {
  const counts = remote?.cardCount || {};
  return {
    total: Number(counts.total) || Number(remote?.totalCardCount) || 0,
    official: Number(counts.official) || Number(remote?.officialCardCount) || 0,
  };
}

function setNeedsCatalogRefresh(local, remote) {
  if (!local) return true;
  const counts = remoteSetCounts(remote);
  return counts.total !== Number(local.totalCardCount || 0)
    || counts.official !== Number(local.officialCardCount || 0)
    || (remote.name != null && String(remote.name) !== String(local.name || ''))
    || (remote.logo != null && String(remote.logo) !== String(local.logoUrl || ''))
    || (remote.symbol != null && String(remote.symbol) !== String(local.symbolUrl || ''));
}

function cardImageUrl(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  if (/\.(webp|png|jpe?g)(\?.*)?$/i.test(source)) return source;
  return `${source.replace(/\/$/, '')}/low.webp`;
}

function normalizeRemoteSet(detail, fallback) {
  const counts = remoteSetCounts(detail?.cardCount ? detail : fallback);
  const cardsInSet = Array.isArray(detail?.cards) ? detail.cards : [];
  return {
    id: String(detail?.id || fallback?.id || ''),
    name: String(detail?.name || fallback?.name || detail?.id || fallback?.id || 'Coleção'),
    officialCardCount: counts.official || cardsInSet.length,
    totalCardCount: counts.total || cardsInSet.length,
    logoUrl: detail?.logo || fallback?.logo || null,
    symbolUrl: detail?.symbol || fallback?.symbol || null,
    releaseDate: detail?.releaseDate || null,
    seriesName: detail?.serie?.name || detail?.serie?.id || null,
    tcgOnline: detail?.tcgOnline || fallback?.tcgOnline || null,
  };
}

function normalizeRemoteCard(remote, set) {
  const localId = String(remote?.localId || '').trim();
  const official = Number(set.officialCardCount || 0);
  return {
    id: String(remote?.id || `${set.id}-${localId}`),
    localId,
    name: String(remote?.name || 'Carta sem nome'),
    setId: set.id,
    setName: set.name,
    number: official ? `${localId}/${official}` : localId,
    rarity: remote?.rarity || null,
    imageUrl: cardImageUrl(remote?.image),
    pokemonIds: inferPokemonIds(remote?.name),
  };
}

async function startCatalogUpdate() {
  if (catalogUpdating) return;
  catalogUpdating = true;
  setCatalogUpdateProgress('Conectando ao catálogo TCGdex...', 0, 1, true);

  try {
    const remoteSets = await fetchJsonWithTimeout(`${TCGDEX_API_BASE}/sets`);
    if (!Array.isArray(remoteSets)) throw new Error('O servidor retornou uma lista inválida.');

    const localSetMap = new Map((catalog.sets || []).map(item => [item.id, item]));
    const setMap = new Map((catalog.sets || []).map(item => [item.id, { ...item }]));
    const cardMapForUpdate = new Map((catalog.cards || []).map(item => [item.id, { ...item }]));
    const changed = remoteSets.filter(remote => remote?.id && setNeedsCatalogRefresh(localSetMap.get(remote.id), remote));
    const setsAdded = changed.filter(remote => !localSetMap.has(remote.id)).length;
    const oldCardCount = cardMapForUpdate.size;
    let setsUpdated = 0;
    let failures = 0;

    if (!changed.length) {
      const result = {
        updatedAt: Date.now(), setsAdded: 0, setsUpdated: 0, cardsAdded: 0,
        setsTotal: setMap.size, cardsTotal: cardMapForUpdate.size,
      };
      saveCatalogUpdateMeta(result);
      catalogUpdating = false;
      catalogUpdateMessage = '';
      renderKeepingScroll();
      notify('O catálogo já está atualizado.');
      return;
    }

    catalogUpdateTotal = changed.length;
    for (let index = 0; index < changed.length; index++) {
      const remote = changed[index];
      setCatalogUpdateProgress(`Baixando ${remote.name || remote.id}...`, index, changed.length);
      try {
        const detail = await fetchJsonWithTimeout(`${TCGDEX_API_BASE}/sets/${encodeURIComponent(remote.id)}`);
        const set = normalizeRemoteSet(detail, remote);
        if (!set.id) throw new Error('Coleção sem identificador.');
        setMap.set(set.id, set);
        const remoteCards = Array.isArray(detail?.cards) ? detail.cards : [];
        for (const remoteCard of remoteCards) {
          const normalized = normalizeRemoteCard(remoteCard, set);
          if (!normalized.id) continue;
          const existing = cardMapForUpdate.get(normalized.id) || {};
          cardMapForUpdate.set(normalized.id, {
            ...existing,
            ...normalized,
            rarity: normalized.rarity || existing.rarity || null,
            imageUrl: normalized.imageUrl || existing.imageUrl || null,
            pokemonIds: normalized.pokemonIds?.length ? normalized.pokemonIds : (existing.pokemonIds || []),
          });
        }
        setsUpdated++;
      } catch (_) {
        failures++;
      }
      setCatalogUpdateProgress(`Processando ${remote.name || remote.id}...`, index + 1, changed.length);
    }

    if (!setsUpdated && failures) throw new Error('Não foi possível baixar as coleções alteradas.');

    const updatedCatalog = {
      version: new Date().toISOString(),
      source: 'TCGdex PT-BR + catálogo local',
      sets: [...setMap.values()],
      cards: [...cardMapForUpdate.values()],
    };
    setCatalogUpdateProgress('Salvando o catálogo para uso offline...', changed.length, changed.length, true);
    await saveUpdatedCatalog(updatedCatalog);
    catalog = updatedCatalog;
    rebuildCatalogIndexes();

    const result = {
      updatedAt: Date.now(),
      setsAdded,
      setsUpdated,
      cardsAdded: Math.max(0, cardMapForUpdate.size - oldCardCount),
      setsTotal: setMap.size,
      cardsTotal: cardMapForUpdate.size,
      failures,
    };
    saveCatalogUpdateMeta(result);
    ui.cardLimit = 80;
    catalogUpdating = false;
    catalogUpdateMessage = '';
    render();
    const warning = failures ? ` (${failures} coleção(ões) não responderam)` : '';
    notify(`Coleções atualizadas: +${result.setsAdded} coleções e +${result.cardsAdded} cartas${warning}.`);
  } catch (error) {
    catalogUpdating = false;
    catalogUpdateMessage = '';
    renderKeepingScroll();
    const message = error?.name === 'AbortError'
      ? 'A conexão demorou demais. Tente novamente.'
      : `Não foi possível atualizar: ${error?.message || 'erro de conexão'}`;
    notify(message);
  }
}

function filteredSetRows() {
  const query = normalize(ui.setQuery);
  return buildSetStats()
    .filter(item => !query || normalize(item.name).includes(query) || normalize(item.id).includes(query))
    .sort((a, b) => b.ownedUnique - a.ownedUnique || a.name.localeCompare(b.name, 'pt-BR'));
}

function renderSetSearchResults() {
  const rows = filteredSetRows();
  return `<div class="set-list" style="margin-top:12px">${rows.length ? rows.map(renderSetCard).join('') : '<div class="empty"><strong>Nenhuma coleção encontrada</strong>Tente outro termo.</div>'}</div>`;
}

function renderSets() {
  return `
    <section class="screen">
      <h2 class="screen-title">Coleções</h2>
      <p class="screen-subtitle">Acompanhe o progresso de cada expansão.</p>
      ${catalogUpdatePanel()}
      <input id="setSearchInput" class="field search" value="${esc(ui.setQuery)}" placeholder="Buscar coleção"
        oncompositionstart="this.dataset.composing='1'"
        oncompositionend="this.dataset.composing='';searchAndRender('setQuery', this.value, 'setSearchInput')"
        oninput="searchAndRender('setQuery', this.value, 'setSearchInput')">
      <div id="setSearchResults">${renderSetSearchResults()}</div>
    </section>`;
}

function renderSetCard(item) {
  const total = item.officialCardCount || item.totalCardCount || 0;
  return `<button class="set-card" onclick="openSet('${esc(item.id)}')">
    <div class="set-title-row"><span class="set-name">${esc(item.name)}</span><span class="set-count">${item.progress}%</span></div>
    <div class="progress"><span style="width:${item.progress}%"></span></div>
    <div class="card-meta">${item.ownedUnique} de ${total} cartas únicas · ${item.ownedCopies} cópias</div>
  </button>`;
}

function openSet(setId) {
  ui.cardSet = setId;
  ui.cardFilter = 'all';
  ui.cardQuery = '';
  setTab('cards');
}

function pendingPriceQuoteForVariant(cardId, variant) {
  if (!variant || Number(variant.quantity) <= 0 || hasFiniteNumber(variant.manualEstimatedValue)) return null;
  const stored = storedAutomaticPriceQuote(variant);
  if (stored?.confidence === 'review' && !stored.userValidated) return stored;
  const live = automaticPriceQuote(cardId, variant.finish || 'comum');
  const liveAccepted = Boolean(live?.fingerprint)
    && Boolean(variant.automaticPriceUserValidated)
    && variant.automaticPriceAcceptedFingerprint === live.fingerprint;
  return live?.confidence === 'review' && !liveAccepted ? live : null;
}

function cardNeedsPriceValidation(cardId) {
  if (quantityFor(cardId) <= 0) return false;
  return variantsFor(cardId).some(variant => pendingPriceQuoteForVariant(cardId, variant));
}

function sortablePriceForCard(cardId) {
  const variants = variantsFor(cardId);
  const owned = variants.filter(variant => Number(variant.quantity) > 0);
  const source = owned.length ? owned : variants;
  const values = [];
  for (const variant of source) {
    const effective = effectiveVariantPrice(cardId, variant);
    if (hasFiniteNumber(effective?.brl)) {
      values.push(Number(effective.brl));
      continue;
    }
    const pending = storedAutomaticPriceQuote(variant) || automaticPriceQuote(cardId, variant.finish || 'comum');
    if (hasFiniteNumber(pending?.brl)) values.push(Number(pending.brl));
  }
  if (!values.length) {
    const fallback = automaticPriceQuote(cardId, 'comum');
    if (hasFiniteNumber(fallback?.brl)) values.push(Number(fallback.brl));
  }
  return values.length ? Math.max(...values) : Number.NEGATIVE_INFINITY;
}

function filteredCardsForUi() {
  const forcedFilter = ui.tab === 'wishlist' ? 'wishlist' : ui.tab === 'repeated' ? 'repeated' : null;
  const filter = forcedFilter || ui.cardFilter;
  const query = normalize(ui.cardQuery);
  const result = cards.filter(card => {
    const entry = entryFor(card.id);
    const quantity = quantityFor(card.id);
    if (ui.cardSet !== 'all' && card.setId !== ui.cardSet) return false;
    if (filter === 'owned' && quantity <= 0) return false;
    if (filter === 'missing' && quantity > 0) return false;
    if (filter === 'wishlist' && !entry.wishlist) return false;
    if (filter === 'repeated' && quantity <= 1) return false;
    if (filter === 'price-review' && !cardNeedsPriceValidation(card.id)) return false;
    if (!query) return true;
    const haystack = normalize(`${card.name} ${card.number} ${card.localId} ${card.setName} ${card.rarity || ''}`);
    return haystack.includes(query);
  });
  result.sort(cardSorter(ui.cardSort));
  return { result, visible: result.slice(0, ui.cardLimit), forcedFilter, filter };
}

function renderCardSearchResults() {
  const { result, visible } = filteredCardsForUi();
  return `
    <p class="card-meta" style="margin:0 0 10px">${result.length.toLocaleString('pt-BR')} cartas encontradas</p>
    <div class="card-list">${visible.length ? visible.map(renderCardRow).join('') : emptyCards()}</div>
    ${visible.length < result.length ? `<button class="load-more" onclick="ui.cardLimit+=100;refreshSearchResults('cardQuery', true)">Mostrar mais ${Math.min(100, result.length-visible.length)}</button>` : ''}`;
}

function renderCards() {
  const { forcedFilter, filter } = filteredCardsForUi();
  const title = ui.tab === 'wishlist' ? 'Wishlist' : ui.tab === 'repeated' ? 'Cartas repetidas' : 'Cartas';
  const selectedSet = ui.cardSet === 'all' ? null : catalog.sets.find(set => set.id === ui.cardSet);
  return `
    <section class="screen">
      <h2 class="screen-title">${esc(title)}</h2>
      <p class="screen-subtitle">${selectedSet ? `Filtrando: ${esc(selectedSet.name)}.` : 'Busque a carta e toque nela para fazer o cadastro completo.'}</p>
      <div class="toolbar">
        <input id="cardSearchInput" class="field search" value="${esc(ui.cardQuery)}" placeholder="Buscar por nome, número ou coleção"
          oncompositionstart="this.dataset.composing='1'"
          oncompositionend="this.dataset.composing='';searchAndRender('cardQuery', this.value, 'cardSearchInput')"
          oninput="searchAndRender('cardQuery', this.value, 'cardSearchInput')">
        ${!forcedFilter ? `<div class="chips">${filterChips()}</div>` : ''}
        <div class="filter-grid">
          <select class="field" onchange="ui.cardSort=this.value;ui.cardLimit=80;render()">
            ${option('number','Número',ui.cardSort)}${option('name','Nome',ui.cardSort)}${option('quantity','Quantidade',ui.cardSort)}${option('price-desc','Preço: maior → menor',ui.cardSort)}${option('set','Coleção',ui.cardSort)}
          </select>
          <select class="field" onchange="ui.cardSet=this.value;ui.cardLimit=80;render()">
            <option value="all">Todas as coleções</option>
            ${catalog.sets.map(set => option(set.id, set.name, ui.cardSet)).join('')}
          </select>
        </div>
      </div>
      <div id="cardSearchResults">${renderCardSearchResults()}</div>
    </section>`;
}

function filterChips() {
  const chips = [['all','Todos'],['owned','Tenho'],['missing','Falta'],['wishlist','Desejo'],['repeated','Rep.'],['price-review','Preço pendente']];
  return chips.map(([value,label]) => `<button class="chip ${ui.cardFilter===value?'active':''}" onclick="ui.cardFilter='${value}';ui.cardLimit=80;render()">${label}</button>`).join('');
}

function cardSorter(sort) {
  if (sort === 'name') return (a,b) => a.name.localeCompare(b.name,'pt-BR') || a.setName.localeCompare(b.setName,'pt-BR');
  if (sort === 'quantity') return (a,b) => quantityFor(b.id)-quantityFor(a.id) || a.name.localeCompare(b.name,'pt-BR');
  if (sort === 'price-desc') return (a,b) => sortablePriceForCard(b.id)-sortablePriceForCard(a.id) || a.name.localeCompare(b.name,'pt-BR');
  if (sort === 'set') return (a,b) => a.setName.localeCompare(b.setName,'pt-BR') || numericLocal(a)-numericLocal(b);
  return (a,b) => numericLocal(a)-numericLocal(b) || a.localId.localeCompare(b.localId,undefined,{numeric:true}) || a.name.localeCompare(b.name,'pt-BR');
}

function numericLocal(card) {
  const match = String(card.localId).match(/\d+/);
  return match ? Number(match[0]) : 999999;
}

function renderCardRow(card) {
  const entry = entryFor(card.id);
  const quantity = quantityFor(card.id);
  const pokemonNames = (card.pokemonIds || []).slice(0,3).map(id => pokemonMap.get(id)?.name).filter(Boolean);
  const priceBadge = priceBadgeForCard(card.id);
  return `<article class="card-row ${quantity > 0 ? '' : 'missing'}" onclick="openCard('${esc(card.id)}')">
    ${card.imageUrl ? `<img class="card-thumb" src="${esc(card.imageUrl)}" loading="lazy" onerror="this.outerHTML='<div class=&quot;card-placeholder&quot;>TCG</div>'">` : '<div class="card-placeholder">TCG</div>'}
    <div class="card-main">
      <div class="card-name">${esc(card.name)}</div>
      <div class="card-meta">${esc(card.number)} · ${esc(card.setName)}</div>
      <div class="badges">
        ${card.rarity ? `<span class="badge">${esc(card.rarity)}</span>` : ''}
        <span class="badge ${quantity ? 'owned' : ''}">${quantity ? `Tenho ${quantity}` : 'Não tenho'}</span>
        ${entry.wishlist ? '<span class="badge yellow">Wishlist</span>' : ''}
        ${variantsFor(card.id).length > 1 ? `<span class="badge purple">${variantsFor(card.id).length} variantes</span>` : ''}
        ${priceBadge ? `<span class="badge price">${esc(priceBadge)}</span>` : ''}
        ${pokemonNames.length ? `<span class="badge">${esc(pokemonNames.join(' + '))}</span>` : ''}
      </div>
      <div class="quantity-control">
        <button class="qty-btn" onclick="changeQuantity(event,'${esc(card.id)}',-1)" aria-label="Diminuir">−</button>
        <span class="qty-value">${quantity}</span>
        <button class="qty-btn add" onclick="changeQuantity(event,'${esc(card.id)}',1)" aria-label="Adicionar">+</button>
      </div>
    </div>
  </article>`;
}

function emptyCards() {
  return '<div class="empty"><strong>Nenhuma carta encontrada</strong>Tente mudar os filtros ou buscar outro nome.</div>';
}


function automaticPriceBox(cardId, finish = 'comum', variantId = '') {
  const quote = automaticPriceQuote(cardId, finish);
  const variant = variantId
    ? variantsFor(cardId).find(item => item.id === variantId)
    : variantsFor(cardId).find(item => finishKind(item.finish) === finishKind(finish));
  const stored = storedAutomaticPriceQuote(variant);
  const displayQuote = quote || stored;
  const loading = priceRequests.has(cardId);
  if (displayQuote) {
    const converted = displayQuote.brl != null ? money(displayQuote.brl) : 'Conversão para reais indisponível';
    const original = displayQuote.value != null ? foreignMoney(displayQuote.value, displayQuote.currency) : '';
    const source = displayQuote.provider ? `${displayQuote.label} · ${displayQuote.provider}` : displayQuote.label;
    const confidence = displayQuote.confidence || 'review';
    const userValidated = Boolean(displayQuote.userValidated || (variant?.automaticPriceUserValidated && variant?.automaticPriceAcceptedFingerprint === displayQuote.fingerprint));
    const verified = confidence === 'verified';
    const reasons = displayQuote.validation?.reasons || [];
    const statusHtml = verified
      ? '<small class="price-verification verified">✓ Carta identificada por coleção e número; preço obtido em fonte validada.</small>'
      : userValidated
        ? '<small class="price-verification user-validated">✓ Correspondência confirmada manualmente por você.</small>'
        : `<small class="price-verification review">⚠ Necessita validação${reasons.length ? `: ${esc(reasons.join('; '))}` : ''}. Este valor ainda não entra no total da coleção.</small>`;
    const validationButton = !verified && !userValidated
      ? (variant?.id
        ? `<button type="button" class="price-validate-btn" onclick="event.preventDefault();event.stopPropagation();confirmCardmarketPrice('${esc(cardId)}','${esc(variant.id)}',document.getElementById('regFinish')?.value||'${esc(finish)}')">Confirmar que é esta carta</button>`
        : '<small>Salve esta variante antes de confirmar a correspondência.</small>')
      : '';
    return `<div class="automatic-price-card ${verified ? 'verified-price' : 'review-price'}">
      <strong>${esc(converted)}</strong>
      <span>${esc(source)}${original ? ` · ${esc(original)}` : ''}</span>
      <small>${displayQuote.stored ? 'Valor salvo na carta' : 'Consulta multifonte'} ${esc(formatPriceDate(displayQuote.fetchedAt))}${displayQuote.rate != null ? ` · câmbio ${displayQuote.currency}/BRL ${Number(displayQuote.rate).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}` : ''}</small>
      ${statusHtml}
      ${validationButton}
      <button type="button" class="price-refresh-btn" ${loading ? 'disabled' : ''} onclick="event.preventDefault();event.stopPropagation();updateCardPrice('${esc(cardId)}', document.getElementById('regFinish')?.value || '${esc(finish)}', true)">${loading ? 'Consultando...' : 'Atualizar agora'}</button>
    </div>`;
  }
  if (loading) return `<div class="automatic-price-card loading-price"><strong>Consultando Liga, Cardmarket e TCGplayer...</strong><span>Aguarde alguns segundos.</span></div>`;
  return `<div class="automatic-price-card empty-price">
    <strong>Ainda sem preço nas fontes disponíveis</strong>
    <span>Ordem: valor manual → Liga → Cardmarket/TCGplayer.</span>
    <button type="button" class="price-refresh-btn" onclick="event.preventDefault();event.stopPropagation();updateCardPrice('${esc(cardId)}', document.getElementById('regFinish')?.value || '${esc(finish)}', true)">Consultar preço</button>
  </div>`;
}

function refreshAutomaticPriceField(cardId, finish) {
  const target = document.getElementById('automaticPriceBox');
  const variantId = document.getElementById('regVariantId')?.value || '';
  if (target) target.innerHTML = automaticPriceBox(cardId, finish, variantId);
}

function confirmCardmarketPrice(cardId, variantId, finish) {
  const variant = variantsFor(cardId).find(item => item.id === variantId);
  const quote = automaticPriceQuote(cardId, finish || variant?.finish || 'comum');
  if (!variant || !quote || quote.confidence !== 'review') return notify('Não há correspondência pendente para validar.');
  variant.automaticPriceUserValidated = true;
  variant.automaticPriceAcceptedFingerprint = quote.fingerprint;
  variant.automaticPriceUserValidatedAt = new Date().toISOString();
  applyAutomaticPriceToVariant(cardId, variant);
  syncEntry(cardId);
  saveState();
  refreshAutomaticPriceField(cardId, finish || variant.finish);
  renderKeepingScroll();
  notify('Preço confirmado e incluído no total da coleção.');
}

async function updateCardPrice(cardId, finish = 'comum', force = false) {
  refreshAutomaticPriceField(cardId, finish);
  try {
    await fetchCardPricing(cardId, force);
    const saved = persistAutomaticPricesForCard(cardId, true);
    refreshAutomaticPriceField(cardId, finish);
    renderKeepingScroll();
    const quote = automaticPriceQuote(cardId, finish);
    notify(quote
      ? (quote.confidence === 'verified'
        ? (saved ? 'Preço multifonte salvo' : 'Preço multifonte encontrado')
        : 'Preço encontrado em fonte externa')
      : 'Nenhuma fonte retornou preço para esta carta.');
  } catch (error) {
    refreshAutomaticPriceField(cardId, finish);
    const message = error?.name === 'AbortError' ? 'A consulta demorou demais.' : String(error?.message || 'Não foi possível consultar o preço agora.');
    lastPriceDiagnostic = message;
    try { localStorage.setItem('fichario-price-last-diagnostic', message); } catch (_) {}
    notify(message.length > 180 ? `${message.slice(0, 177)}...` : message);
  }
}

function ensureCardPriceLoaded(cardId, finish) {
  if (priceCacheFresh(cardId)) {
    if (persistAutomaticPricesForCard(cardId, true)) renderKeepingScroll();
    return;
  }
  if (priceRequests.has(cardId)) return;
  setTimeout(() => updateCardPrice(cardId, finish, false), 120);
}

function openCard(cardId, variantId = undefined) {
  const card = cardMap.get(cardId);
  if (!card) return;
  const entry = entryFor(cardId);
  const quantity = quantityFor(cardId);
  const variants = variantsFor(cardId);
  const linked = (card.pokemonIds || []).map(id => pokemonMap.get(id)).filter(Boolean);
  const creatingNew = variantId === null;
  const selected = creatingNew ? null : (variantId ? variants.find(item => item.id === variantId) : variants[0]);
  const draft = selected || defaultVariant(0, { isWishlist: Boolean(entry.wishlist) });
  const existingId = selected?.id || '';
  showModal(`
    <button class="modal-close" onclick="closeModal()" aria-label="Fechar">×</button>
    <div class="registration-header">
      ${card.imageUrl ? `<img class="registration-card-image" src="${esc(card.imageUrl)}" onerror="this.outerHTML='<div class=&quot;registration-placeholder&quot;>TCG</div>'">` : '<div class="registration-placeholder">TCG</div>'}
      <div>
        <span class="registration-kicker">CADASTRO DA CARTA</span>
        <h2>${esc(card.name)}</h2>
        <p class="card-meta">${esc(card.number)} · ${esc(card.setName)}${card.rarity ? ` · ${esc(card.rarity)}` : ''}</p>
        <div class="badges">
          <span class="badge ${quantity ? 'owned' : ''}">${quantity ? `Total no fichário: ${quantity}` : 'Ainda não cadastrada'}</span>
          ${variants.length ? `<span class="badge purple">${variants.length} ${variants.length === 1 ? 'variante' : 'variantes'}</span>` : ''}
          ${linked.map(item => `<span class="badge">#${String(item.id).padStart(4,'0')} ${esc(item.name)}</span>`).join('')}
        </div>
      </div>
    </div>

    <section class="registration-section">
      <div class="registration-section-title">
        <div><strong>Variantes da minha carta</strong><span>Separe comum, holográfica, reversa e outros acabamentos.</span></div>
        <button class="mini-btn" onclick="openCard('${esc(card.id)}', null)">+ Nova</button>
      </div>
      ${variants.length ? `<div class="variant-strip">${variants.map(item => `<button class="variant-chip ${item.id === existingId ? 'active' : ''}" onclick="openCard('${esc(card.id)}','${esc(item.id)}')">${esc(variantLabel(item))}</button>`).join('')}</div>` : '<div class="notice compact">Nenhuma variante cadastrada. Preencha os dados abaixo para começar.</div>'}
    </section>

    <section class="registration-section">
      <h3>${existingId ? 'Editar variante' : 'Nova variante'}</h3>
      <input type="hidden" id="regVariantId" value="${esc(existingId)}">
      <div class="registration-grid two-columns">
        ${registrationField('Quantidade', `<input id="regQuantity" class="field" type="number" inputmode="numeric" min="0" step="1" value="${Math.max(0, Number(draft.quantity) || 0)}">`)}
        ${registrationField('Condição', `<select id="regCondition" class="field">${['Mint','Near Mint','Excelente','Bom','Regular','Danificada'].map(value => option(value,value,draft.condition)).join('')}</select>`)}
        ${registrationField('Acabamento', `<select id="regFinish" class="field" onchange="refreshAutomaticPriceField('${esc(card.id)}', this.value)">${['comum','holografica','reversa','especial','full art','secreta','jumbo','outro'].map(value => option(value,value,draft.finish)).join('')}</select>`)}
        ${registrationField('Idioma', `<select id="regLanguage" class="field">${['Portugues BR','Ingles','Japones','Espanhol','Outro'].map(value => option(value,value,draft.language)).join('')}</select>`)}
        ${registrationField('Guardada em', `<select id="regStorage" class="field">${['fichario','caixa','deck','troca','venda'].map(value => option(value,value,draft.storageLocation)).join('')}</select>`)}
        ${registrationField('Preço automático', `<div id="automaticPriceBox">${automaticPriceBox(card.id, draft.finish, existingId)}</div>`)}
      </div>

      <div class="toggle-grid">
        ${registrationToggle('regWishlist','Wishlist',draft.isWishlist)}
        ${registrationToggle('regTrade','Para troca',draft.isForTrade)}
        ${registrationToggle('regSale','Para venda',draft.isForSale)}
        ${registrationToggle('regArt','Arte conferida',draft.artConfirmed)}
      </div>

      <div class="registration-grid two-columns">
        ${registrationField('Preço que paguei (R$)', `<input id="regPaidPrice" class="field" inputmode="decimal" placeholder="Ex.: 5,50" value="${esc(formatInputNumber(draft.paidPrice))}">`)}
        ${registrationField('Valor manual (R$)', `<input id="regManualValue" class="field" inputmode="decimal" placeholder="Ex.: 8,00" value="${esc(formatInputNumber(draft.manualEstimatedValue))}">`)}
      </div>
      ${registrationField('Observações da carta', `<textarea id="regNotes" class="field notes-field" rows="4" placeholder="Ex.: pequeno risco no verso, veio no booster...">${esc(draft.notes)}</textarea>`)}

      <div class="modal-actions">
        <button class="primary-btn" onclick="saveCardVariant('${esc(card.id)}','${esc(existingId)}')">${existingId ? 'Salvar alterações' : 'Cadastrar carta'}</button>
        ${existingId ? `<button class="danger-btn" onclick="deleteCardVariant('${esc(card.id)}','${esc(existingId)}')">Excluir esta variante</button>` : ''}
      </div>
    </section>`);
  ensureCardPriceLoaded(card.id, draft.finish);
}

function registrationField(label, control) {
  return `<label class="registration-field"><span>${esc(label)}</span>${control}</label>`;
}

function registrationToggle(id, label, checked) {
  return `<label class="toggle-card"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><span class="toggle-ui"></span><strong>${esc(label)}</strong></label>`;
}

function filteredPokedexForUi() {
  const stats = buildPokemonStats();
  const query = normalize(ui.dexQuery);
  const result = pokedex.filter(item => {
    const owned = stats.get(item.id).copies > 0;
    if (ui.dexRegion !== 'all' && item.region !== ui.dexRegion) return false;
    if (ui.dexType !== 'all' && !item.types.includes(ui.dexType)) return false;
    if (ui.dexStatus === 'owned' && !owned) return false;
    if (ui.dexStatus === 'missing' && owned) return false;
    return !query || normalize(`${item.name} ${item.id}`).includes(query);
  });
  if (ui.dexSort === 'name') result.sort((a,b) => a.name.localeCompare(b.name,'pt-BR'));
  else if (ui.dexSort === 'owned') result.sort((a,b) => stats.get(b.id).copies-stats.get(a.id).copies || a.id-b.id);
  else result.sort((a,b) => a.id-b.id);
  const grouped = new Map();
  for (const item of result) {
    if (!grouped.has(item.region)) grouped.set(item.region, []);
    grouped.get(item.region).push(item);
  }
  return { result, grouped, stats };
}

function renderPokedexSearchResults() {
  const { result, grouped, stats } = filteredPokedexForUi();
  return result.length
    ? REGION_ORDER.filter(region=>grouped.has(region)).map(region => renderRegion(region, grouped.get(region), stats)).join('')
    : '<div class="empty"><strong>Nenhum Pokémon encontrado</strong>Altere os filtros para continuar.</div>';
}

function renderPokedex() {
  if (ui.selectedPokemon) return renderPokemonDetail(ui.selectedPokemon);
  const stats = buildPokemonStats();
  const ownedCount = pokedex.filter(item => stats.get(item.id).copies > 0).length;
  const types = [...new Set(pokedex.flatMap(item => item.types))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  return `<section class="screen">
    <h2 class="screen-title">Pokédex</h2>
    <p class="screen-subtitle">${ownedCount} de ${pokedex.length} Pokémon têm cartas na sua coleção. Os que faltam aparecem transparentes.</p>
    <div class="toolbar">
      <input id="dexSearchInput" class="field search" value="${esc(ui.dexQuery)}" placeholder="Buscar Pokémon por nome ou número"
        oncompositionstart="this.dataset.composing='1'"
        oncompositionend="this.dataset.composing='';searchAndRender('dexQuery', this.value, 'dexSearchInput')"
        oninput="searchAndRender('dexQuery', this.value, 'dexSearchInput')">
      <div class="filter-grid">
        <select class="field" onchange="ui.dexRegion=this.value;render()">
          <option value="all">Todas as regiões</option>${REGION_ORDER.slice(0,-1).map(region=>option(region,region,ui.dexRegion)).join('')}
        </select>
        <select class="field" onchange="ui.dexType=this.value;render()">
          <option value="all">Todos os tipos</option>${types.map(type=>option(type,type,ui.dexType)).join('')}
        </select>
        <select class="field" onchange="ui.dexStatus=this.value;render()">
          ${option('all','Tenho e faltam',ui.dexStatus)}${option('owned','Somente tenho',ui.dexStatus)}${option('missing','Somente faltam',ui.dexStatus)}
        </select>
        <select class="field" onchange="ui.dexSort=this.value;render()">
          ${option('number','Número da Pokédex',ui.dexSort)}${option('name','Nome',ui.dexSort)}${option('owned','Mais cartas',ui.dexSort)}
        </select>
      </div>
    </div>
    <div id="dexSearchResults">${renderPokedexSearchResults()}</div>
  </section>`;
}

function renderRegion(region, items, stats) {
  const owned = items.filter(item => stats.get(item.id).copies > 0).length;
  return `<section class="region-section">
    <div class="region-heading"><h3>${esc(region)}</h3><span>${owned} com cartas · ${items.length} exibidos</span></div>
    <div class="pokemon-grid">${items.map(item => renderPokemonTile(item, stats.get(item.id))).join('')}</div>
  </section>`;
}

function renderPokemonTile(item, stat) {
  const owned = stat.copies > 0;
  return `<button class="pokemon-tile ${owned ? '' : 'missing'}" onclick="openPokemon(${item.id})">
    ${owned ? `<span class="pokemon-owned-count">${stat.copies}</span>` : ''}
    <img src="${esc(item.sprite)}" loading="lazy" alt="${esc(item.name)}">
    <span class="pokemon-number">Nº ${String(item.id).padStart(4,'0')}</span>
    <span class="pokemon-name">${esc(item.name)}</span>
  </button>`;
}

function openPokemon(id) {
  ui.selectedPokemon = Number(id);
  render();
  window.scrollTo(0,0);
}

function renderPokemonDetail(id) {
  const pokemon = pokemonMap.get(Number(id));
  if (!pokemon) { ui.selectedPokemon = null; return renderPokedex(); }
  const stat = buildPokemonStats().get(pokemon.id);
  const related = (pokemonCards.get(pokemon.id) || []).map(cardId => cardMap.get(cardId)).filter(Boolean)
    .sort((a,b) => quantityFor(b.id)-quantityFor(a.id) || a.setName.localeCompare(b.setName,'pt-BR') || numericLocal(a)-numericLocal(b));
  return `<section class="screen">
    <button class="back-btn" onclick="ui.selectedPokemon=null;render();window.scrollTo(0,0)">← Voltar à Pokédex</button>
    <div class="pokemon-hero">
      <img src="${esc(pokemon.sprite)}" alt="${esc(pokemon.name)}">
      <div><span class="pokemon-number">Nº ${String(pokemon.id).padStart(4,'0')} · ${esc(pokemon.region)}</span><h2>${esc(pokemon.name)}</h2><div class="badges">${pokemon.types.map(type=>`<span class="badge">${esc(type)}</span>`).join('')}</div></div>
    </div>
    <div class="stats-grid">
      ${statCard(stat.copies,'Cartas no fichário')}
      ${statCard(stat.cardIds.size,'Cartas únicas')}
    </div>
    <h3 class="section-title">Todas as cartas de ${esc(pokemon.name)}</h3>
    <p class="screen-subtitle">As suas aparecem primeiro e totalmente visíveis. Você pode atualizar a quantidade aqui mesmo.</p>
    <div class="card-list">${related.length ? related.map(renderCardRow).join('') : '<div class="empty">Nenhuma carta desse Pokémon foi encontrada no catálogo atual.</div>'}</div>
  </section>`;
}

function ownedDeckPool() {
  return cards.map(card => ({ card, owned: quantityFor(card.id) }))
    .filter(item => item.owned > 0);
}

function deckCardClass(card) {
  const name = normalize(card?.name);
  if (/energia|energy/.test(name)) return 'energy';
  if (Array.isArray(card?.pokemonIds) && card.pokemonIds.length) return 'pokemon';
  return 'trainer';
}

function deckCardLimit(card) {
  return deckCardClass(card) === 'energy' ? 60 : 4;
}

function deckTotal(deck) {
  return Object.values(deck?.cards || {}).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function deckBreakdown(deck) {
  const result = { pokemon: 0, trainer: 0, energy: 0 };
  for (const [cardId, qty] of Object.entries(deck?.cards || {})) {
    const card = cardMap.get(cardId);
    if (card) result[deckCardClass(card)] += Math.max(0, Number(qty) || 0);
  }
  return result;
}

function deckStrengthScore(card) {
  const name = normalize(card?.name);
  let score = 1;
  if (/\bex\b|vmax|vstar|\bgx\b/.test(name)) score += 12;
  else if (/\bv\b|break|prime|level x/.test(name)) score += 8;
  if (/boss|pesquisa|professor|ultra bola|ninho|captura|rare candy|doce raro|switch|troca|ordens/.test(name)) score += 7;
  if (/energia/.test(name)) score += 2;
  score += Math.min(4, quantityFor(card.id));
  return score;
}

function addDeckCardQuantity(target, cardId, wanted) {
  const card = cardMap.get(cardId);
  if (!card) return 0;
  const available = quantityFor(cardId);
  const current = Math.max(0, Number(target[cardId]) || 0);
  const allowed = Math.min(available, deckCardLimit(card));
  const add = Math.max(0, Math.min(Number(wanted) || 0, allowed - current));
  if (add) target[cardId] = current + add;
  return add;
}

function generateStrongDeck() {
  const pool = ownedDeckPool();
  if (!pool.length) return notify('Cadastre cartas antes de gerar um deck.');
  const groups = { pokemon: [], trainer: [], energy: [] };
  pool.forEach(item => groups[deckCardClass(item.card)].push(item));
  Object.values(groups).forEach(list => list.sort((a,b) => deckStrengthScore(b.card)-deckStrengthScore(a.card) || b.owned-a.owned || a.card.name.localeCompare(b.card.name,'pt-BR')));
  const target = {};
  const fill = (list, desired) => {
    let total = 0;
    for (const item of list) {
      if (total >= desired) break;
      total += addDeckCardQuantity(target, item.card.id, Math.min(item.owned, desired-total, deckCardLimit(item.card)));
    }
    return total;
  };
  fill(groups.pokemon, 18);
  fill(groups.trainer, 30);
  fill(groups.energy, 12);
  const all = [...groups.pokemon, ...groups.trainer, ...groups.energy];
  let total = Object.values(target).reduce((a,b)=>a+b,0);
  for (const item of all) {
    if (total >= 60) break;
    total += addDeckCardQuantity(target, item.card.id, 60-total);
  }
  state.decks = state.decks || [];
  const deck = { id: `deck-${Date.now()}`, name: `Deck forte ${state.decks.length + 1}`, cards: target, createdAt: new Date().toISOString(), generated: true };
  state.decks.push(deck);
  selectedDeckId = deck.id;
  saveState(); render(); notify(`Deck criado com ${deckTotal(deck)} cartas da sua coleção.`);
}

function renderDeckCardRow(deck, cardId, qty) {
  const card = cardMap.get(cardId);
  if (!card) return '';
  const owned = quantityFor(cardId);
  return `<div class="deck-card-row">
    ${card.imageUrl ? `<img src="${esc(card.imageUrl)}" onerror="this.style.display='none'">` : ''}
    <div class="deck-card-info"><strong>${esc(card.name)}</strong><span>${esc(card.number)} · ${esc(card.setName)} · você tem ${owned}</span></div>
    <div class="deck-qty"><button onclick="changeDeckCard('${esc(deck.id)}','${esc(cardId)}',-1)">−</button><b>${qty}</b><button onclick="changeDeckCard('${esc(deck.id)}','${esc(cardId)}',1)">+</button></div>
  </div>`;
}

function renderDeckEditor(deck) {
  const total = deckTotal(deck);
  const split = deckBreakdown(deck);
  const entries = Object.entries(deck.cards || {}).filter(([,q]) => Number(q)>0).sort((a,b)=>deckCardClass(cardMap.get(a[0])).localeCompare(deckCardClass(cardMap.get(b[0]))) || (cardMap.get(a[0])?.name||'').localeCompare(cardMap.get(b[0])?.name||'','pt-BR'));
  return `<section class="screen">
    <button class="back-btn" onclick="selectedDeckId=null;render()">← Voltar aos decks</button>
    <div class="deck-editor-head"><div><h2 class="screen-title">${esc(deck.name)}</h2><p class="screen-subtitle">Edite usando somente as cartas que você possui.</p></div><button class="danger-btn compact-btn" onclick="deleteDeck('${esc(deck.id)}')">Excluir</button></div>
    <div class="deck-summary ${total===60?'valid':'invalid'}"><strong>${total}/60 cartas</strong><span>${split.pokemon} Pokémon · ${split.trainer} Treinadores · ${split.energy} Energias</span><small>${total===60?'Deck com 60 cartas.':'Ajuste até completar 60 cartas.'}</small></div>
    <div class="deck-search"><input id="deckCardSearch" class="field" placeholder="Buscar nas minhas cartas"><button class="primary-btn" onclick="openDeckCardPicker('${esc(deck.id)}')">Adicionar carta</button></div>
    <div class="deck-card-list">${entries.length ? entries.map(([id,q])=>renderDeckCardRow(deck,id,q)).join('') : '<div class="empty">Este deck ainda está vazio.</div>'}</div>
  </section>`;
}

function renderDecks() {
  const decks = state.decks || [];
  const selected = decks.find(deck => deck.id === selectedDeckId);
  if (selected) return renderDeckEditor(selected);
  return `<section class="screen">
    <h2 class="screen-title">Decks</h2>
    <p class="screen-subtitle">Monte automaticamente um baralho com as cartas que você possui e depois edite cada quantidade.</p>
    <button class="primary-btn full-btn" onclick="generateStrongDeck()">⚔️ Montar deck forte automaticamente</button>
    <div class="deck-row"><input id="deckName" class="field" placeholder="Nome do novo deck"><button class="primary-btn" onclick="addDeck()">Criar vazio</button></div>
    <div class="set-list">${decks.length ? decks.map(deck => { const split=deckBreakdown(deck); const total=deckTotal(deck); return `<button class="panel deck-panel" onclick="selectedDeckId='${esc(deck.id)}';render()"><div class="set-title-row"><span class="set-name">${esc(deck.name)}</span><span class="badge ${total===60?'owned':''}">${total}/60</span></div><p class="card-meta">${split.pokemon} Pokémon · ${split.trainer} Treinadores · ${split.energy} Energias</p></button>`; }).join('') : '<div class="empty"><strong>Nenhum deck criado</strong>Use o gerador automático ou crie um deck vazio.</div>'}</div>
  </section>`;
}

function addDeck() {
  const input = document.getElementById('deckName');
  const name = input?.value.trim();
  if (!name) return notify('Digite um nome para o deck');
  state.decks = state.decks || [];
  const deck = { id: `deck-${Date.now()}`, name, cards: {}, createdAt: new Date().toISOString() };
  state.decks.push(deck); selectedDeckId = deck.id;
  saveState(); render(); notify('Deck criado');
}

function deleteDeck(id) {
  state.decks = (state.decks || []).filter(deck => deck.id !== id);
  if (selectedDeckId === id) selectedDeckId = null;
  saveState(); render();
}

function changeDeckCard(deckId, cardId, delta) {
  const deck = (state.decks || []).find(item => item.id === deckId);
  const card = cardMap.get(cardId);
  if (!deck || !card) return;
  deck.cards = deck.cards || {};
  const current = Math.max(0, Number(deck.cards[cardId]) || 0);
  const max = Math.min(quantityFor(cardId), deckCardLimit(card));
  const next = Math.max(0, Math.min(max, current + Number(delta || 0)));
  if (next) deck.cards[cardId] = next; else delete deck.cards[cardId];
  saveState(); render();
}

function openDeckCardPicker(deckId) {
  const deck = (state.decks || []).find(item => item.id === deckId);
  if (!deck) return;
  const query = normalize(document.getElementById('deckCardSearch')?.value || '');
  const pool = ownedDeckPool().filter(item => !query || normalize(`${item.card.name} ${item.card.number} ${item.card.setName}`).includes(query)).slice(0,120);
  showModal(`<button class="modal-close" onclick="closeModal()">×</button><h2>Adicionar carta ao deck</h2><p class="screen-subtitle">A quantidade máxima respeita o que existe no seu fichário.</p><div class="deck-picker">${pool.length ? pool.map(item=>`<button onclick="changeDeckCard('${esc(deckId)}','${esc(item.card.id)}',1);closeModal()"><strong>${esc(item.card.name)}</strong><span>${esc(item.card.number)} · ${esc(item.card.setName)} · você tem ${item.owned}</span></button>`).join('') : '<div class="empty">Nenhuma carta encontrada.</div>'}</div>`);
}

function option(value, label, selected) {
  return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
}

let searchRenderTimer = null;

function searchResultsTarget(field) {
  if (field === 'setQuery') return ['setSearchResults', renderSetSearchResults];
  if (field === 'cardQuery') return ['cardSearchResults', renderCardSearchResults];
  if (field === 'dexQuery') return ['dexSearchResults', renderPokedexSearchResults];
  return [null, null];
}

function refreshSearchResults(field, keepScroll = false) {
  const [targetId, renderer] = searchResultsTarget(field);
  const target = targetId ? document.getElementById(targetId) : null;
  if (!target || typeof renderer !== 'function') return;
  const y = window.scrollY;
  target.innerHTML = renderer();
  if (keepScroll) requestAnimationFrame(() => window.scrollTo(0, y));
}

function searchAndRender(field, value, inputId) {
  ui[field] = value;
  if (field === 'cardQuery') ui.cardLimit = 80;
  const input = document.getElementById(inputId);
  if (input?.dataset.composing === '1') return;
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(() => refreshSearchResults(field), 70);
}

function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}

function openBackupPanel() {
  const summary = collectionSummary();
  showModal(`
    <button class="modal-close" onclick="closeModal()">×</button>
    <h2>Backup da coleção</h2>
    <p class="screen-subtitle">Salve uma cópia para não depender da assinatura ou da instalação do aplicativo.</p>
    <div class="panel"><strong>${summary.uniqueOwned} cartas únicas · ${summary.totalCopies} cartas no total</strong><p class="card-meta">Inclui quantidades, wishlist e decks desta nova versão.</p></div>
    <div class="backup-actions">
      <button class="primary-btn" onclick="exportBackup()">Exportar backup</button>
      <button class="secondary-btn" onclick="importBackup()">Importar backup</button>
    </div>`);
}

function exportBackup() {
  const payload = JSON.stringify({
    format: 'fichario-pokemon-br-plus-backup',
    exportedAt: new Date().toISOString(),
    state,
    priceCache,
    fxCache,
    ligaSetCache,
  }, null, 2);
  if (window.Android?.exportBackup) window.Android.exportBackup(payload);
  else {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([payload], {type:'application/json'}));
    link.download = 'fichario-pokemon-backup.json';
    link.click();
  }
}

function importBackup() {
  if (window.Android?.importBackup) window.Android.importBackup();
}

window.receiveImportedBackup = function(raw) {
  try {
    const payload = JSON.parse(raw);
    if (payload?.format !== 'fichario-pokemon-br-plus-backup' || !payload.state?.entries) throw new Error('Formato inválido');
    const migrated = migrateState(payload.state);
    if (!migrated) throw new Error('Estado inválido');
    state = migrated;
    if (payload.priceCache && typeof payload.priceCache === 'object') { priceCache = payload.priceCache; savePriceCache(); }
    if (payload.fxCache && typeof payload.fxCache === 'object') { fxCache = payload.fxCache; saveFxCache(); }
    if (payload.ligaSetCache && typeof payload.ligaSetCache === 'object') { ligaSetCache = payload.ligaSetCache; saveLigaSetCache(); }
    saveState();
    closeModal();
    render();
    notify('Backup importado com sucesso');
  } catch (_) {
    notify('Este arquivo não é um backup válido');
  }
};

window.handleAndroidBack = function() {
  const modal = document.getElementById('modal');
  if (modal && !modal.classList.contains('hidden')) { closeModal(); return true; }
  if (ui.tab === 'pokedex' && ui.selectedPokemon) { ui.selectedPokemon = null; render(); return true; }
  if (ui.tab !== 'dashboard') { setTab('dashboard'); return true; }
  return false;
};

init();
