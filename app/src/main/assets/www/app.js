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
const PRICE_LOGIC_VERSION = 13;
const PRICE_CACHE_TTL = 24 * 60 * 60 * 1000;
const FX_CACHE_TTL = 24 * 60 * 60 * 1000;
const TCGDEX_API_BASE = 'https://api.tcgdex.net/v2/pt-br';
const TCGDEX_API_FALLBACK = 'https://api.tcgdex.net/v2/en';
const TCGDEX_API_JAPANESE = 'https://api.tcgdex.net/v2/ja';
const FX_API_BASE = 'https://api.frankfurter.dev/v2';
const CENTRAL_PRICE_BASE = 'https://raw.githubusercontent.com/fernandossb/pokemon-price-database/main/output';
const CENTRAL_PRICE_STATUS_URL = `${CENTRAL_PRICE_BASE}/status.json`;
const CENTRAL_PRICE_DATA_URL = `${CENTRAL_PRICE_BASE}/prices-current.json`;
const CENTRAL_PRICE_DB_NAME = 'fichario-pokemon-central-prices-v1';
const CENTRAL_PRICE_DB_STORE = 'data';
const CENTRAL_PRICE_DB_KEY = 'current';
const CENTRAL_PRICE_SYNC_TTL = 6 * 60 * 60 * 1000;
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
let latestUpdateInfo = null;
let updateCheckInProgress = false;
let centralPriceData = { meta: {}, prices: {} };
let centralPriceStatus = {};
let centralPriceSyncing = false;
let centralPriceLastCheck = 0;

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

function priceCacheFresh(cardId, finish = 'comum') {
  const item = priceCache[cardId];
  const kind = finishKind(finish);
  const quote = item?.quotes?.[kind];
  return Boolean(item && Number(item.logicVersion) === PRICE_LOGIC_VERSION && quote && Number(quote.fetchedAt) && Date.now() - Number(quote.fetchedAt) < PRICE_CACHE_TTL);
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
  const validation = cardmarketValidation(card, remoteIdentity, kind);
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
    promotional: Boolean(detail?.variants?.wPromo)
      || /promo|black star/i.test(String(detail?.set?.name || ''))
      || /(?:^|[-_.])p(?:$|[-_.])/i.test(String(detail?.set?.id || '')),
  };
}

function isPromotionalCard(card) {
  return Boolean(card?.promotional)
    || Boolean(card?.variants?.wPromo)
    || /promo|black star/i.test(String(card?.setName || ''))
    || /(?:^|[-_.])p(?:$|[-_.])/i.test(String(card?.setId || ''));
}

function enrichLocalCardFromRemote(card, remote) {
  if (!card || !remote) return;
  if (remote.illustrator) card.illustrator = remote.illustrator;
  if (remote.category) card.category = remote.category;
  if (remote.rarity) card.rarity = remote.rarity;
  if (remote.variants && typeof remote.variants === 'object') card.variants = { ...remote.variants };
  card.promotional = Boolean(remote.promotional);
  if ((!Array.isArray(card.pokemonIds) || !card.pokemonIds.length) && Array.isArray(remote.dexId)) {
    card.pokemonIds = [...remote.dexId];
  }
}

function cardmarketValidation(card, remote, kind) {
  const checks = [];
  const add = (key, label, ok) => checks.push({ key, label, ok: Boolean(ok) });
  enrichLocalCardFromRemote(card, remote);

  const localPokemon = sortedNumberList(card?.pokemonIds);
  const remotePokemon = sortedNumberList(remote?.dexId);
  const variants = remote?.variants || {};

  add('pokedex', 'número do Pokémon', !localPokemon.length || sameNumberList(localPokemon, remotePokemon));
  add('number', 'número exato da carta', normalizeCollectorId(remote?.localId) === normalizeCollectorId(card?.localId));
  add('setId', 'coleção exata', String(remote?.setId || '') === String(card?.setId || ''));
  add('setName', 'nome da coleção', normalize(remote?.setName) === normalize(card?.setName));
  add('illustrator', 'ilustrador', Boolean(remote?.illustrator) && normalize(remote?.illustrator) === normalize(card?.illustrator));
  add('promo', 'status promocional', Boolean(remote?.promotional) === isPromotionalCard(card));

  let finishOk = false;
  let finishReason = 'acabamento disponível';
  if (kind === 'normal') {
    finishOk = variants.normal === true;
  } else if (kind === 'reverse') {
    finishOk = variants.reverse === true;
    if (variants.reverse === true && variants.holo === true) finishReason = 'Cardmarket usa o mesmo preço foil para reversa e holográfica';
  } else if (kind === 'holo') {
    finishOk = variants.holo === true;
    if (variants.holo === true && variants.reverse === true) finishReason = 'Cardmarket usa o mesmo preço foil para holográfica e reversa';
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


function openCentralPriceDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('IndexedDB indisponível'));
    const request = indexedDB.open(CENTRAL_PRICE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CENTRAL_PRICE_DB_STORE)) db.createObjectStore(CENTRAL_PRICE_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Falha ao abrir banco de preços'));
  });
}

