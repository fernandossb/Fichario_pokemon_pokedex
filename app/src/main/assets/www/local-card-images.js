'use strict';

(() => {
  const DB_NAME = 'fichario-pokemon-local-images-v1';
  const STORE_NAME = 'images';
  const CARD_RATIO = 5 / 7;
  const MAX_WIDTH = 700;
  const MAX_HEIGHT = 980;
  let activeCardId = '';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'cardId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function get(cardId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(String(cardId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function put(cardId, dataUrl) {
    const db = await openDb();
    const item = { cardId: String(cardId), dataUrl, savedAt: Date.now() };
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(item);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return item;
  }

  async function remove(cardId) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(String(cardId));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function all() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => reject(req.error);
    });
  }

  function ensureInputs() {
    if (document.getElementById('local-card-image-gallery')) return;
    const gallery = document.createElement('input');
    gallery.id = 'local-card-image-gallery';
    gallery.type = 'file';
    gallery.accept = 'image/*';
    gallery.hidden = true;
    gallery.addEventListener('change', event => receiveFile(event.target.files?.[0]));
    document.body.appendChild(gallery);

    const camera = document.createElement('input');
    camera.id = 'local-card-image-camera';
    camera.type = 'file';
    camera.accept = 'image/*';
    camera.setAttribute('capture', 'environment');
    camera.hidden = true;
    camera.addEventListener('change', event => receiveFile(event.target.files?.[0]));
    document.body.appendChild(camera);
  }

  function choose(cardId, source) {
    activeCardId = String(cardId || '');
    ensureInputs();
    const input = document.getElementById(source === 'camera' ? 'local-card-image-camera' : 'local-card-image-gallery');
    input.value = '';
    input.click();
  }

  function imageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('Imagem inválida'));
        image.onload = () => resolve(image);
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function compress(file) {
    const image = await imageFromFile(file);
    let sourceX = 0, sourceY = 0, sourceWidth = image.naturalWidth, sourceHeight = image.naturalHeight;
    const sourceRatio = sourceWidth / sourceHeight;
    if (sourceRatio > CARD_RATIO) {
      sourceWidth = sourceHeight * CARD_RATIO;
      sourceX = (image.naturalWidth - sourceWidth) / 2;
    } else {
      sourceHeight = sourceWidth / CARD_RATIO;
      sourceY = (image.naturalHeight - sourceHeight) / 2;
    }
    const scale = Math.min(1, MAX_WIDTH / sourceWidth, MAX_HEIGHT / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  async function receiveFile(file) {
    if (!file || !activeCardId) return;
    try {
      if (!String(file.type || '').startsWith('image/')) throw new Error('Selecione uma imagem');
      const dataUrl = await compress(file);
      await put(activeCardId, dataUrl);
      window.FicharioImageFallback?.retry(activeCardId);
      closeModal?.();
      render?.();
      notify?.('Imagem local salva');
    } catch (error) {
      notify?.(error?.message || 'Não foi possível salvar a imagem');
    }
  }

  async function openPicker(cardId) {
    activeCardId = String(cardId || '');
    const existing = await get(activeCardId);
    const removeButton = existing ? `<button class="danger-btn" onclick="FicharioLocalImages.removeImage('${activeCardId}')">Remover imagem local</button>` : '';
    showModal(`
      <button class="modal-close" onclick="closeModal()">×</button>
      <h2>${existing ? 'Trocar imagem da carta' : 'Adicionar imagem da carta'}</h2>
      <p class="screen-subtitle">A imagem ficará somente neste aparelho e será incluída no backup.</p>
      <div class="local-image-actions">
        <button class="primary-btn" onclick="FicharioLocalImages.choose('${activeCardId}','camera')">Tirar foto</button>
        <button class="secondary-btn" onclick="FicharioLocalImages.choose('${activeCardId}','gallery')">Escolher da galeria</button>
        ${removeButton}
      </div>
      <p class="card-meta">A foto será centralizada, recortada no formato de uma carta e comprimida automaticamente.</p>
    `);
  }

  async function removeImage(cardId) {
    const id = String(cardId || '');
    if (!window.confirm('Remover a imagem local desta carta?')) return;
    await remove(id);
    window.FicharioImageFallback?.retry(id);
    closeModal?.();
    render?.();
    notify?.('Imagem local removida');
  }

  async function exportData() {
    return await all();
  }

  async function importData(items, replace = true) {
    if (!Array.isArray(items)) return 0;
    const db = await openDb();
    if (replace) {
      await new Promise((resolve, reject) => {
        const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
    let count = 0;
    for (const item of items) {
      if (!item?.cardId || !String(item?.dataUrl || '').startsWith('data:image/')) continue;
      await put(item.cardId, item.dataUrl);
      count++;
    }
    return count;
  }

  function injectModalButton() {
    const modal = document.getElementById('modal-content');
    if (!modal || !activeCardId || modal.querySelector('.local-card-image-toolbar')) return;
    const art = modal.querySelector('.registration-card-image, .registration-placeholder, [data-card-art-id]');
    if (!art) return;
    const toolbar = document.createElement('div');
    toolbar.className = 'local-card-image-toolbar';
    toolbar.innerHTML = `<button class="secondary-btn compact-btn" onclick="FicharioLocalImages.open('${activeCardId}')">Imagem: câmera/galeria</button>`;
    art.insertAdjacentElement('afterend', toolbar);
  }

  try {
    if (typeof openCard === 'function') {
      const original = openCard;
      openCard = function(cardId, ...args) {
        activeCardId = String(cardId || '');
        const result = original.call(this, cardId, ...args);
        requestAnimationFrame(injectModalButton);
        return result;
      };
    }
  } catch (_) {}

  const observer = new MutationObserver(() => requestAnimationFrame(injectModalButton));
  const start = () => {
    ensureInputs();
    observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.FicharioLocalImages = {
    get,
    open: openPicker,
    choose,
    removeImage,
    exportData,
    importData,
  };
})();