async function loadCentralPriceCache() {
  try {
    const db = await openCentralPriceDatabase();
    const cached = await new Promise((resolve, reject) => {
      const tx = db.transaction(CENTRAL_PRICE_DB_STORE, 'readonly');
      const req = tx.objectStore(CENTRAL_PRICE_DB_STORE).get(CENTRAL_PRICE_DB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (cached?.prices && typeof cached.prices === 'object') {
      centralPriceData = cached;
      centralPriceStatus = cached.meta || {};
    }
  } catch (_) {}
  return centralPriceData;
}

async function saveCentralPriceCache(payload) {
  const db = await openCentralPriceDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CENTRAL_PRICE_DB_STORE, 'readwrite');
    tx.objectStore(CENTRAL_PRICE_DB_STORE).put(payload, CENTRAL_PRICE_DB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function centralPriceGeneratedAt() {
  return centralPriceData?.meta?.generatedAt || centralPriceStatus?.generatedAt || null;
}

function centralFinishKey(finish) {
  const kind = finishKind(finish);
  if (kind === 'holo') return 'holo';
  if (kind === 'reverse') return 'reverse';
  return 'normal';
}

function centralPriceQuote(cardId, finish = 'comum') {
  const key = `${cardId}::${centralFinishKey(finish)}`;
  const item = centralPriceData?.prices?.[key];
  if (!item || !hasFiniteNumber(item.priceBrl) || Number(item.priceBrl) <= 0) return null;
  const confidenceNumber = Math.max(0, Math.min(100, Number(item.confidence) || 0));
  return {
    brl: Number(item.priceBrl),
    value: Number(item.priceBrl),
    currency: 'BRL',
    label: 'Preço Brasil',
    source: 'preco-brasil',
    provider: 'Pokémon Price Database Brasil',
    fetchedAt: new Date(item.updatedAt || centralPriceGeneratedAt() || Date.now()).getTime(),
    confidence: 'verified',
    confidencePercent: confidenceNumber,
    verified: true,
    usable: true,
    fingerprint: ['preco-brasil', key, item.priceBrl, item.updatedAt || centralPriceGeneratedAt() || ''].join('|'),
    validation: {
      reasons: confidenceNumber >= 70 ? [] : [`Confiança do banco central: ${confidenceNumber}%`],
      checks: ['ID exato', 'Acabamento', `${Array.isArray(item.sources) ? item.sources.length : 0} fonte(s)`],
    },
    sources: Array.isArray(item.sources) ? item.sources : [],
    central: true,
  };
}

async function syncCentralPrices(force = false) {
  if (centralPriceSyncing) return false;
  if (!force && Date.now() - centralPriceLastCheck < CENTRAL_PRICE_SYNC_TTL) return false;
  centralPriceSyncing = true;
  centralPriceLastCheck = Date.now();
  try {
    const status = await fetchJsonWithTimeout(`${CENTRAL_PRICE_STATUS_URL}?t=${Date.now()}`, 30000);
    if (!status || status.status !== 'complete' || !status.generatedAt) throw new Error('Banco central ainda não está completo.');
    centralPriceStatus = status;
    const localTime = new Date(centralPriceData?.meta?.generatedAt || 0).getTime();
    const remoteTime = new Date(status.generatedAt).getTime();
    if (!force && Number.isFinite(localTime) && Number.isFinite(remoteTime) && localTime >= remoteTime && Object.keys(centralPriceData?.prices || {}).length) {
      return false;
    }
    const payload = await fetchJsonWithTimeout(`${CENTRAL_PRICE_DATA_URL}?t=${Date.now()}`, 120000);
    if (!payload?.prices || typeof payload.prices !== 'object') throw new Error('Tabela central inválida.');
    payload.meta = payload.meta || status;
    centralPriceData = payload;
    centralPriceStatus = payload.meta;
    await saveCentralPriceCache(payload);
    let changed = false;
    for (const cardId of Object.keys(state?.entries || {})) changed = persistAutomaticPricesForCard(cardId, false) || changed;
    if (changed) saveState();
    if (ui.tab === 'dashboard') renderKeepingScroll();
    if (force) notify(`Preço Brasil atualizado · ${Object.keys(payload.prices).length.toLocaleString('pt-BR')} variantes.`);
    return true;
  } catch (error) {
    if (force) notify(`Banco de preços: ${error.message}`);
    return false;
  } finally {
    centralPriceSyncing = false;
  }
}

function centralPriceStatusPanel() {
  const meta = centralPriceStatus || centralPriceData?.meta || {};
  const variants = Number(meta.variantsPriced) || Object.keys(centralPriceData?.prices || {}).length;
  const cards = Number(meta.cardsInCatalog) || 0;
  const unmatched = Number(meta.unmatched) || 0;
  const date = meta.generatedAt ? formatPriceDate(meta.generatedAt) : 'ainda não sincronizado';
  return `<div class="catalog-last-result"><strong>Banco Preço Brasil</strong><br>${variants.toLocaleString('pt-BR')} variantes com preço${cards ? ` · ${cards.toLocaleString('pt-BR')} cartas no catálogo` : ''}${unmatched ? ` · ${unmatched.toLocaleString('pt-BR')} pendências` : ''}<br>Atualizado: ${esc(date)}</div>`;
}

function cardmarketMetric(cardmarket, kind) {
  const holo = kind === 'holo' || kind === 'reverse';
  const candidates = holo
    ? [
        ['trend-holo', 'tendência foil'],
        ['avg30-holo', 'média foil de 30 dias'],
        ['avg7-holo', 'média foil de 7 dias'],
        ['avg1-holo', 'média foil de 24 horas'],
        ['avg-holo', 'média histórica foil'],
        ['low-holo', 'menor oferta foil'],
      ]
    : [
        ['trend', 'tendência'],
        ['avg30', 'média de 30 dias'],
        ['avg7', 'média de 7 dias'],
        ['avg1', 'média de 24 horas'],
        ['avg', 'média histórica'],
        ['low', 'menor oferta'],
      ];
  for (const [field, label] of candidates) {
    if (hasFiniteNumber(cardmarket?.[field]) && Number(cardmarket[field]) > 0) {
      return { field, label, value: Number(cardmarket[field]) };
    }
  }
  return null;
}

function cardmarketTrendQuote(cardmarket, kind, card, remoteIdentity) {
  if (!cardmarket || typeof cardmarket !== 'object' || !card || !remoteIdentity) return null;
  const metric = cardmarketMetric(cardmarket, kind);
  if (!metric) return null;
  const validation = cardmarketValidation(card, remoteIdentity, kind);
  const finishLabel = kind === 'reverse' ? 'reversa' : kind === 'holo' ? 'holográfica/foil' : 'comum';
  const fingerprint = [
    card.id, kind, metric.field, metric.value, cardmarket.unit || 'EUR', cardmarket.updated || '',
    remoteIdentity.id, remoteIdentity.setId, remoteIdentity.localId, validation.confidence,
  ].join('|');
  return {
    value: metric.value,
    currency: cardmarket.unit || 'EUR',
    label: `Cardmarket · ${metric.label} · ${finishLabel}`,
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


async function fetchBestMarketPricing(cardId, finish = 'comum') {
  const card = cardMap.get(cardId);
  if (!card) throw new Error('Carta não encontrada no catálogo local.');
  const pricing = await fetchTcgDexPricing(cardId);
  const kind = finishKind(finish);

  let quote = cardmarketTrendQuote(pricing.cardmarket, kind, card, pricing.identity);
  if (!quote) quote = tcgplayerAverageQuote(pricing.tcgplayer, kind, card, pricing.identity);
  if (!quote) {
    throw new Error(`Nenhum dado público de mercado para ${card.name} (${card.setName || card.setId} ${card.localId}).`);
  }

  await ensureFxRates([quote.currency || 'EUR'], false);
  const converted = quoteInBrl(quote, pricing.fetchedAt);
  if (!converted) throw new Error(`Cotação ${quote.currency || 'EUR'}/BRL indisponível.`);
  return {
    ...converted,
    detail: pricing.detail,
    identity: pricing.identity,
    locale: pricing.locale,
  };
}

function fxRate(currency) {
  if (currency === 'BRL') return 1;
  const item = fxCache[currency];
  return hasFiniteNumber(item?.rate) ? Number(item.rate) : null;
}

function automaticPriceQuote(cardId, finish = 'comum') {
  const central = centralPriceQuote(cardId, finish);
  if (central) return central;
  const cached = priceCache[cardId];
  const card = cardMap.get(cardId);
  const kind = finishKind(finish);
  const quote = cached?.quotes?.[kind];
  if (!quote || !card || !hasFiniteNumber(quote.brl)) return null;
  return {
    ...quote,
    label: quote.label || 'Cardmarket · tendência',
    source: 'cardmarket',
    provider: 'Cardmarket via TCGdex',
    fingerprint: quote.fingerprint || [card.id, card.setId, card.localId, kind, quote.brl, 'cardmarket-trend'].join('|'),
  };
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
    label: variant.automaticPriceLabel || 'Cardmarket · tendência',
    source: variant.automaticPriceSource || 'cardmarket',
    provider: variant.automaticPriceProvider || 'Cardmarket via TCGdex',
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
  variant.automaticPriceSource = quote.source || 'cardmarket';
  variant.automaticPriceLabel = quote.label || 'Cardmarket · tendência';
  variant.automaticPriceProvider = quote.provider || 'Cardmarket via TCGdex';
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

async function ensureFxRates(currencies = ['EUR', 'USD'], force = false) {
  const requested = Array.from(new Set((Array.isArray(currencies) ? currencies : [currencies])
    .map(value => String(value || '').toUpperCase())
    .filter(value => value && value !== 'BRL')));
  if (!requested.length) return fxCache;
  const stale = requested.some(currency => force || !fxCache[currency]
    || !hasFiniteNumber(fxCache[currency].rate)
    || Date.now() - Number(fxCache[currency].fetchedAt || 0) >= FX_CACHE_TTL);
  if (stale) await loadFxRates(force);
  const missing = requested.filter(currency => !hasFiniteNumber(fxCache[currency]?.rate));
  if (missing.length) throw new Error(`Cotação indisponível: ${missing.join(', ')}.`);
  return fxCache;
}

async function fetchCardPricing(cardId, force = false, finish = 'comum') {
  const kind = finishKind(finish);
  if (!force && priceCacheFresh(cardId, finish)) return priceCache[cardId];
  const requestKey = `${cardId}|${kind}`;
  if (priceRequests.has(requestKey)) return priceRequests.get(requestKey);
  const request = (async () => {
    const card = cardMap.get(cardId);
    if (!card) throw new Error('Carta não encontrada no catálogo local.');
    if (force) await syncCentralPrices(false);
    const central = centralPriceQuote(cardId, finish);
    if (central) {
      const previous = priceCache[cardId] || {};
      priceCache[cardId] = {
        ...previous,
        logicVersion: PRICE_LOGIC_VERSION,
        fetchedAt: Date.now(),
        quotes: { ...(previous.quotes || {}), [kind]: { ...central, kind, fetchedAt: Date.now() } },
        diagnostics: central.validation?.reasons || [],
        identity: { id: card.id, setId: card.setId, localId: card.localId, name: card.name },
      };
      savePriceCache();
      return priceCache[cardId];
    }
    await ensureFxRates(['EUR', 'USD'], force);
    const cardmarket = await fetchBestMarketPricing(cardId, finish);
    cardmarket.kind = kind;
    cardmarket.fetchedAt = Date.now();
    const previous = priceCache[cardId] || {};
    priceCache[cardId] = {
      ...previous,
      logicVersion: PRICE_LOGIC_VERSION,
      fetchedAt: Date.now(),
      quotes: { ...(previous.quotes || {}), [kind]: cardmarket },
      diagnostics: cardmarket.validation?.reasons || [],
      identity: cardmarket.identity || { id: card.id, setId: card.setId, localId: card.localId, name: card.name },
    };
    savePriceCache();
    return priceCache[cardId];
  })().finally(() => priceRequests.delete(requestKey));
  priceRequests.set(requestKey, request);
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
    card.imageUrl = upgradeCardImageUrl(card.imageUrl);
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
    await loadCentralPriceCache();
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
      if (variantsFor(cardId).some(variant => priceCacheFresh(cardId, variant.finish || 'comum'))) migratedCachedPrices = persistAutomaticPricesForCard(cardId, false) || migratedCachedPrices;
    }
    if (migratedCachedPrices) saveState();
    renderTabs();
    render();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    setTimeout(() => checkForAppUpdate(false), 1800);
    setTimeout(() => syncCentralPrices(false), 2300);
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
      <div><strong>Preços de mercado</strong><span>${counts.priced} de ${counts.owned} cartas próprias com valor aceito${counts.pending ? ` · ${counts.pending} aguardando validação` : ''}${latest ? ` · última consulta ${esc(formatPriceDate(latest))}` : ''}</span></div>
      <span class="online-badge">Preço Brasil + fallback</span>
    </div>
    <p>Prioridade: valor manual → banco central Preço Brasil → Cardmarket/TCGplayer como reserva. O banco central é atualizado pelo GitHub e fica salvo no aparelho para uso offline.</p>
    ${centralPriceStatusPanel()}
    ${priceUpdating ? `<div class="catalog-progress"><div class="progress"><span style="width:${progress}%"></span></div><small>${esc(priceUpdateMessage || 'Consultando preços...')}</small></div>` : ''}
    <button class="primary-btn" ${priceUpdating ? 'disabled' : ''} onclick="startOwnedPriceUpdate()">${priceUpdating ? 'Atualizando...' : 'Atualizar preços da coleção'}</button>
    <button class="secondary-btn" ${centralPriceSyncing ? 'disabled' : ''} onclick="syncCentralPrices(true)">${centralPriceSyncing ? 'Sincronizando...' : 'Sincronizar Banco Preço Brasil'}</button>
    ${priceUpdateFailures ? `<div class="catalog-last-result">${priceUpdateFailures} carta(s) continuam sem dados públicos de mercado nesta tentativa.</div>` : ''}
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
  const targets = [];
  const seen = new Set();
  for (const cardId of Object.keys(state.entries)) {
    if (quantityFor(cardId) <= 0 || !cardMap.has(cardId)) continue;
    const variants = variantsFor(cardId).length ? variantsFor(cardId) : [defaultVariant(0)];
    for (const variant of variants) {
      const finish = variant.finish || 'comum';
      const key = `${cardId}|${finishKind(finish)}`;
      if (!seen.has(key)) { seen.add(key); targets.push({ cardId, finish }); }
    }
  }
  if (!targets.length) return notify('Nenhuma carta cadastrada para atualizar.');
  priceUpdating = true;
  priceUpdateFailures = 0;
  setPriceUpdateProgress('Pesquisando preços em todas as referências disponíveis...', 0, targets.length);
  try { await ensureFxRates(['EUR', 'USD'], false); } catch (_) {}

  const pendingTargets = targets.filter(item => !priceCacheFresh(item.cardId, item.finish));
  if (!pendingTargets.length) {
    let saved = 0;
    for (const cardId of new Set(targets.map(item => item.cardId))) if (persistAutomaticPricesForCard(cardId, false)) saved++;
    if (saved) saveState();
    priceUpdating = false;
    priceUpdateMessage = '';
    renderKeepingScroll();
    notify('Os preços de mercado já estão atualizados.');
    return;
  }

  priceUpdateTotal = pendingTargets.length;
  let cursor = 0;
  let completed = 0;
  const touchedCards = new Set();
  const worker = async () => {
    while (cursor < pendingTargets.length) {
      const index = cursor++;
      const { cardId, finish } = pendingTargets[index];
      const card = cardMap.get(cardId);
      setPriceUpdateProgress(`Mercados: ${card?.name || cardId} (${finish})...`, completed, pendingTargets.length);
      let updated = false;
      for (let attempt = 1; attempt <= 3 && !updated; attempt++) {
        try {
          await fetchCardPricing(cardId, true, finish);
          touchedCards.add(cardId);
          updated = true;
        } catch (error) {
          lastPriceDiagnostic = String(error?.message || error || 'Falha desconhecida');
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
        }
      }
      if (!updated) priceUpdateFailures++;
      completed++;
      await new Promise(resolve => setTimeout(resolve, 900));
      setPriceUpdateProgress(`Consultas: ${completed} de ${pendingTargets.length}`, completed, pendingTargets.length);
    }
  };
  await worker();
  let savedCards = 0;
  for (const cardId of touchedCards) if (persistAutomaticPricesForCard(cardId, false)) savedCards++;
  saveState();
  priceUpdating = false;
  priceUpdateMessage = '';
  renderKeepingScroll();
  notify(`Mercados: ${pendingTargets.length - priceUpdateFailures} preço(s) encontrado(s) · ${priceUpdateFailures} sem dados públicos.`);
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
      <span class="online-badge">TCGdex completo JA + EN + PT-BR</span>
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
  if (/assets\.tcgdex\.net/i.test(source)) {
    const root = source.replace(/\/(?:low|high)\.(?:webp|png|jpe?g)(\?.*)?$/i, '').replace(/\/$/, '');
    return `${root}/high.webp`;
  }
  if (/\.(webp|png|jpe?g)(\?.*)?$/i.test(source)) return source;
  return `${source.replace(/\/$/, '')}/high.webp`;
}

function upgradeCardImageUrl(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  if (!/assets\.tcgdex\.net/i.test(source)) return source;
  return source
    .replace(/\/low\.webp(\?.*)?$/i, '/high.webp$1')
    .replace(/\/low\.png(\?.*)?$/i, '/high.png$1');
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
    pokemonIds: Array.isArray(remote?.dexId) && remote.dexId.length ? remote.dexId : inferPokemonIds(remote?.name),
    illustrator: remote?.illustrator || null,
    category: remote?.category || null,
    variants: remote?.variants && typeof remote.variants === 'object' ? remote.variants : null,
    promotional: Boolean(remote?.variants?.wPromo)
      || /promo|black star/i.test(String(set.name || ''))
      || /(?:^|[-_.])p(?:$|[-_.])/i.test(String(set.id || '')),
  };
}

function inferSetIdFromRemoteCard(remote) {
  const explicit = String(remote?.set?.id || remote?.setId || '').trim();
  if (explicit) return explicit;
  const id = String(remote?.id || '').trim();
  const localId = String(remote?.localId || '').trim();
  if (id && localId && id.endsWith(`-${localId}`)) return id.slice(0, -(localId.length + 1));
  const split = id.lastIndexOf('-');
  return split > 0 ? id.slice(0, split) : '';
}

async function fetchCatalogLocale(base, localeLabel) {
  // A listagem direta /cards evita perder cartas quando uma consulta individual
  // de coleção falha. É também muito mais rápida do que abrir todos os sets.
  const [remoteSets, remoteCards] = await Promise.all([
    fetchJsonWithTimeout(`${base}/sets`, 60000),
    fetchJsonWithTimeout(`${base}/cards`, 90000),
  ]);
  if (!Array.isArray(remoteSets)) throw new Error(`${localeLabel}: lista de coleções inválida.`);
  if (!Array.isArray(remoteCards)) throw new Error(`${localeLabel}: lista de cartas inválida.`);

  const sets = new Map();
  for (const remote of remoteSets) {
    if (!remote?.id) continue;
    const set = normalizeRemoteSet(remote, remote);
    if (set.id) sets.set(set.id, set);
  }

  const cards = new Map();
  for (let index = 0; index < remoteCards.length; index++) {
    const remote = remoteCards[index];
    if (!remote?.id) continue;
    if (index % 500 === 0) {
      setCatalogUpdateProgress(`${localeLabel}: importando ${index.toLocaleString('pt-BR')} de ${remoteCards.length.toLocaleString('pt-BR')} cartas...`, index, remoteCards.length);
    }
    const setId = inferSetIdFromRemoteCard(remote);
    let set = sets.get(setId);
    if (!set) {
      const brief = remote?.set || {};
      set = {
        id: setId || String(brief.id || 'sem-colecao'),
        name: String(brief.name || setId || 'Coleção não identificada'),
        officialCardCount: Number(brief?.cardCount?.official) || 0,
        totalCardCount: Number(brief?.cardCount?.total) || 0,
        logoUrl: brief.logo || null,
        symbolUrl: brief.symbol || null,
      };
      sets.set(set.id, set);
    }
    const normalized = normalizeRemoteCard(remote, set);
    if (normalized.id) cards.set(normalized.id, normalized);
  }
  setCatalogUpdateProgress(`${localeLabel}: ${cards.size.toLocaleString('pt-BR')} cartas encontradas.`, remoteCards.length, remoteCards.length, true);
  return { sets, cards, failures: 0, listedCards: remoteCards.length };
}

async function startCatalogUpdate() {
  if (catalogUpdating) return;
  catalogUpdating = true;
  setCatalogUpdateProgress('Baixando o catálogo completo TCGdex EN, PT-BR e japonês...', 0, 1, true);

  try {
    const localSets = new Map((catalog.sets || []).map(item => [item.id, { ...item }]));
    const localCards = new Map((catalog.cards || []).map(item => [item.id, { ...item }]));
    const oldCardCount = localCards.size;
    const oldSetCount = localSets.size;

    let ptResult = { sets: new Map(), cards: new Map(), failures: 0 };
    let enResult = { sets: new Map(), cards: new Map(), failures: 0 };
    let jaResult = { sets: new Map(), cards: new Map(), failures: 0 };
    try { jaResult = await fetchCatalogLocale(TCGDEX_API_JAPANESE, 'Japonês'); } catch (_) {}
    try { enResult = await fetchCatalogLocale(TCGDEX_API_FALLBACK, 'Inglês'); } catch (_) {}
    try { ptResult = await fetchCatalogLocale(TCGDEX_API_BASE, 'Português'); } catch (_) {}
    if (!ptResult.cards.size && !enResult.cards.size && !jaResult.cards.size) throw new Error('Nenhum dos catálogos online respondeu.');

    // Japonês inclui impressões regionais; inglês amplia a cobertura internacional;
    // português sobrescreve nomes e imagens quando disponível.
    for (const [id, set] of jaResult.sets) localSets.set(id, { ...(localSets.get(id) || {}), ...set });
    for (const [id, card] of jaResult.cards) localCards.set(id, { ...(localCards.get(id) || {}), ...card, catalogLocale: 'ja' });
    for (const [id, set] of enResult.sets) localSets.set(id, { ...(localSets.get(id) || {}), ...set });
    for (const [id, card] of enResult.cards) localCards.set(id, { ...(localCards.get(id) || {}), ...card, catalogLocale: 'en' });
    for (const [id, set] of ptResult.sets) localSets.set(id, { ...(localSets.get(id) || {}), ...set });
    for (const [id, card] of ptResult.cards) {
      const existing = localCards.get(id) || {};
      localCards.set(id, {
        ...existing,
        ...card,
        imageUrl: card.imageUrl || existing.imageUrl || null,
        illustrator: card.illustrator || existing.illustrator || null,
        variants: card.variants || existing.variants || null,
        pokemonIds: card.pokemonIds?.length ? card.pokemonIds : (existing.pokemonIds || []),
        catalogLocale: 'pt-br',
      });
    }

    const updatedCatalog = {
      version: new Date().toISOString(),
      source: 'TCGdex completo JA + EN + PT-BR + catálogo local',
      sets: [...localSets.values()],
      cards: [...localCards.values()],
    };
    setCatalogUpdateProgress('Salvando catálogo ampliado para uso offline...', 1, 1, true);
    await saveUpdatedCatalog(updatedCatalog);
    catalog = updatedCatalog;
    rebuildCatalogIndexes();

    const result = {
      updatedAt: Date.now(),
      setsAdded: Math.max(0, localSets.size - oldSetCount),
      setsUpdated: localSets.size,
      cardsAdded: Math.max(0, localCards.size - oldCardCount),
      setsTotal: localSets.size,
      cardsTotal: localCards.size,
      failures: ptResult.failures + enResult.failures + jaResult.failures,
      enListedCards: enResult.listedCards || enResult.cards.size,
      ptListedCards: ptResult.listedCards || ptResult.cards.size,
      jaListedCards: jaResult.listedCards || jaResult.cards.size,
    };
    saveCatalogUpdateMeta(result);
    ui.cardLimit = 80;
    catalogUpdating = false;
    catalogUpdateMessage = '';
    render();
    notify(`Catálogo completo: ${result.cardsTotal.toLocaleString('pt-BR')} impressões únicas (+${result.cardsAdded.toLocaleString('pt-BR')}).`);
  } catch (error) {
    catalogUpdating = false;
    catalogUpdateMessage = '';
    renderKeepingScroll();
    notify(`Não foi possível atualizar: ${error?.message || 'erro de conexão'}`);
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
      <small>${displayQuote.stored ? 'Valor salvo na carta' : 'Consulta Cardmarket'} ${esc(formatPriceDate(displayQuote.fetchedAt))}${displayQuote.rate != null ? ` · câmbio ${displayQuote.currency}/BRL ${Number(displayQuote.rate).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}` : ''}</small>
      ${statusHtml}
      ${validationButton}
      <button type="button" class="price-refresh-btn" ${loading ? 'disabled' : ''} onclick="event.preventDefault();event.stopPropagation();updateCardPrice('${esc(cardId)}', document.getElementById('regFinish')?.value || '${esc(finish)}', true)">${loading ? 'Consultando...' : 'Atualizar agora'}</button>
    </div>`;
  }
  if (loading) return `<div class="automatic-price-card loading-price"><strong>Consultando preços de mercado...</strong><span>Aguarde alguns segundos.</span></div>`;
  return `<div class="automatic-price-card empty-price">
    <strong>Sem preço público disponível</strong>
    <span>Busca: Cardmarket Trend e médias → TCGplayer → último preço salvo.</span>
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
    await fetchCardPricing(cardId, force, finish);
    const saved = persistAutomaticPricesForCard(cardId, true);
    refreshAutomaticPriceField(cardId, finish);
    renderKeepingScroll();
    const quote = automaticPriceQuote(cardId, finish);
    notify(quote
      ? (quote.confidence === 'verified'
        ? (saved ? 'Preço de mercado salvo' : 'Preço de mercado encontrado')
        : 'Preço de mercado encontrado para revisão')
      : 'Nenhum mercado retornou preço para esta carta.');
  } catch (error) {
    refreshAutomaticPriceField(cardId, finish);
    const message = error?.name === 'AbortError' ? 'A consulta demorou demais.' : String(error?.message || 'Não foi possível consultar o preço agora.');
    lastPriceDiagnostic = message;
    try { localStorage.setItem('fichario-price-last-diagnostic', message); } catch (_) {}
    notify(message.length > 180 ? `${message.slice(0, 177)}...` : message);
  }
}

function ensureCardPriceLoaded(cardId, finish) {
  if (priceCacheFresh(cardId, finish)) {
    if (persistAutomaticPricesForCard(cardId, true)) renderKeepingScroll();
    return;
  }
  if (priceRequests.has(`${cardId}|${finishKind(finish)}`)) return;
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
      <div class="registration-image-frame" data-fichario-card-image="${esc(card.id)}">
        ${card.imageUrl ? `<img class="registration-card-image" src="${esc(upgradeCardImageUrl(card.imageUrl))}" alt="Arte de ${esc(card.name)}">` : '<div class="registration-placeholder">TCG</div>'}
      </div>
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
        ${registrationField('Quantidade', `<div class="quantity-stepper"><button type="button" class="quantity-step-btn" onclick="changeRegistrationQuantity(-1)" aria-label="Diminuir quantidade">−</button><input id="regQuantity" class="field quantity-step-value" type="number" inputmode="numeric" min="0" step="1" value="${Math.max(0, Number(draft.quantity) || 0)}"><button type="button" class="quantity-step-btn" onclick="changeRegistrationQuantity(1)" aria-label="Aumentar quantidade">+</button></div>`)}
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

function changeRegistrationQuantity(delta) {
  const input = document.getElementById('regQuantity');
  if (!input) return;
  const current = Math.max(0, Number.parseInt(input.value || '0', 10) || 0);
  input.value = String(Math.max(0, current + Number(delta || 0)));
  input.dispatchEvent(new Event('change', { bubbles: true }));
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

function deckCardTypes(card) {
  const types = new Set();
  for (const pokemonId of (card?.pokemonIds || [])) {
    const pokemon = pokemonMap.get(Number(pokemonId));
    for (const type of (pokemon?.types || [])) types.add(type);
  }
  return [...types];
}

function deckNameKey(card) {
  return normalize(card?.name || '');
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

function deckNameQuantity(deck, card, ignoreCardId = null) {
  const key = deckNameKey(card);
  return Object.entries(deck?.cards || {}).reduce((sum, [cardId, qty]) => {
    if (cardId === ignoreCardId) return sum;
    const other = cardMap.get(cardId);
    return sum + (other && deckNameKey(other) === key ? Math.max(0, Number(qty) || 0) : 0);
  }, 0);
}

function deckStrengthScore(card, preferredType = '') {
  const name = normalize(card?.name);
  let score = 1;
  if (/\bex\b|vmax|vstar|\bgx\b/.test(name)) score += 14;
  else if (/\bv\b|break|prime|level x/.test(name)) score += 9;
  if (/ordens do chefe|boss|pesquisa de professores|professor|ultra bola|bola ninho|ninho|captura|doce raro|rare candy|troca|switch|recuperacao|recuperação/.test(name)) score += 8;
  if (/energia|energy/.test(name)) score += 3;
  if (preferredType && deckCardTypes(card).includes(preferredType)) score += 10;
  score += Math.min(4, quantityFor(card.id));
  return score;
}

function deckValidation(deck) {
  const errors = [];
  const warnings = [];
  const total = deckTotal(deck);
  const split = deckBreakdown(deck);
  if (total !== 60) errors.push(`O deck precisa ter exatamente 60 cartas; atualmente tem ${total}.`);
  if (!split.pokemon) errors.push('O deck precisa ter pelo menos um Pokémon.');
  if (!split.energy) warnings.push('Nenhuma Energia foi encontrada no deck.');
  if (split.pokemon < 10) warnings.push('Poucos Pokémon: o deck pode ter dificuldade para iniciar a partida.');
  if (split.trainer < 20) warnings.push('Poucos Treinadores: o deck pode ficar inconsistente.');
  const byName = new Map();
  for (const [cardId, qtyRaw] of Object.entries(deck?.cards || {})) {
    const card = cardMap.get(cardId);
    const qty = Math.max(0, Number(qtyRaw) || 0);
    if (!card || !qty) continue;
    if (qty > quantityFor(cardId)) errors.push(`${card.name}: o deck usa ${qty}, mas você possui ${quantityFor(cardId)}.`);
    if (deckCardClass(card) !== 'energy') {
      const key = deckNameKey(card);
      byName.set(key, { name: card.name, qty: (byName.get(key)?.qty || 0) + qty });
    }
  }
  for (const item of byName.values()) if (item.qty > 4) errors.push(`${item.name}: máximo de 4 cópias somando todas as versões.`);
  const score = Math.max(0, Math.min(100, 100 - errors.length * 25 - warnings.length * 7 + (total === 60 ? 10 : 0)));
  return { valid: !errors.length, errors, warnings, score, total, split };
}

function addDeckCardQuantity(target, cardId, wanted) {
  const card = cardMap.get(cardId);
  if (!card) return 0;
  const available = quantityFor(cardId);
  const current = Math.max(0, Number(target[cardId]) || 0);
  const sameNameElsewhere = deckCardClass(card) === 'energy' ? 0 : deckNameQuantity({ cards: target }, card, cardId);
  const nameLimit = deckCardClass(card) === 'energy' ? 60 : Math.max(0, 4 - sameNameElsewhere);
  const allowed = Math.min(available, deckCardLimit(card), nameLimit);
  const room = Math.max(0, 60 - Object.values(target).reduce((a,b)=>a+Math.max(0,Number(b)||0),0));
  const add = Math.max(0, Math.min(Number(wanted) || 0, allowed - current, room));
  if (add) target[cardId] = current + add;
  return add;
}

function availableDeckTypes() {
  const counts = new Map();
  for (const item of ownedDeckPool()) for (const type of deckCardTypes(item.card)) counts.set(type, (counts.get(type) || 0) + item.owned);
  return [...counts.entries()].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0],'pt-BR'));
}

function generateStrongDeck() {
  const pool = ownedDeckPool();
  if (!pool.length) return notify('Cadastre cartas antes de gerar um deck.');
  const preferredType = document.getElementById('deckPreferredType')?.value || '';
  const groups = { pokemon: [], trainer: [], energy: [] };
  pool.forEach(item => groups[deckCardClass(item.card)].push(item));
  Object.values(groups).forEach(list => list.sort((a,b) => deckStrengthScore(b.card, preferredType)-deckStrengthScore(a.card, preferredType) || b.owned-a.owned || a.card.name.localeCompare(b.card.name,'pt-BR')));
  if (preferredType) groups.pokemon.sort((a,b) => Number(deckCardTypes(b.card).includes(preferredType))-Number(deckCardTypes(a.card).includes(preferredType)) || deckStrengthScore(b.card,preferredType)-deckStrengthScore(a.card,preferredType));
  const target = {};
  const fill = (list, desired) => {
    let added = 0;
    for (const item of list) {
      if (added >= desired || deckTotal({cards:target}) >= 60) break;
      added += addDeckCardQuantity(target, item.card.id, Math.min(item.owned, desired-added));
    }
    return added;
  };
  fill(groups.pokemon, 16);
  fill(groups.trainer, 32);
  fill(groups.energy, 12);
  const all = [...groups.trainer, ...groups.pokemon, ...groups.energy];
  for (const item of all) {
    if (deckTotal({cards:target}) >= 60) break;
    addDeckCardQuantity(target, item.card.id, 60-deckTotal({cards:target}));
  }
  state.decks = state.decks || [];
  const deck = { id: `deck-${Date.now()}`, name: `Deck forte ${preferredType || state.decks.length + 1}`, cards: target, preferredType, createdAt: new Date().toISOString(), generated: true };
  state.decks.push(deck);
  selectedDeckId = deck.id;
  saveState(); render();
  const validation = deckValidation(deck);
  notify(validation.valid ? 'Deck válido de 60 cartas criado.' : `Deck criado com ${validation.total} cartas. Confira os avisos.`);
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
  const report = deckValidation(deck);
  const entries = Object.entries(deck.cards || {}).filter(([,q]) => Number(q)>0).sort((a,b)=>deckCardClass(cardMap.get(a[0])).localeCompare(deckCardClass(cardMap.get(b[0]))) || (cardMap.get(a[0])?.name||'').localeCompare(cardMap.get(b[0])?.name||'','pt-BR'));
  const messages = [...report.errors.map(x=>`<li class="deck-error">${esc(x)}</li>`), ...report.warnings.map(x=>`<li class="deck-warning">${esc(x)}</li>`)].join('');
  return `<section class="screen">
    <button class="back-btn" onclick="selectedDeckId=null;render()">← Voltar aos decks</button>
    <div class="deck-editor-head"><div><h2 class="screen-title">${esc(deck.name)}</h2><p class="screen-subtitle">Edite usando somente as cartas que você possui.</p></div><button class="danger-btn compact-btn" onclick="deleteDeck('${esc(deck.id)}')">Excluir</button></div>
    <div class="deck-summary ${report.valid?'valid':'invalid'}"><strong>${report.total}/60 cartas · força ${report.score}/100</strong><span>${report.split.pokemon} Pokémon · ${report.split.trainer} Treinadores · ${report.split.energy} Energias</span><small>${report.valid?'Deck validado para batalha.':'Ainda existem ajustes necessários.'}</small></div>
    ${messages ? `<ul class="deck-validation">${messages}</ul>` : ''}
    <div class="deck-actions"><button class="secondary-btn" onclick="renameDeck('${esc(deck.id)}')">Renomear</button><button class="secondary-btn" onclick="duplicateDeck('${esc(deck.id)}')">Duplicar</button><button class="secondary-btn" onclick="exportDeckList('${esc(deck.id)}')">Exportar lista</button></div>
    <div class="deck-search"><input id="deckCardSearch" class="field" placeholder="Buscar nas minhas cartas"><button class="primary-btn" onclick="openDeckCardPicker('${esc(deck.id)}')">Adicionar carta</button></div>
    <div class="deck-card-list">${entries.length ? entries.map(([id,q])=>renderDeckCardRow(deck,id,q)).join('') : '<div class="empty">Este deck ainda está vazio.</div>'}</div>
  </section>`;
}

function renderDecks() {
  const decks = state.decks || [];
  const selected = decks.find(deck => deck.id === selectedDeckId);
  if (selected) return renderDeckEditor(selected);
  const types = availableDeckTypes();
  return `<section class="screen">
    <h2 class="screen-title">Decks</h2>
    <p class="screen-subtitle">Monte um baralho de 60 cartas usando apenas o que existe no seu fichário. O gerador prioriza Pokémon do tipo escolhido e cartas de suporte.</p>
    <div class="deck-generator"><select id="deckPreferredType" class="field"><option value="">Melhor combinação geral</option>${types.map(([type,count])=>`<option value="${esc(type)}">Foco ${esc(type)} (${count} cópias)</option>`).join('')}</select><button class="primary-btn" onclick="generateStrongDeck()">⚔️ Montar deck forte</button></div>
    <div class="deck-row"><input id="deckName" class="field" placeholder="Nome do novo deck"><button class="primary-btn" onclick="addDeck()">Criar vazio</button></div>
    <div class="set-list">${decks.length ? decks.map(deck => { const report=deckValidation(deck); return `<button class="panel deck-panel" onclick="selectedDeckId='${esc(deck.id)}';render()"><div class="set-title-row"><span class="set-name">${esc(deck.name)}</span><span class="badge ${report.valid?'owned':''}">${report.total}/60</span></div><p class="card-meta">${report.split.pokemon} Pokémon · ${report.split.trainer} Treinadores · ${report.split.energy} Energias · força ${report.score}/100</p></button>`; }).join('') : '<div class="empty"><strong>Nenhum deck criado</strong>Use o gerador automático ou crie um deck vazio.</div>'}</div>
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

function renameDeck(id) {
  const deck = (state.decks || []).find(item => item.id === id);
  if (!deck) return;
  const name = prompt('Novo nome do deck:', deck.name);
  if (!name?.trim()) return;
  deck.name = name.trim(); saveState(); render();
}

function duplicateDeck(id) {
  const source = (state.decks || []).find(item => item.id === id);
  if (!source) return;
  const copy = { ...source, id:`deck-${Date.now()}`, name:`${source.name} (cópia)`, cards:{...(source.cards||{})}, createdAt:new Date().toISOString(), generated:false };
  state.decks.push(copy); selectedDeckId=copy.id; saveState(); render(); notify('Deck duplicado.');
}

function exportDeckList(id) {
  const deck = (state.decks || []).find(item => item.id === id);
  if (!deck) return;
  const lines = Object.entries(deck.cards || {}).filter(([,q])=>Number(q)>0).map(([cardId,qty])=>{const card=cardMap.get(cardId);return card?`${qty}x ${card.name} — ${card.setName} ${card.number}`:''}).filter(Boolean);
  const text = `${deck.name}\n\n${lines.join('\n')}\n\nTotal: ${deckTotal(deck)} cartas`;
  if (navigator.share) navigator.share({title:deck.name,text}).catch(()=>{});
  else if (navigator.clipboard) navigator.clipboard.writeText(text).then(()=>notify('Lista copiada.')).catch(()=>showModal(`<pre>${esc(text)}</pre>`));
  else showModal(`<button class="modal-close" onclick="closeModal()">×</button><h2>${esc(deck.name)}</h2><pre>${esc(text)}</pre>`);
}

function changeDeckCard(deckId, cardId, delta) {
  const deck = (state.decks || []).find(item => item.id === deckId);
  const card = cardMap.get(cardId);
  if (!deck || !card) return;
  deck.cards = deck.cards || {};
  const current = Math.max(0, Number(deck.cards[cardId]) || 0);
  const sameNameElsewhere = deckCardClass(card) === 'energy' ? 0 : deckNameQuantity(deck, card, cardId);
  const nameLimit = deckCardClass(card) === 'energy' ? 60 : Math.max(0, 4-sameNameElsewhere);
  const max = Math.min(quantityFor(cardId), deckCardLimit(card), nameLimit);
  const roomMax = current + Math.max(0, 60-deckTotal(deck));
  const next = Math.max(0, Math.min(max, roomMax, current + Number(delta || 0)));
  if (next) deck.cards[cardId] = next; else delete deck.cards[cardId];
  if (delta > 0 && next === current) notify(deckTotal(deck)>=60 ? 'O deck já tem 60 cartas.' : 'Limite de cópias atingido.');
  saveState(); render();
}

function openDeckCardPicker(deckId) {
  const deck = (state.decks || []).find(item => item.id === deckId);
  if (!deck) return;
  const query = normalize(document.getElementById('deckCardSearch')?.value || '');
  const pool = ownedDeckPool().filter(item => !query || normalize(`${item.card.name} ${item.card.number} ${item.card.setName}`).includes(query)).sort((a,b)=>deckStrengthScore(b.card,deck.preferredType)-deckStrengthScore(a.card,deck.preferredType)).slice(0,160);
  showModal(`<button class="modal-close" onclick="closeModal()">×</button><h2>Adicionar carta ao deck</h2><p class="screen-subtitle">Respeita sua quantidade, o limite de 4 cópias pelo mesmo nome e o máximo de 60 cartas.</p><div class="deck-picker">${pool.length ? pool.map(item=>`<button onclick="changeDeckCard('${esc(deckId)}','${esc(item.card.id)}',1);closeModal()"><strong>${esc(item.card.name)}</strong><span>${esc(item.card.number)} · ${esc(item.card.setName)} · você tem ${item.owned} · ${deckCardClass(item.card)}</span></button>`).join('') : '<div class="empty">Nenhuma carta encontrada.</div>'}</div>`);
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
      <button class="secondary-btn" onclick="checkForAppUpdate(true)">Verificar atualização</button>
    </div>`);
}

async function exportBackup() {
  try {
    const localImages = await window.FicharioLocalImages?.exportData?.() || [];
    const payload = JSON.stringify({
      format: 'fichario-pokemon-br-plus-backup',
      backupVersion: 2,
      exportedAt: new Date().toISOString(),
      state,
      priceCache,
      fxCache,
      ligaSetCache,
      localImages,
    }, null, 2);
    if (window.Android?.exportBackup) window.Android.exportBackup(payload);
    else {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([payload], {type:'application/json'}));
      link.download = 'fichario-pokemon-backup.json';
      link.click();
    }
  } catch (_) {
    notify('Não foi possível preparar o backup');
  }
}

function importBackup() {
  if (window.Android?.importBackup) window.Android.importBackup();
}

window.receiveImportedBackup = async function(raw) {
  try {
    const payload = JSON.parse(raw);
    if (payload?.format !== 'fichario-pokemon-br-plus-backup' || !payload.state?.entries) throw new Error('Formato inválido');
    const migrated = migrateState(payload.state);
    if (!migrated) throw new Error('Estado inválido');
    state = migrated;
    if (payload.priceCache && typeof payload.priceCache === 'object') { priceCache = payload.priceCache; savePriceCache(); }
    if (payload.fxCache && typeof payload.fxCache === 'object') { fxCache = payload.fxCache; saveFxCache(); }
    if (payload.ligaSetCache && typeof payload.ligaSetCache === 'object') { ligaSetCache = payload.ligaSetCache; saveLigaSetCache(); }
    let restoredImages = 0;
    if (Array.isArray(payload.localImages)) {
      restoredImages = await window.FicharioLocalImages?.importData?.(payload.localImages, true) || 0;
    }
    saveState();
    closeModal();
    render();
    notify(restoredImages ? `Backup importado · ${restoredImages} imagens restauradas` : 'Backup importado com sucesso');
  } catch (_) {
    notify('Este arquivo não é um backup válido');
  }
};

function markdownToSafeHtml(text) {
  const safe = esc(String(text || ''));
  return safe
    .replace(/^###\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/^##\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/^#\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/^[-*]\s+(.+)$/gm, '✓ $1')
    .replace(/\n/g, '<br>');
}

function checkForAppUpdate(manual = true) {
  if (updateCheckInProgress) return;
  if (!window.Android?.checkForUpdate) {
    if (manual) notify('Verificação disponível apenas no aplicativo Android.');
    return;
  }
  updateCheckInProgress = true;
  if (manual) notify('Verificando atualizações...');
  window.Android.checkForUpdate();
}

window.receiveUpdateInfo = function(raw) {
  updateCheckInProgress = false;
  try {
    const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!info?.ok) {
      if (info?.error) notify(`Atualização: ${info.error}`);
      return;
    }
    latestUpdateInfo = info;
    if (!info.updateAvailable) {
      if (document.getElementById('modal') && !document.getElementById('modal').classList.contains('hidden')) {
        notify(`Você já está na versão mais recente (${info.currentVersion}).`);
      }
      return;
    }
    showUpdateModal(info);
  } catch (_) {
    notify('Não foi possível interpretar a atualização disponível.');
  }
};

function showUpdateModal(info) {
  showModal(`
    <button class="modal-close" onclick="closeModal()">×</button>
    <div class="update-hero">⬆</div>
    <h2>${esc(info.latestVersion || 'Nova versão disponível')}</h2>
    <p class="screen-subtitle">Instalada: ${esc(info.currentVersion || '')} · atualização assinada e compatível.</p>
    <div class="panel update-notes"><strong>Novidades</strong><p>${markdownToSafeHtml(info.notes || 'Melhorias e correções.')}</p></div>
    <p id="update-status" class="card-meta">O aplicativo baixará o APK oficial publicado no GitHub.</p>
    <div class="backup-actions">
      <button class="primary-btn" onclick="startAppUpdate()">Atualizar agora</button>
      <button class="secondary-btn" onclick="closeModal()">Depois</button>
    </div>`);
}

function startAppUpdate() {
  if (!latestUpdateInfo?.apkUrl || !window.Android?.downloadAndInstallUpdate) {
    notify('Link da atualização indisponível.');
    return;
  }
  const status = document.getElementById('update-status');
  if (status) status.textContent = 'Iniciando download...';
  window.Android.downloadAndInstallUpdate(latestUpdateInfo.apkUrl, latestUpdateInfo.apkName || 'Fichario-Pokemon.apk');
}

window.receiveUpdateDownload = function(success, message) {
  const status = document.getElementById('update-status');
  if (status) status.textContent = message || '';
  if (success === false) notify(message || 'Falha ao baixar atualização.');
};

window.handleAndroidBack = function() {
  const modal = document.getElementById('modal');
  if (modal && !modal.classList.contains('hidden')) { closeModal(); return true; }
  if (ui.tab === 'pokedex' && ui.selectedPokemon) { ui.selectedPokemon = null; render(); return true; }
  if (ui.tab !== 'dashboard') { setTab('dashboard'); return true; }
  return false;
};

init();
