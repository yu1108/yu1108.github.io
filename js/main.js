let bleDevice, gattServer;
let epdService, epdCharacteristic;
let startTime, msgIndex, appVersion;
let canvas, ctx, textDecoder;
let paintManager, cropManager;
let bleWriteChain = Promise.resolve();
let currentPinsValue = '';
let ditherSourceImageData = null;
let ditherPreviewActive = false;
let pageExitDisconnecting = false;
let slotState = { count: 0, usedMask: 0, selected: null, fingerprints: [] };
let slotReadState = null;
let slotImageCache = new Map();
let slotImageCacheScope = '';
let slotPreviewPending = new Set();
let rleSupport = false;
let imageTransferActive = false;
let imageRefreshPending = false;
let imageRefreshTimer = null;
let slotActionPending = false;
let slotActionTimer = null;
let slotReadTimer = null;
let slotEraseAllPending = false;
let displayErrorActive = false;

const MAX_SLOT_IMAGE_SIZE = 1024 * 1024;
const DEFAULT_SLOT_READ_RAW_CHUNK_SIZE = 256;
const SLOT_READ_TIMEOUT_MS = 5000;
const SLOT_READ_INFO_TIMEOUT_MS = 8000;
const SLOT_CHUNK_MAX_RETRIES = 2;
const IMAGE_REFRESH_TIMEOUT_MS = 95000;
const SLOT_IMAGE_CACHE_PREFIX = 'epd-slot-preview-v1:';
const SLOT_PREVIEW_MAX_EDGE = 480;
const SLOT_PREVIEW_JPEG_QUALITY = 0.88;

const PAGE_BACKGROUND_STORAGE_KEY = 'epdCustomPageBackground';
const PAGE_BACKGROUND_SETTINGS_STORAGE_KEY = 'epdCustomPageBackgroundSettings';
const UI_OPACITY_STORAGE_KEY = 'epdUiOpacity';
const GLASS_CLARITY_STORAGE_KEY = 'epdGlassClarity';
const PAGE_BACKGROUND_MAX_SIZE = 1920;
const PAGE_BACKGROUND_QUALITY = 0.82;
const DEFAULT_UI_OPACITY = 0.88;
const DEFAULT_GLASS_CLARITY = 0;
const MAX_GLASS_BLUR = 24;
const DEFAULT_PAGE_BACKGROUND_SETTINGS = {
  fit: 'contain',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotate: 0,
  flipX: false,
  flipY: false,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  mask: 0.22
};

const EPD_SERVICE_UUID = '62750001-d828-918d-fb46-b6c11c675aec';
const EPD_CHARACTERISTIC_UUID = '62750002-d828-918d-fb46-b6c11c675aec';
const EPD_VERSION_UUID = '62750003-d828-918d-fb46-b6c11c675aec';

const EpdCmd = {
  SET_PINS: 0x00,
  INIT: 0x01,
  CLEAR: 0x02,
  SEND_CMD: 0x03,
  SEND_DATA: 0x04,
  REFRESH: 0x05,
  SLEEP: 0x06,

  SET_TIME: 0x20,
  SET_WEEK_START: 0x21,

  WRITE_IMG: 0x30, // v1.6
  SET_SLOT: 0x31,
  FREE_SLOT: 0x32,
  SET_SLIDE: 0x33,
  GET_IMAGE: 0x34,

  SET_CONFIG: 0x90,
  SYS_RESET: 0x91,
  SYS_SLEEP: 0x92,
  CFG_ERASE: 0x99,
};

const EPD_CONFIG_SIZE = 14;

const canvasSizes = [
  { name: '1.54_152_152', width: 152, height: 152 },
  { name: '1.54_200_200', width: 200, height: 200 },
  { name: '2.13_212_104', width: 212, height: 104 },
  { name: '2.13_250_122', width: 250, height: 122 },
  { name: '2.66_296_152', width: 296, height: 152 },
  { name: '2.9_296_128', width: 296, height: 128 },
  { name: '2.9_384_168', width: 384, height: 168 },
  { name: '3.5_360_240', width: 360, height: 240 },
  { name: '3.7_416_240', width: 416, height: 240 },
  { name: '3.97_800_480', width: 800, height: 480 },
  { name: '3.98_768_552', width: 768, height: 552 },
  { name: '3.98_800_600', width: 800, height: 600 },
  { name: '3.87_800_480', width: 800, height: 480 },
  { name: '9.7_960_680', width: 960, height: 680 },
  { name: '4.2_400_300', width: 400, height: 300 },
  { name: '5.79_792_272', width: 792, height: 272 },
  { name: '5.83_600_448', width: 600, height: 448 },
  { name: '5.83_648_480', width: 648, height: 480 },
  { name: '7.5_640_384', width: 640, height: 384 },
  { name: '7.5_800_480', width: 800, height: 480 },
  { name: '7.5_880_528', width: 880, height: 528 },
  { name: '10.2_960_640', width: 960, height: 640 },
  { name: '10.85_1360_480', width: 1360, height: 480 },
  { name: '11.6_960_640', width: 960, height: 640 },
  { name: '4E_600_400', width: 600, height: 400 },
  { name: '7.3E6', width: 480, height: 800 }
];

function hex2bytes(hex) {
  for (var bytes = [], c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return new Uint8Array(bytes);
}

function bytes2hex(data) {
  return new Uint8Array(data).reduce(
    function (memo, i) {
      return memo + ("0" + i.toString(16)).slice(-2);
    }, "");
}

function intToHex(intIn) {
  let stringOut = ("0000" + intIn.toString(16)).substr(-4)
  return stringOut.substring(2, 4) + stringOut.substring(0, 2);
}

function resetVariables(options = {}) {
  const clearLog = options.clearLog !== false;
  gattServer = null;
  epdService = null;
  epdCharacteristic = null;
  msgIndex = 0;
  bleWriteChain = Promise.resolve();
  currentPinsValue = '';
  slotState = { count: 0, usedMask: 0, selected: null, fingerprints: [] };
  if (slotReadTimer != null) clearTimeout(slotReadTimer);
  slotReadTimer = null;
  slotReadState = null;
  slotImageCache = new Map();
  slotImageCacheScope = '';
  slotPreviewPending = new Set();
  rleSupport = false;
  imageTransferActive = false;
  imageRefreshPending = false;
  if (imageRefreshTimer != null) clearTimeout(imageRefreshTimer);
  imageRefreshTimer = null;
  slotActionPending = false;
  slotEraseAllPending = false;
  displayErrorActive = false;
  if (slotActionTimer != null) clearTimeout(slotActionTimer);
  slotActionTimer = null;
  renderSlotGrid();
  if (clearLog) document.getElementById("log").value = '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isGattBusyError(error) {
  const message = error && error.message ? error.message : '';
  return message.includes('GATT operation already in progress') ||
    message.includes('operation already in progress');
}

function queueBleWrite(task) {
  const run = bleWriteChain.catch(() => { }).then(task);
  bleWriteChain = run.catch(() => { });
  return run;
}

async function writeGattPayload(payload, withResponse) {
  const bytes = Uint8Array.from(payload);

  for (let retry = 0; retry < 8; retry++) {
    try {
      if (withResponse)
        await epdCharacteristic.writeValueWithResponse(bytes);
      else
        await epdCharacteristic.writeValueWithoutResponse(bytes);

      if (!withResponse) await sleep(4);
      return;
    } catch (e) {
      if (!isGattBusyError(e) || retry == 7) throw e;
      await sleep(10 + retry * 10);
    }
  }
}

async function write(cmd, data, withResponse = true) {
  if (!epdCharacteristic) {
    addLog("服务不可用，请检查蓝牙连接");
    return false;
  }
  let payload = [cmd];
  if (data) {
    if (typeof data == 'string') data = hex2bytes(data);
    if (data instanceof Uint8Array) data = Array.from(data);
    payload.push(...data)
  }
  const isSlotChunkRequest = cmd === EpdCmd.GET_IMAGE && payload.length === 4;
  if (cmd !== EpdCmd.WRITE_IMG && !isSlotChunkRequest) addLog(bytes2hex(payload), '⇑');
  try {
    await queueBleWrite(() => writeGattPayload(payload, withResponse));
  } catch (e) {
    console.error(e);
    if (e.message) addLog("write: " + e.message);
    return false;
  }
  return true;
}

function isBleConnected() {
  return gattServer != null && gattServer.connected && epdCharacteristic != null;
}

function formatSlotBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function slotColorName(colorId) {
  return colorId === 0 ? '黑白' : colorId === 1 ? '黑白红' : colorId === 2 ? '黑白红黄' : '未知';
}

function rleEncode(data, maxLiteral = 128) {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  const output = [];
  let offset = 0;

  while (offset < input.length) {
    let runLength = 1;
    while (offset + runLength < input.length && runLength < 130 && input[offset + runLength] === input[offset]) {
      runLength++;
    }

    if (runLength >= 3) {
      output.push(0x80 | (runLength - 3), input[offset]);
      offset += runLength;
      continue;
    }

    const literalStart = offset;
    let literalLength = 0;
    while (offset < input.length && literalLength < maxLiteral &&
      !(offset + 2 < input.length && input[offset] === input[offset + 1] && input[offset] === input[offset + 2])) {
      offset++;
      literalLength++;
    }

    if (literalLength === 0) {
      literalLength = 1;
      offset++;
    }
    output.push(literalLength - 1);
    for (let index = literalStart; index < literalStart + literalLength; index++) output.push(input[index]);
  }

  return new Uint8Array(output);
}

function rleEncodeChunks(data, chunkSize) {
  const encoded = rleEncode(data, Math.min(chunkSize - 1, 128));
  const chunks = [];
  let tokenOffset = 0;
  let chunkOffset = 0;

  while (tokenOffset < encoded.length) {
    const token = encoded[tokenOffset];
    const tokenSize = (token & 0x80) !== 0 ? 2 : token + 2;
    if (tokenOffset - chunkOffset + tokenSize > chunkSize && tokenOffset > chunkOffset) {
      chunks.push(encoded.slice(chunkOffset, tokenOffset));
      chunkOffset = tokenOffset;
    }
    tokenOffset += tokenSize;
  }
  if (tokenOffset > chunkOffset) chunks.push(encoded.slice(chunkOffset, tokenOffset));
  return chunks;
}

function rleDecode(data) {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  const output = [];
  let offset = 0;

  while (offset < input.length) {
    const token = input[offset++];
    if ((token & 0x80) !== 0) {
      if (offset >= input.length) throw new Error('RLE repeat token is incomplete');
      const count = (token & 0x7F) + 3;
      const value = input[offset++];
      for (let index = 0; index < count; index++) output.push(value);
    } else {
      const count = token + 1;
      if (offset + count > input.length) throw new Error('RLE literal token is incomplete');
      for (let index = 0; index < count; index++) output.push(input[offset++]);
    }
  }

  return new Uint8Array(output);
}

function getSlotImageCacheScope() {
  const deviceId = bleDevice && (bleDevice.id || bleDevice.name) ? (bleDevice.id || bleDevice.name) : 'unknown-device';
  const driver = document.getElementById('epddriver');
  return `${deviceId}:${driver ? driver.value : 'unknown-driver'}`;
}

function getSlotImageCacheKey(slot) {
  return `${SLOT_IMAGE_CACHE_PREFIX}${encodeURIComponent(getSlotImageCacheScope())}:${slot}`;
}

function createSlotPreviewDataUrl(sourceImageData) {
  const source = document.createElement('canvas');
  source.width = sourceImageData.width;
  source.height = sourceImageData.height;
  source.getContext('2d').putImageData(sourceImageData, 0, 0);

  const scale = Math.min(1, SLOT_PREVIEW_MAX_EDGE / Math.max(source.width, source.height));
  const preview = document.createElement('canvas');
  preview.width = Math.max(1, Math.round(source.width * scale));
  preview.height = Math.max(1, Math.round(source.height * scale));
  const previewContext = preview.getContext('2d');
  previewContext.fillStyle = '#fff';
  previewContext.fillRect(0, 0, preview.width, preview.height);
  previewContext.drawImage(source, 0, 0, preview.width, preview.height);

  const dataUrl = preview.toDataURL('image/jpeg', SLOT_PREVIEW_JPEG_QUALITY);
  if (!dataUrl.startsWith('data:image/')) throw new Error('Canvas preview snapshot failed');
  return dataUrl;
}

function normalizeSlotFingerprint(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}$/i.test(value) ? value.toUpperCase() : null;
}

function slotCacheMatchesFingerprint(entry, fingerprint) {
  return fingerprint == null || normalizeSlotFingerprint(entry && entry.fingerprint) === fingerprint;
}

function loadSlotImageCache() {
  const scope = getSlotImageCacheScope();
  if (scope !== slotImageCacheScope) {
    slotImageCache = new Map();
    slotImageCacheScope = scope;
  }

  for (let slot = 0; slot < slotState.count; slot++) {
    const used = (slotState.usedMask & (1 << slot)) !== 0;
    const pending = slotPreviewPending.has(slot);
    const fingerprint = slotState.fingerprints[slot] || null;
    let staleCacheRemoved = false;
    if (!used && !pending) {
      removeSlotImageCache(slot);
      continue;
    }

    const currentEntry = slotImageCache.get(slot);
    if (used && !pending && currentEntry && !slotCacheMatchesFingerprint(currentEntry, fingerprint)) {
      slotImageCache.delete(slot);
      try { localStorage.removeItem(getSlotImageCacheKey(slot)); } catch (_) { }
      staleCacheRemoved = true;
    }

    try {
      const stored = localStorage.getItem(getSlotImageCacheKey(slot));
      if (stored) {
        const entry = JSON.parse(stored);
        if (entry && entry.dataUrl && entry.dataUrl.startsWith('data:image/')) {
          if (used && !pending && !slotCacheMatchesFingerprint(entry, fingerprint)) {
            localStorage.removeItem(getSlotImageCacheKey(slot));
            staleCacheRemoved = true;
          } else {
            const cachedEntry = slotImageCache.get(slot);
            const currentSavedAt = cachedEntry && Number(cachedEntry.savedAt) || 0;
            const storedSavedAt = Number(entry.savedAt) || 0;
            if (!cachedEntry || storedSavedAt > currentSavedAt) {
              slotImageCache.set(slot, entry);
            }
          }
        }
      }
    } catch (error) {
      console.warn('Failed to load slot image cache', error);
      try { localStorage.removeItem(getSlotImageCacheKey(slot)); } catch (_) { }
    }

    if (used && pending) {
      slotPreviewPending.delete(slot);
      const entry = slotImageCache.get(slot);
      if (entry && entry.pending) {
        saveSlotImageCache(slot, { ...entry, fingerprint, pending: false });
      }
    }
    if (staleCacheRemoved) addLog(`槽位 ${slot + 1} 已在其他浏览器或设备更新，旧预览已清除。`);
  }
}

function saveSlotImageCache(slot, entry) {
  slotImageCache.set(slot, entry);
  const cacheKey = getSlotImageCacheKey(slot);
  const serializedEntry = JSON.stringify(entry);
  try {
    localStorage.setItem(cacheKey, serializedEntry);
    return true;
  } catch (firstError) {
    try {
      localStorage.removeItem(cacheKey);
      localStorage.setItem(cacheKey, serializedEntry);
      return true;
    } catch (error) {
      console.warn('Failed to persist slot image cache', firstError, error);
      addLog('浏览器缓存空间不足，本次预览仅在当前页面有效。');
      return false;
    }
  }
}

function cacheCurrentSlotPreview(slot, processedData, mode) {
  try {
    const scope = getSlotImageCacheScope();
    if (scope !== slotImageCacheScope) {
      slotImageCache = new Map();
      slotImageCacheScope = scope;
    }
    const sourceImageData = ditherSourceImageData &&
      ditherSourceImageData.width === canvas.width && ditherSourceImageData.height === canvas.height
      ? ditherSourceImageData
      : ctx.getImageData(0, 0, canvas.width, canvas.height);
    const dataUrl = createSlotPreviewDataUrl(sourceImageData);
    const colorId = mode === 'blackWhiteColor' ? 0 : mode === 'threeColor' ? 1 : 2;
    slotPreviewPending.add(slot);
    saveSlotImageCache(slot, {
      width: canvas.width,
      height: canvas.height,
      size: processedData.length,
      colorId,
      dataUrl,
      previewKind: 'original',
      fingerprint: null,
      pending: true,
      savedAt: new Date().getTime()
    });
    renderSlotGrid(true);
    addLog(`槽位 ${slot + 1} 原图预览已生成，无需再次回读。`);
  } catch (error) {
    console.warn('Failed to cache current slot preview', error);
    removeSlotImageCache(slot);
    addLog(`槽位 ${slot + 1} 预览生成失败：${error.message || error}`);
  }
}

function removeSlotImageCache(slot) {
  slotPreviewPending.delete(slot);
  slotImageCache.delete(slot);
  try { localStorage.removeItem(getSlotImageCacheKey(slot)); } catch (_) { }
}

function clearAllSlotImageCaches() {
  for (let slot = 0; slot < Math.max(slotState.count, 20); slot++) removeSlotImageCache(slot);
  slotImageCache.clear();
}

function renderSlotGrid(forceDisabled = imageTransferActive || slotActionPending || slotReadState !== null) {
  const grid = document.getElementById('slotGrid');
  const summary = document.getElementById('slotSummary');
  const hint = document.getElementById('slotHint');
  if (!grid || !summary || !hint) return;

  grid.replaceChildren();
  if (!isBleConnected()) {
    summary.textContent = '连接设备后读取槽位';
    hint.textContent = '图片保存在设备外置 Flash 中';
    return;
  }

  if (slotState.count === 0) {
    summary.textContent = '未识别到外置 Flash';
    hint.textContent = '请检查 Flash 供电及 P0.12 至 P0.15 连线';
    return;
  }

  let usedCount = 0;
  for (let slot = 0; slot < slotState.count; slot++) {
    const used = (slotState.usedMask & (1 << slot)) !== 0;
    const cached = slotImageCache.get(slot) || null;
    const previewPending = !used && cached && slotPreviewPending.has(slot);
    if (used) usedCount++;

    const item = document.createElement('div');
    item.className = used ? 'slot-item used' : 'slot-item';
    if (slotState.selected === slot) item.classList.add('selected');

    const label = document.createElement('div');
    label.className = 'slot-label';
    const title = document.createElement('strong');
    title.textContent = `槽位 ${slot + 1}`;
    const state = document.createElement('span');
    state.className = 'slot-state';
    state.textContent = `${used ? '已存图片' : previewPending ? '正在存入' : '空闲'}${cached ? ' · 已缓存' : used ? ' · 未读取' : ''}${slotState.selected === slot ? ' · 当前' : ''}`;
    label.append(title, state);

    const actions = document.createElement('div');
    actions.className = 'slot-actions';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'primary';
    saveButton.textContent = used ? '覆盖' : '存入';
    saveButton.disabled = forceDisabled;
    saveButton.addEventListener('click', () => saveImageToSlot(slot));

    const displayButton = document.createElement('button');
    displayButton.type = 'button';
    displayButton.className = 'secondary';
    displayButton.textContent = '显示';
    displayButton.disabled = forceDisabled || !used;
    displayButton.addEventListener('click', () => displayImageSlot(slot));

    const readControl = document.createElement('div');
    readControl.className = cached ? 'slot-read-control cached' : 'slot-read-control';
    const readButton = document.createElement('button');
    readButton.type = 'button';
    readButton.className = 'secondary';
    readButton.textContent = '读取';
    readButton.disabled = forceDisabled || !used;
    readButton.addEventListener('click', () => readImageSlot(slot));

    const hoverPreview = document.createElement('div');
    hoverPreview.className = cached ? 'slot-hover-preview cached' : 'slot-hover-preview empty';
    hoverPreview.id = `slotPreviewTooltip${slot}`;
    hoverPreview.setAttribute('role', 'tooltip');
    readButton.setAttribute('aria-describedby', hoverPreview.id);
    readButton.title = cached ? '悬停预览已缓存图片' : '点击读取图片并生成网页缓存';
    if (cached) {
      const previewImage = document.createElement('img');
      previewImage.src = cached.dataUrl;
      previewImage.alt = `槽位 ${slot + 1} 缓存预览`;
      const previewMeta = document.createElement('span');
      const previewKind = cached.previewKind === 'original' ? '原图' : '设备回读';
      previewMeta.textContent = `${cached.width} × ${cached.height} · ${slotColorName(cached.colorId)} · ${previewKind}`;
      hoverPreview.append(previewImage, previewMeta);
    } else {
      hoverPreview.textContent = used ? '尚未读取，点击“读取”后可悬停预览' : '空槽位，无图片可读取';
    }
    readControl.append(readButton, hoverPreview);

    const freeButton = document.createElement('button');
    freeButton.type = 'button';
    freeButton.className = 'secondary slot-delete';
    freeButton.textContent = '删除';
    freeButton.disabled = forceDisabled || !used;
    freeButton.addEventListener('click', () => freeImageSlot(slot));

    actions.append(saveButton, displayButton, readControl, freeButton);
    item.append(label, actions);
    grid.appendChild(item);
  }

  summary.textContent = `${slotState.count} 个槽位，已使用 ${usedCount} 个`;
  hint.textContent = '“存入”会同时刷新屏幕并保存当前画布';
}

async function refreshSlots() {
  if (!isBleConnected()) return;
  addLog('正在读取图片槽位...');
  await write(EpdCmd.INIT);
}

function applySlotsMessage(message) {
  const parts = message.trim().split(/\s+/);
  const countMatch = /^slots=(\d+)$/.exec(parts[0] || '');
  if (!countMatch || parts.length < 2 || !/^(?:0x[0-9a-f]+|\d+)$/i.test(parts[1])) return false;

  const count = parseInt(countMatch[1], 10);
  let fingerprintStart = 2;
  let selected = null;
  if (parts[2] != null && /^\d+$/.test(parts[2])) {
    selected = parseInt(parts[2], 10);
    fingerprintStart = 3;
  }
  const fingerprints = parts.slice(fingerprintStart, fingerprintStart + count)
    .map(normalizeSlotFingerprint);
  slotState = {
    count,
    usedMask: Number(parts[1]),
    selected,
    fingerprints
  };
  loadSlotImageCache();
  const eraseAllCompleted = slotEraseAllPending && slotState.usedMask === 0;
  if (slotEraseAllPending && !eraseAllCompleted) {
    updateButtonStatus();
    return true;
  }
  slotEraseAllPending = false;
  if (slotActionPending) setSlotActionPending(false);
  else updateButtonStatus();
  if (eraseAllCompleted) {
    clearAllSlotImageCaches();
    const status = document.getElementById('slotReadStatus');
    status.hidden = false;
    status.textContent = '全部图片槽位已擦除。';
    addLog('全部图片槽位擦除完成。');
  }
  return true;
}

async function saveImageToSlot(slot) {
  if (imageTransferActive || slotActionPending) return;
  const imageFile = document.getElementById('imageFile');
  if (!imageFile || imageFile.files.length === 0) {
    alert('请先选择图片，再存入图片槽。');
    addLog(`槽位 ${slot + 1} 未存入：尚未选择图片。`);
    return;
  }
  const used = (slotState.usedMask & (1 << slot)) !== 0;
  if (used && !confirm(`槽位 ${slot + 1} 已有图片，确认覆盖？`)) return;
  await sendimg({ slot });
}

async function freeImageSlot(slot) {
  if (imageTransferActive || slotActionPending) return;
  if (!confirm(`确认删除槽位 ${slot + 1} 的图片？`)) return;
  setSlotActionPending(true);
  if (await write(EpdCmd.FREE_SLOT, new Uint8Array([slot]))) {
    removeSlotImageCache(slot);
    renderSlotGrid(true);
    addLog(`槽位 ${slot + 1} 删除命令已发送。`);
  } else {
    setSlotActionPending(false);
  }
}

async function freeAllImageSlots() {
  if (imageTransferActive || slotActionPending || slotReadState || slotState.usedMask === 0) return;
  if (!confirm('确认擦除全部图片槽位？所有已保存图片都将永久删除，此操作不可恢复。')) return;

  slotEraseAllPending = true;
  setSlotActionPending(true);
  const status = document.getElementById('slotReadStatus');
  status.hidden = false;
  status.textContent = '正在擦除全部图片槽位，请勿断开连接...';
  if (await write(EpdCmd.FREE_SLOT, new Uint8Array([0xFF]))) {
    addLog('全部图片槽位擦除命令已发送。');
  } else {
    slotEraseAllPending = false;
    setSlotActionPending(false);
    status.textContent = '全部槽位擦除命令发送失败。';
  }
}

async function displayImageSlot(slot) {
  if (imageTransferActive || slotActionPending) return;
  setSlotActionPending(true);
  if (await write(EpdCmd.SET_SLOT, new Uint8Array([1, slot]))) {
    addLog(`已请求设备显示槽位 ${slot + 1}。`);
  } else {
    setSlotActionPending(false);
  }
}

function setSlotActionPending(pending) {
  slotActionPending = pending;
  if (slotActionTimer != null) clearTimeout(slotActionTimer);
  slotActionTimer = null;
  if (pending) {
    slotActionTimer = setTimeout(() => {
      slotActionPending = false;
      slotEraseAllPending = false;
      slotActionTimer = null;
      updateButtonStatus();
      addLog('槽位操作等待超时，控制按钮已恢复。');
    }, 95000);
  }
  updateButtonStatus();
}

function cancelImageRefreshWait() {
  if (imageRefreshTimer != null) clearTimeout(imageRefreshTimer);
  imageRefreshTimer = null;
  imageRefreshPending = false;
}

function startImageRefreshWait() {
  cancelImageRefreshWait();
  imageRefreshPending = true;
  imageRefreshTimer = setTimeout(() => {
    if (!imageRefreshPending) return;
    imageRefreshPending = false;
    imageRefreshTimer = null;
    imageTransferActive = false;
    updateButtonStatus();
    setStatus('屏幕刷新完成通知超时。');
    addLog('屏幕刷新完成通知超时，控制按钮已恢复；请确认屏幕已停止刷新后再操作。');
  }, IMAGE_REFRESH_TIMEOUT_MS);
}

function completeImageRefresh() {
  if (!imageRefreshPending) return false;

  cancelImageRefreshWait();
  imageTransferActive = false;
  updateButtonStatus();
  const totalTime = (new Date().getTime() - startTime) / 1000.0;
  setStatus(`屏幕刷新完成！总耗时: ${totalTime}s`);
  addLog(`屏幕刷新完成，可以继续操作。总耗时: ${totalTime}s`);
  const status = document.getElementById('status');
  setTimeout(() => {
    status.parentElement.style.display = 'none';
  }, 5000);
  return true;
}

async function startSlotSlide(randomMode = false) {
  if (slotState.usedMask === 0) {
    alert('请先存入至少一张图片，再启动轮播。');
    addLog('轮播未启动：没有可用的图片槽。');
    return false;
  }
  const input = document.getElementById('slotSlideMinutes');
  const minutes = Math.max(1, Math.min(65535, parseInt(input.value, 10) || 1));
  input.value = minutes;
  setSlotActionPending(true);
  if (await write(EpdCmd.SET_SLIDE, new Uint8Array([minutes >> 8, minutes & 0xFF, randomMode ? 1 : 0]))) {
    addLog(`${randomMode ? '随机' : '顺序'}轮播已启动，正在立即显示${randomMode ? '随机图片' : '第一张图片'}，间隔 ${minutes} 分钟。`);
    return true;
  }
  setSlotActionPending(false);
  return false;
}

async function startRandomSlotSlide() {
  return startSlotSlide(true);
}

async function stopSlotSlide() {
  if (await write(EpdCmd.SET_SLIDE, new Uint8Array([0, 0]))) {
    addLog('图片轮播已停止。');
  }
}

async function readImageSlot(slot) {
  if (slotImageCache.has(slot)) {
    addLog(`槽位 ${slot + 1} 已有网页缓存，悬停“读取”按钮即可预览。`);
    return;
  }
  if (slotReadState) {
    addLog('已有槽位图片正在读取，请稍候。');
    return;
  }
  if (imageTransferActive || slotActionPending) return;

  const status = document.getElementById('slotReadStatus');
  status.hidden = false;
  status.textContent = `正在读取槽位 ${slot + 1}...`;
  slotReadState = { slot, pending: true, infoAttempts: 0, startedAt: new Date().getTime() };
  updateButtonStatus();
  await requestSlotImageInfo(slotReadState);
}

async function requestSlotImageInfo(state) {
  if (!state || slotReadState !== state || !state.pending) return;

  state.infoAttempts++;
  clearSlotReadTimer();
  slotReadTimer = setTimeout(() => {
    if (slotReadState !== state || !state.pending) return;
    if (state.infoAttempts < 2) {
      addLog('设备未返回图片信息，正在重试。');
      void requestSlotImageInfo(state);
    } else {
      failSlotImageRead('设备未返回图片信息，读取超时。');
    }
  }, SLOT_READ_INFO_TIMEOUT_MS);

  if (!await write(EpdCmd.GET_IMAGE, new Uint8Array([state.slot]), false) && slotReadState === state) {
    if (state.infoAttempts < 2) {
      addLog('读取命令发送失败，正在重试。');
      void requestSlotImageInfo(state);
    } else {
      failSlotImageRead('读取命令发送失败。');
    }
  }
}

function clearSlotReadTimer() {
  if (slotReadTimer != null) clearTimeout(slotReadTimer);
  slotReadTimer = null;
}

function failSlotImageRead(message) {
  clearSlotReadTimer();
  slotReadState = null;
  const status = document.getElementById('slotReadStatus');
  status.hidden = false;
  status.textContent = message;
  addLog(message);
  updateButtonStatus();
}

function retrySlotChunk(index, reason) {
  const state = slotReadState;
  if (!state || state.pending || state.nextChunkIndex !== index) return;

  clearSlotReadTimer();
  state.expectedChunk = null;
  if (state.chunkRetries >= SLOT_CHUNK_MAX_RETRIES) {
    failSlotImageRead(`第 ${index + 1} 个数据块${reason}，重试 ${SLOT_CHUNK_MAX_RETRIES} 次后读取已停止。`);
    return;
  }

  state.chunkRetries++;
  addLog(`第 ${index + 1} 个数据块${reason}，正在重试 (${state.chunkRetries}/${SLOT_CHUNK_MAX_RETRIES})。`);
  void requestSlotChunk(index, true);
}

function armSlotChunkTimeout(index) {
  clearSlotReadTimer();
  const state = slotReadState;
  slotReadTimer = setTimeout(() => {
    if (slotReadState === state) retrySlotChunk(index, '接收超时');
  }, SLOT_READ_TIMEOUT_MS);
}

async function requestSlotChunk(index, retry = false) {
  const state = slotReadState;
  if (!state || state.pending) return;

  if (!retry) state.chunkRetries = 0;
  state.nextChunkIndex = index;
  state.expectedChunk = null;
  armSlotChunkTimeout(index);
  const request = new Uint8Array([state.slot, (index >> 8) & 0xFF, index & 0xFF]);
  if (!await write(EpdCmd.GET_IMAGE, request, false) && slotReadState === state &&
    state.nextChunkIndex === index) {
    retrySlotChunk(index, '请求失败');
  }
}

function beginSlotImageRead(message) {
  const match = /^img=(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/.exec(message.trim());
  if (!match) return false;

  const slot = parseInt(match[1], 10);
  if (slotReadState && !slotReadState.pending && slotReadState.slot === slot) return true;

  const size = parseInt(match[4], 10);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_SLOT_IMAGE_SIZE) {
    failSlotImageRead(`槽位图片大小异常：${size} 字节`);
    return true;
  }

  const startedAt = slotReadState && slotReadState.startedAt
    ? slotReadState.startedAt
    : new Date().getTime();
  clearSlotReadTimer();
  slotReadState = {
    slot,
    width: parseInt(match[2], 10),
    height: parseInt(match[3], 10),
    size,
    colorId: parseInt(match[5], 10),
    data: new Uint8Array(size),
    received: 0,
    expectedChunk: null,
    nextChunkIndex: 0,
    chunkRetries: 0,
    nextLogPercent: 10,
    rawChunkSize: match[6] == null ? DEFAULT_SLOT_READ_RAW_CHUNK_SIZE : parseInt(match[6], 10),
    startedAt,
    pending: false
  };

  if (!Number.isFinite(slotReadState.rawChunkSize) || slotReadState.rawChunkSize <= 0 ||
    slotReadState.rawChunkSize > 4096) {
    failSlotImageRead(`槽位数据块大小异常：${slotReadState.rawChunkSize}`);
    return true;
  }

  const status = document.getElementById('slotReadStatus');
  status.hidden = false;
  status.textContent = `槽位 ${slotReadState.slot + 1}：准备接收 ${formatSlotBytes(size)}`;
  void requestSlotChunk(0);
  return true;
}

function beginSlotChunk(message) {
  if (!slotReadState) return false;
  const match = /^chunk=(\d+)\s+len=(\d+)(?:\s+rle=(\d+))?$/.exec(message.trim());
  if (!match) return false;

  const index = parseInt(match[1], 10);
  if (index !== slotReadState.nextChunkIndex) {
    failSlotImageRead(`数据块序号异常：应为 ${slotReadState.nextChunkIndex + 1}，实际为 ${index + 1}。`);
    return true;
  }

  slotReadState.expectedChunk = {
    index,
    length: parseInt(match[2], 10),
    compressed: match[3] === '1',
    received: 0,
    parts: []
  };
  armSlotChunkTimeout(index);
  return true;
}

function receiveSlotChunk(data) {
  if (!slotReadState || !slotReadState.expectedChunk) return false;

  const expected = slotReadState.expectedChunk;
  if (expected.received + data.length > expected.length) {
    failSlotImageRead(`第 ${expected.index + 1} 个数据块长度异常，读取已停止。`);
    return true;
  }

  expected.parts.push(data.slice());
  expected.received += data.length;
  if (expected.received < expected.length) {
    armSlotChunkTimeout(expected.index);
    return true;
  }

  const chunkData = new Uint8Array(expected.length);
  let chunkOffset = 0;
  for (const part of expected.parts) {
    chunkData.set(part, chunkOffset);
    chunkOffset += part.length;
  }
  slotReadState.expectedChunk = null;

  let decoded;
  try {
    decoded = expected.compressed ? rleDecode(chunkData) : chunkData;
  } catch (error) {
    console.error(error);
    failSlotImageRead(`第 ${expected.index + 1} 个 RLE 数据块解析失败。`);
    return true;
  }

  const remaining = slotReadState.size - slotReadState.received;
  const expectedRawLength = Math.min(slotReadState.rawChunkSize, remaining);
  if (decoded.length !== expectedRawLength) {
    failSlotImageRead(`第 ${expected.index + 1} 个数据块解压长度异常。`);
    return true;
  }

  slotReadState.data.set(decoded, slotReadState.received);
  slotReadState.received += decoded.length;
  const percent = Math.round(slotReadState.received * 100 / slotReadState.size);
  const status = document.getElementById('slotReadStatus');
  status.hidden = false;
  status.textContent = `正在读取槽位 ${slotReadState.slot + 1}：${percent}% (${formatSlotBytes(slotReadState.received)} / ${formatSlotBytes(slotReadState.size)})`;

  if (percent >= slotReadState.nextLogPercent || slotReadState.received === slotReadState.size) {
    addLog(`槽位 ${slotReadState.slot + 1} 读取进度：${percent}%`, '⇓');
    while (slotReadState.nextLogPercent <= percent) slotReadState.nextLogPercent += 10;
  }

  if (slotReadState.received === slotReadState.size) {
    finishSlotImageRead();
  } else {
    void requestSlotChunk(expected.index + 1);
  }
  return true;
}

function restoreRotated1bpp(data, width, height) {
  const output = new Uint8Array(Math.ceil(width * height / 8)).fill(0xFF);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      set1bppPixel(output, width, x, y, get1bppPixel(data, height, y, width - 1 - x));
    }
  }
  return output;
}

function restoreRotated2bpp(data, width, height) {
  const output = new Uint8Array(Math.ceil(width * height / 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      set2bppPixel(output, width, x, y, get2bppPixel(data, height, y, width - 1 - x));
    }
  }
  return output;
}

function normalizeSlotImageData(meta) {
  const driverSelect = document.getElementById('epddriver');
  const needsNativeRotation = 
    ((meta.width === 416 && meta.height === 240) && isGDEM037F51Driver(driverSelect)) ||
    ((meta.width === 360 && meta.height === 240) && isSE0352Driver(driverSelect));
  if (!needsNativeRotation) return meta.data;

  if (meta.colorId === 2) return restoreRotated2bpp(meta.data, meta.width, meta.height);
  if (meta.colorId === 0) return restoreRotated1bpp(meta.data, meta.width, meta.height);
  if (meta.colorId === 1) {
    const planeSize = Math.floor(meta.data.length / 2);
    const output = new Uint8Array(meta.data.length);
    output.set(restoreRotated1bpp(meta.data.slice(0, planeSize), meta.width, meta.height), 0);
    output.set(restoreRotated1bpp(meta.data.slice(planeSize), meta.width, meta.height), planeSize);
    return output;
  }
  return meta.data;
}

function decodeUC8159SlotData(data, width, height) {
  const imageData = new ImageData(width, height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const packed = data[pixel >> 1];
    const value = (pixel & 1) === 0 ? (packed >> 4) & 0x0F : packed & 0x0F;
    const index = pixel * 4;
    if (value === 0x04) {
      imageData.data[index] = 255;
      imageData.data[index + 1] = 0;
      imageData.data[index + 2] = 0;
    } else {
      const channel = value === 0x00 ? 0 : 255;
      imageData.data[index] = channel;
      imageData.data[index + 1] = channel;
      imageData.data[index + 2] = channel;
    }
    imageData.data[index + 3] = 255;
  }
  return imageData;
}

function finishSlotImageRead() {
  const meta = slotReadState;
  const elapsed = (new Date().getTime() - meta.startedAt) / 1000.0;
  clearSlotReadTimer();
  slotReadState = null;
  try {
    const mode = meta.colorId === 0 ? 'blackWhiteColor' : meta.colorId === 1 ? 'threeColor' : 'fourColor';
    const normalized = normalizeSlotImageData(meta);
    const driverValue = document.getElementById('epddriver').value.toLowerCase();
    const imageData = (driverValue === '08' || driverValue === '09')
      ? decodeUC8159SlotData(normalized, meta.width, meta.height)
      : decodeProcessedData(normalized, meta.width, meta.height, mode);
    const existingPreview = slotImageCache.get(meta.slot);
    if (!existingPreview || existingPreview.previewKind !== 'original') {
      saveSlotImageCache(meta.slot, {
        width: meta.width,
        height: meta.height,
        size: meta.size,
        colorId: meta.colorId,
        dataUrl: createSlotPreviewDataUrl(imageData),
        previewKind: 'device',
        fingerprint: slotState.fingerprints[meta.slot] || null,
        savedAt: new Date().getTime()
      });
    }
    renderSlotGrid();

    const status = document.getElementById('slotReadStatus');
    status.hidden = false;
    status.textContent = `槽位 ${meta.slot + 1} 读取完成，悬停“读取”按钮即可预览。耗时 ${elapsed}s。`;
    addLog(`槽位 ${meta.slot + 1} 图片已缓存，耗时: ${elapsed}s。`);
  } catch (error) {
    console.error(error);
    const status = document.getElementById('slotReadStatus');
    status.hidden = false;
    status.textContent = '图片数据解析失败。';
  } finally {
    updateButtonStatus();
  }
}

async function writeImage(data, step = 'bw') {
  const chunkSize = parseInt(document.getElementById('mtusize').value, 10) - 2;
  const interleavedCount = parseInt(document.getElementById('interleavedcount').value, 10);

  if (chunkSize <= 0) {
    addLog('MTU error, please reconnect the device.');
    return false;
  }

  const rawData = data instanceof Uint8Array ? data : new Uint8Array(data);
  const rleChunks = rleSupport && chunkSize >= 2 ? rleEncodeChunks(rawData, chunkSize) : [];
  const compressedSize = rleChunks.reduce((total, chunk) => total + chunk.length, 0);
  const useRle = rleSupport && compressedSize > 0 && compressedSize < rawData.length;
  const count = useRle ? rleChunks.length : Math.ceil(rawData.length / chunkSize);
  const stepName = step === 'bw' ? '图像' : '颜色';
  const transferSize = useRle ? compressedSize : rawData.length;
  let noReplyCount = interleavedCount;
  let nextLogPercent = 10;

  if (useRle) addLog(`${stepName} RLE 压缩：${rawData.length} → ${compressedSize} 字节 (${(compressedSize * 100 / rawData.length).toFixed(1)}%)`);
  addLog(`${stepName}开始传输：${transferSize} 字节，共 ${count} 包。`, '⇑');

  for (let chunkIdx = 0; chunkIdx < count; chunkIdx++) {
    if (displayErrorActive) return false;
    const offset = chunkIdx * chunkSize;
    const chunk = useRle ? rleChunks[chunkIdx] : rawData.slice(offset, offset + chunkSize);
    const currentTime = (new Date().getTime() - startTime) / 1000.0;
    setStatus(`${stepName}块: ${chunkIdx + 1}/${count}, 总用时: ${currentTime}s`);

    const cfg = rleSupport
      ? (step === 'bw' ? 0 : 1) | (chunkIdx === 0 ? 2 : 0) | (useRle ? 4 : 0)
      : (step === 'bw' ? 0x0F : 0x00) | (chunkIdx === 0 ? 0x00 : 0xF0);
    const payload = [
      cfg,
      ...chunk,
    ];
    if (noReplyCount > 0) {
      if (!await write(EpdCmd.WRITE_IMG, payload, false)) return false;
      noReplyCount--;
    } else {
      if (!await write(EpdCmd.WRITE_IMG, payload, true)) return false;
      noReplyCount = interleavedCount;
    }

    const percent = Math.floor((chunkIdx + 1) * 100 / count);
    if (percent >= nextLogPercent || chunkIdx + 1 === count) {
      addLog(`${stepName}传输进度：${percent}% (${chunkIdx + 1}/${count} 包)`, '⇑');
      while (nextLogPercent <= percent) nextLogPercent += 10;
    }
  }

  return true;
}

async function setDriver() {
  updateButtonStatus(true);

  try {
    updateDitcherOptions();

    const pins = document.getElementById("epdpins").value.trim().toLowerCase();
    const driver = document.getElementById("epddriver").value;

    if (pins !== currentPinsValue) {
      if (!await write(EpdCmd.SET_PINS, pins, true)) return;
      currentPinsValue = pins;
      await sleep(300);
    }

    if (!await write(EpdCmd.INIT, driver, true)) return;

    addLog("驱动已更新。");
  } finally {
    updateButtonStatus();
  }
}
function getWeekStart() {
  const weekStart = document.getElementById('weekStart');
  const value = weekStart ? parseInt(weekStart.value, 10) : 0;
  return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 0;
}

function buildTimeData(mode) {
  const timestamp = Math.floor(new Date().getTime() / 1000);
  return new Uint8Array([
    (timestamp >> 24) & 0xFF,
    (timestamp >> 16) & 0xFF,
    (timestamp >> 8) & 0xFF,
    timestamp & 0xFF,
    -(new Date().getTimezoneOffset() / 60),
    mode
  ]);
}

async function sendTimeCommand(mode, modeName) {
  const weekStart = getWeekStart();
  if (!await write(EpdCmd.SET_WEEK_START, new Uint8Array([weekStart]))) return false;

  if (await write(EpdCmd.SET_TIME, buildTimeData(mode))) {
    addLog(`${modeName}已同步！`);
    addLog("屏幕刷新完成前请不要操作。");
    return true;
  }
  return false;
}

async function syncTime(mode) {
  if (mode === 2) {
    if (!confirm('提醒：时钟模式目前使用全刷实现，此功能目前多用于修复老化屏残影问题，不建议长期开启，是否继续？')) return;
  }
  await sendTimeCommand(mode, mode === 1 ? '日历模式' : '时钟模式');
}

async function clearScreen() {
  if (confirm('确认清除屏幕内容?')) {
    await write(EpdCmd.CLEAR);
    addLog("清屏指令已发送！");
    addLog("屏幕刷新完成前请不要操作。");
  }
}

async function sendcmd() {
  const cmdTXT = document.getElementById('cmdTXT').value;
  if (cmdTXT == '') return;
  const bytes = hex2bytes(cmdTXT);
  await write(bytes[0], bytes.length > 1 ? bytes.slice(1) : null);
}

function convertUC8159(blackWhiteData, redWhiteData) {
  const halfLength = blackWhiteData.length;
  let payloadData = new Uint8Array(halfLength * 4);
  let payloadIdx = 0;
  let black_data, color_data, data;
  for (let i = 0; i < halfLength; i++) {
    black_data = blackWhiteData[i];
    color_data = redWhiteData[i];
    for (let j = 0; j < 8; j++) {
      if ((color_data & 0x80) == 0x00) data = 0x04;  // red
      else if ((black_data & 0x80) == 0x00) data = 0x00;  // black
      else data = 0x03;  // white
      data = (data << 4) & 0xFF;
      black_data = (black_data << 1) & 0xFF;
      color_data = (color_data << 1) & 0xFF;
      j++;
      if ((color_data & 0x80) == 0x00) data |= 0x04;  // red
      else if ((black_data & 0x80) == 0x00) data |= 0x00;  // black
      else data |= 0x03;  // white
      black_data = (black_data << 1) & 0xFF;
      color_data = (color_data << 1) & 0xFF;
      payloadData[payloadIdx++] = data;
    }
  }
  return payloadData;
}



function isGDEM037F51Driver(selectElement) {
  const option = selectElement.options[selectElement.selectedIndex];
  const value = (selectElement.value || '').toLowerCase();
  const size = option ? option.getAttribute('data-size') : '';
  const label = option ? option.textContent : '';
  return value === '0d' || size === '3.7_416_240' && label.includes('GDEM037F51');
}

function isSE0352Driver(selectElement) {
  const option = selectElement.options[selectElement.selectedIndex];
  const value = (selectElement.value || '').toLowerCase();
  const size = option ? option.getAttribute('data-size') : '';
  const label = option ? option.textContent : '';
  return value === '0e' || value === '0f' || value === '12' ||
    size === '3.5_360_240' && (label.includes('SE0352') || label.includes('YS4370JS0C3') || label.includes('LG 3.7'));
}

function get1bppPixel(data, width, x, y) {
  const pixelIndex = y * width + x;
  const byteIndex = pixelIndex >> 3;
  const shift = 7 - (pixelIndex & 0x07);
  return (data[byteIndex] >> shift) & 0x01;
}

function set1bppPixel(data, width, x, y, value) {
  const pixelIndex = y * width + x;
  const byteIndex = pixelIndex >> 3;
  const mask = 0x80 >> (pixelIndex & 0x07);
  if (value) data[byteIndex] |= mask;
  else data[byteIndex] &= ~mask;
}

function convertSE0352Plane(data, srcWidth = canvas.width, srcHeight = canvas.height) {
  const nativeWidth = 240;
  const nativeHeight = 360;

  if (srcWidth === nativeWidth && srcHeight === nativeHeight) {
    return new Uint8Array(data);
  }

  if (srcWidth !== nativeHeight || srcHeight !== nativeWidth) {
    return new Uint8Array(data);
  }

  const output = new Uint8Array((nativeWidth * nativeHeight) / 8).fill(0xFF);
  for (let y = 0; y < srcHeight; y++) {
    for (let x = 0; x < srcWidth; x++) {
      set1bppPixel(output, nativeWidth, y, nativeHeight - 1 - x, get1bppPixel(data, srcWidth, x, y));
    }
  }

  return output;
}

function get2bppPixel(data, width, x, y) {
  const pixelIndex = y * width + x;
  const byteIndex = pixelIndex >> 2;
  const shift = 6 - ((pixelIndex & 0x03) * 2);
  return (data[byteIndex] >> shift) & 0x03;
}

function set2bppPixel(data, width, x, y, value) {
  const pixelIndex = y * width + x;
  const byteIndex = pixelIndex >> 2;
  const shift = 6 - ((pixelIndex & 0x03) * 2);
  data[byteIndex] = (data[byteIndex] & ~(0x03 << shift)) | ((value & 0x03) << shift);
}


function mapGDEM037F51Color(value) {
  return value & 0x03;
}
function convertGDEM037F51(data, srcWidth = canvas.width, srcHeight = canvas.height) {
  const nativeWidth = 240;
  const nativeHeight = 416;

  if (srcWidth === nativeWidth && srcHeight === nativeHeight) {
    const output = new Uint8Array(data.length);
    for (let y = 0; y < srcHeight; y++) {
      for (let x = 0; x < srcWidth; x++) {
        set2bppPixel(output, srcWidth, x, y, mapGDEM037F51Color(get2bppPixel(data, srcWidth, x, y)));
      }
    }
    return output;
  }

  if (srcWidth !== nativeHeight || srcHeight !== nativeWidth) {
    return new Uint8Array(data);
  }

  const output = new Uint8Array((nativeWidth * nativeHeight) / 4);
  for (let y = 0; y < srcHeight; y++) {
    for (let x = 0; x < srcWidth; x++) {
      const value = mapGDEM037F51Color(get2bppPixel(data, srcWidth, x, y));
      set2bppPixel(output, nativeWidth, y, nativeHeight - 1 - x, value);
    }
  }

  return output;
}
async function sendimg(options = {}) {
  if (cropManager) cropManager.commitPendingTransform(false);
  const canvasSize = document.getElementById('canvasSize').value;
  const ditherMode = document.getElementById('ditherMode').value;
  const epdDriverSelect = document.getElementById('epddriver');
  const selectedOption = epdDriverSelect.options[epdDriverSelect.selectedIndex];

  if (selectedOption.getAttribute('data-size') !== canvasSize) {
    if (!confirm("警告：画布尺寸和驱动不匹配，是否继续？")) return;
  }
  if (selectedOption.getAttribute('data-color') !== ditherMode) {
    if (!confirm("警告：颜色模式和驱动不匹配，是否继续？")) return;
  }

  displayErrorActive = false;
  startTime = new Date().getTime();
  const status = document.getElementById("status");
  status.parentElement.style.display = "block";

  const processedData = processCanvasImageData();

  imageTransferActive = true;
  updateButtonStatus();
  const targetSlot = Number.isInteger(options.slot) ? options.slot : null;
  if (targetSlot != null) {
    cacheCurrentSlotPreview(targetSlot, processedData, ditherMode);
    if (targetSlot < 0 || targetSlot >= slotState.count ||
      !await write(EpdCmd.SET_SLOT, new Uint8Array([0, targetSlot]))) {
      addLog('槽位写入准备失败。');
      removeSlotImageCache(targetSlot);
      imageTransferActive = false;
      updateButtonStatus();
      return false;
    }
    setStatus(`正在写入槽位 ${targetSlot + 1}...`);
  }

  let transferOk = true;

  if (ditherMode === 'fourColor') {
    const useGDEM037F51 = isGDEM037F51Driver(epdDriverSelect);
    const imagePayload = useGDEM037F51 ? convertGDEM037F51(processedData, canvas.width, canvas.height) : processedData;
    if (useGDEM037F51) addLog('3.7BWRY 图像数据已按原生颜色码重排为 240x416');
    transferOk = await writeImage(imagePayload, 'bw');
  } else if (ditherMode === 'threeColor') {
    const halfLength = Math.floor(processedData.length / 2);
    let blackWhiteData = processedData.slice(0, halfLength);
    let redWhiteData = processedData.slice(halfLength);
    if (isSE0352Driver(epdDriverSelect)) {
      blackWhiteData = convertSE0352Plane(blackWhiteData, canvas.width, canvas.height);
      redWhiteData = convertSE0352Plane(redWhiteData, canvas.width, canvas.height);
      addLog('3.7BWR 图像数据已按原生 240x416 重排');
    }
    if (epdDriverSelect.value === '08' || epdDriverSelect.value === '09') {
      transferOk = await writeImage(convertUC8159(blackWhiteData, redWhiteData), 'bw');
    } else {
      transferOk = await writeImage(blackWhiteData, 'bw');
      if (transferOk) transferOk = await writeImage(redWhiteData, 'red');
    }
  } else if (ditherMode === 'blackWhiteColor') {
    if (epdDriverSelect.value === '08' || epdDriverSelect.value === '09') {
      const emptyData = new Uint8Array(processedData.length).fill(0xFF);
      transferOk = await writeImage(convertUC8159(processedData, emptyData), 'bw');
    } else {
      transferOk = await writeImage(processedData, 'bw');
    }
  } else {
    addLog("当前固件不支持此颜色模式。");
    if (targetSlot != null) removeSlotImageCache(targetSlot);
    imageTransferActive = false;
    updateButtonStatus();
    return false;
  }

  if (!transferOk) {
    if (targetSlot != null) await write(EpdCmd.SET_SLOT, new Uint8Array([0, slotState.count]));
    if (targetSlot != null) removeSlotImageCache(targetSlot);
    setStatus('图片发送失败。');
    imageTransferActive = false;
    updateButtonStatus();
    return false;
  }

  const sendTime = (new Date().getTime() - startTime) / 1000.0;
  addLog(`图片数据发送完成！耗时: ${sendTime}s，等待屏幕刷新。`);
  setStatus(`图片数据发送完成，正在刷新屏幕...`);
  startImageRefreshWait();
  if (!await write(EpdCmd.REFRESH)) {
    cancelImageRefreshWait();
    if (targetSlot != null) removeSlotImageCache(targetSlot);
    setStatus('刷新命令发送失败。');
    imageTransferActive = false;
    updateButtonStatus();
    return false;
  }
  return true;
}

function downloadDataArray() {
  if (cropManager) cropManager.commitPendingTransform(false);
  const mode = document.getElementById('ditherMode').value;
  const processedData = processCanvasImageData();

  if (mode === 'sixColor' && processedData.length !== canvas.width * canvas.height) {
    console.log(`错误：预期${canvas.width * canvas.height}字节，但得到${processedData.length}字节`);
    addLog('数组大小不匹配。请检查图像尺寸和模式。');
    return;
  }

  const dataLines = [];
  for (let i = 0; i < processedData.length; i++) {
    const hexValue = (processedData[i] & 0xff).toString(16).padStart(2, '0');
    dataLines.push(`0x${hexValue}`);
  }

  const formattedData = [];
  for (let i = 0; i < dataLines.length; i += 16) {
    formattedData.push(dataLines.slice(i, i + 16).join(', '));
  }

  const colorModeValue = mode === 'sixColor' ? 0 : mode === 'fourColor' ? 1 : mode === 'blackWhiteColor' ? 2 : 3;
  const arrayContent = [
    'const uint8_t imageData[] PROGMEM = {',
    formattedData.join(',\n'),
    '};',
    `const uint16_t imageWidth = ${canvas.width};`,
    `const uint16_t imageHeight = ${canvas.height};`,
    `const uint8_t colorMode = ${colorModeValue};`
  ].join('\n');

  const blob = new Blob([arrayContent], { type: 'text/plain' });
  const link = document.createElement('a');
  link.download = 'imagedata.h';
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

function updateButtonStatus(forceDisabled = imageTransferActive || slotActionPending || slotReadState !== null) {
  const connected = gattServer != null && gattServer.connected;
  const status = forceDisabled ? 'disabled' : (connected ? null : 'disabled');
  document.getElementById("reconnectbutton").disabled = (gattServer == null || gattServer.connected) ? 'disabled' : null;
  document.getElementById("sendcmdbutton").disabled = status;
  document.getElementById("calendarmodebutton").disabled = status;
  document.getElementById("clockmodebutton").disabled = status;
  document.getElementById("clearscreenbutton").disabled = status;
  document.getElementById("sendimgbutton").disabled = status;
  document.getElementById("setDriverbutton").disabled = status;
  document.getElementById("refreshSlotsButton").disabled = status;
  document.getElementById("eraseAllSlotsButton").disabled = status || slotState.usedMask === 0 ? 'disabled' : null;
  document.getElementById("startSlotSlideButton").disabled = status || slotState.usedMask === 0 ? 'disabled' : null;
  document.getElementById("randomSlotSlideButton").disabled = status || slotState.usedMask === 0 ? 'disabled' : null;
  document.getElementById("stopSlotSlideButton").disabled = status;
  renderSlotGrid(forceDisabled);
}

function finishDisconnect(message = '已断开连接.') {
  const hadConnectionState = gattServer || epdService || epdCharacteristic ||
    (bleDevice && bleDevice.gatt && bleDevice.gatt.connected);
  resetVariables({ clearLog: false });
  document.getElementById("connectbutton").innerHTML = '连接';
  updateButtonStatus();
  if (message && hadConnectionState) addLog(message);
}

function disconnect() {
  finishDisconnect('已断开连接.');
}

async function disconnectDevice() {
  const device = bleDevice;
  updateButtonStatus(true);
  try {
    if (device && device.gatt && device.gatt.connected) {
      addLog('正在断开蓝牙连接...');
      device.gatt.disconnect();
      await sleep(200);
    }
  } catch (e) {
    console.error(e);
    if (e.message) addLog('disconnect: ' + e.message);
  }
  finishDisconnect('已断开连接.');
}

function disconnectDeviceOnPageExit() {
  if (pageExitDisconnecting) return;
  pageExitDisconnecting = true;

  const device = bleDevice;
  try {
    if (device && device.gatt && device.gatt.connected) {
      device.gatt.disconnect();
    }
  } catch (e) {
    console.error(e);
  }
}

async function disconnectStaleBleConnections() {
  if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') return;

  try {
    const devices = await navigator.bluetooth.getDevices();
    let disconnected = false;
    for (const device of devices) {
      const isEpdDevice = device && (device.name || '').startsWith('NRF_EPD');
      if (isEpdDevice && device.gatt && device.gatt.connected) {
        device.gatt.disconnect();
        disconnected = true;
      }
    }
    if (disconnected) addLog('已清理刷新前遗留的蓝牙连接。');
  } catch (e) {
    console.error(e);
  }
}

async function preConnect() {
  const connected = (gattServer && gattServer.connected) ||
    (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) ||
    epdCharacteristic != null;
  if (connected) {
    await disconnectDevice();
    return;
  }
  else {
    resetVariables();
    try {
      addLog("正在扫描墨水屏蓝牙设备...");
      bleDevice = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [EPD_SERVICE_UUID] },
          { namePrefix: 'NRF_EPD' }
        ],
        optionalServices: [EPD_SERVICE_UUID]
      });
    } catch (e) {
      console.error(e);
      if (e.message) addLog("requestDevice: " + e.message);
      addLog("请检查蓝牙是否已开启，且使用的浏览器支持蓝牙！建议使用以下浏览器：");
      addLog("• 电脑: Chrome/Edge");
      addLog("• Android: Chrome/Edge");
      addLog("• iOS: Bluefy 浏览器");
      return;
    }

    await bleDevice.addEventListener('gattserverdisconnected', disconnect);
    setTimeout(async function () { await connect(); }, 300);
  }
}

async function reConnect() {
  if (bleDevice != null && bleDevice.gatt.connected)
    bleDevice.gatt.disconnect();
  resetVariables();
  addLog("正在重连");
  setTimeout(async function () { await connect(); }, 300);
}

function handleDisplayError(code) {
  const busyTimeout = code === 'busy_timeout';
  const message = busyTimeout
    ? '屏幕 BUSY 等待超时，当前驱动可能与屏幕不匹配。请切换对应屏幕驱动后重试，蓝牙连接将保持。'
    : '设备正在执行其他显示操作，请稍后重试。';

  displayErrorActive = busyTimeout;
  cancelImageRefreshWait();
  imageTransferActive = false;
  if (slotActionPending) setSlotActionPending(false);
  if (slotReadState) failSlotImageRead(message);
  const status = document.getElementById('status');
  status.parentElement.style.display = 'block';
  setStatus(message);
  addLog(message, '', 'error');
  updateButtonStatus();
}

function handleNotify(value, idx) {
  const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const isImageInfo = data.length >= 4 && data[0] === 0x69 && data[1] === 0x6D &&
    data[2] === 0x67 && data[3] === 0x3D;
  if (slotReadState && slotReadState.expectedChunk && !isImageInfo) {
    receiveSlotChunk(data);
    return;
  }

  const isTextNotification = data.length > 0 && data.every(byte => byte >= 0x20 && byte <= 0x7E);
  if (!isTextNotification && data.length === EPD_CONFIG_SIZE) {
    addLog(`收到配置：${bytes2hex(data)}`);
    const epdpins = document.getElementById("epdpins");
    const epddriver = document.getElementById("epddriver");
    epdpins.value = bytes2hex(data.slice(0, 7));
    if (data.length > 10) epdpins.value += bytes2hex(data.slice(10, 11));
    currentPinsValue = epdpins.value.trim().toLowerCase();
    epddriver.value = bytes2hex(data.slice(7, 8));
    displayErrorActive = false;
    updateDitcherOptions();
  } else {
    if (textDecoder == null) textDecoder = new TextDecoder();
    const msg = textDecoder.decode(data);
    if (!msg.startsWith('chunk=')) addLog(msg, '⇓');
    if (applySlotsMessage(msg)) {
      addLog('图片槽位状态已更新。');
    } else if (msg === 'ready=1') {
      completeImageRefresh();
    } else if (beginSlotImageRead(msg)) {
      addLog('开始接收槽位图片。');
    } else if (beginSlotChunk(msg)) {
      // The next notification contains the binary chunk.
    } else if (msg.startsWith('display_error=')) {
      handleDisplayError(msg.substring('display_error='.length));
    } else if (msg.startsWith('slot_error=')) {
      const errorMessage = `槽位操作失败：${msg.substring('slot_error='.length)}`;
      if (slotActionPending) setSlotActionPending(false);
      if (slotReadState) {
        failSlotImageRead(errorMessage);
      } else {
        const status = document.getElementById('slotReadStatus');
        status.hidden = false;
        status.textContent = errorMessage;
        addLog(errorMessage);
      }
    } else if (msg.startsWith('mtu=') && msg.length > 4) {
      const mtuParts = msg.substring(4).trim().split(/\s+/);
      const mtuSize = parseInt(mtuParts[0], 10);
      rleSupport = mtuParts.includes('rle=1');
      document.getElementById('mtusize').value = mtuSize;
      addLog(`MTU 已更新为: ${mtuSize}`);
      if (rleSupport) addLog('设备已启用 RLE 压缩传输。');
    } else if (msg.startsWith('t=') && msg.length > 2) {
      const t = parseInt(msg.substring(2)) + new Date().getTimezoneOffset() * 60;
      addLog(`远端时间: ${new Date(t * 1000).toLocaleString()}`);
      addLog(`本地时间: ${new Date().toLocaleString()}`);
    }
  }
}

async function connect() {
  if (bleDevice == null || epdCharacteristic != null) return;

  try {
    addLog("正在连接: " + bleDevice.name);
    gattServer = await bleDevice.gatt.connect();
    addLog('  找到 GATT Server');
    epdService = await gattServer.getPrimaryService(EPD_SERVICE_UUID);
    addLog('  找到 EPD Service');
    epdCharacteristic = await epdService.getCharacteristic(EPD_CHARACTERISTIC_UUID);
    addLog('  找到 Characteristic');
  } catch (e) {
    console.error(e);
    if (e.message) addLog("connect: " + e.message);
    disconnect();
    return;
  }

  try {
    const versionCharacteristic = await epdService.getCharacteristic(EPD_VERSION_UUID);
    const versionData = await versionCharacteristic.readValue();
    appVersion = versionData.getUint8(0);
    addLog(`固件版本: 0x${appVersion.toString(16)}`);
  } catch (e) {
    console.error(e);
    appVersion = 0x15;
  }

  if (appVersion < 0x16) {
    const oldURL = "https://tsl0922.github.io/EPD-nRF5/v1.5";
    alert("!!!注意!!!\n当前固件版本过低，可能无法正常使用部分功能，建议升级到最新版本。");
    if (confirm('是否访问旧版本上位机？')) location.href = oldURL;
    setTimeout(() => {
      addLog(`如遇到问题，可访问旧版本上位机: ${oldURL}`);
    }, 500);
  }

  try {
    await epdCharacteristic.startNotifications();
    epdCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      handleNotify(event.target.value, msgIndex++);
    });
  } catch (e) {
    console.error(e);
    if (e.message) addLog("startNotifications: " + e.message);
  }

  await write(EpdCmd.INIT);

  document.getElementById("connectbutton").innerHTML = '断开';
  updateButtonStatus();
}

function setStatus(statusText) {
  document.getElementById("status").innerHTML = statusText;
}

function addLog(logTXT, action = '', type = '') {
  const log = document.getElementById("log");
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ":" +
    String(now.getMinutes()).padStart(2, '0') + ":" +
    String(now.getSeconds()).padStart(2, '0') + " ";

  const logEntry = document.createElement('div');
  const timeSpan = document.createElement('span');
  logEntry.className = type ? 'log-line ' + type : 'log-line';
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  logEntry.appendChild(timeSpan);

  if (action !== '') {
    const actionSpan = document.createElement('span');
    actionSpan.className = 'action';
    actionSpan.innerHTML = action;
    logEntry.appendChild(actionSpan);
  }
  logEntry.appendChild(document.createTextNode(logTXT));

  log.appendChild(logEntry);
  log.scrollTop = log.scrollHeight;

  while (log.childNodes.length > 20) {
    log.removeChild(log.firstChild);
  }
}

function clearLog() {
  document.getElementById("log").innerHTML = '';
}

function fillCanvas(style) {
  resetDitherPreviewSource();
  ctx.fillStyle = style;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (paintManager && paintManager.setBaseImageData) paintManager.setBaseImageData();
}

function cloneImageData(imageData) {
  return new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height
  );
}

function resetDitherPreviewSource() {
  ditherSourceImageData = null;
  ditherPreviewActive = false;
}

function setCanvasTitle(title) {
  const canvasTitle = document.querySelector('.canvas-title');
  if (canvasTitle) {
    canvasTitle.innerText = title;
    canvasTitle.style.display = title && title !== '' ? 'block' : 'none';
  }
}

function renderTransformedImagePreview(sourceImageData, commitHistory = false) {
  ditherSourceImageData = cloneImageData(sourceImageData);
  ditherPreviewActive = true;
  const settings = getDitherSettings();
  const processedData = processCanvasImageData();
  const finalImageData = decodeProcessedData(processedData, canvas.width, canvas.height, settings.mode);
  ctx.putImageData(finalImageData, 0, 0);

  if (paintManager && paintManager.setBaseImageData) paintManager.setBaseImageData();
  if (commitHistory && paintManager) {
    paintManager.clearHistory();
    paintManager.saveToHistory();
  }
}

function resetPaintForImageLoad() {
  if (!paintManager) return;
  paintManager.setActiveTool(null, '');
  paintManager.clearElements();
  paintManager.clearHistory();
}

function updateImage(file = null) {
  const imageFile = document.getElementById('imageFile');
  const selectedFile = file || (imageFile.files.length > 0 ? imageFile.files[0] : null);
  if (!selectedFile) {
    if (cropManager) cropManager.clearImage();
    fillCanvas('white');
    return;
  }

  resetDitherPreviewSource();
  resetPaintForImageLoad();
  cropManager.loadFile(selectedFile).catch((error) => {
    cropManager.clearImage();
    fillCanvas('white');
    addLog(`图片读取失败：${error.message || error}`);
    alert('图片文件无法读取，请重新选择。');
  });
}

function updateCanvasSize() {
  resetDitherPreviewSource();
  const selectedSizeName = document.getElementById('canvasSize').value;
  const selectedSize = canvasSizes.find(size => size.name === selectedSizeName);

  canvas.width = selectedSize.width;
  canvas.height = selectedSize.height;

  updateImage();
}

function updateDitcherOptions() {
  const epdDriverSelect = document.getElementById('epddriver');
  const selectedOption = epdDriverSelect.options[epdDriverSelect.selectedIndex];
  const colorMode = selectedOption.getAttribute('data-color');
  const canvasSize = selectedOption.getAttribute('data-size');

  updateDriverMeta(selectedOption);
  if (colorMode) document.getElementById('ditherMode').value = colorMode;
  if (canvasSize) document.getElementById('canvasSize').value = canvasSize;

  updateCanvasSize(); // always update image
  if (paintManager && typeof paintManager.refreshMatterTemplatePalette === 'function') {
    paintManager.refreshMatterTemplatePalette();
  }
}

function updateDriverMeta(option) {
  const meta = document.getElementById('driverMeta');
  if (!meta) return;

  const epdDriverSelect = document.getElementById('epddriver');
  const selectedOption = option || epdDriverSelect.options[epdDriverSelect.selectedIndex];
  const driverName = selectedOption ? selectedOption.textContent.trim() : 'EPD';
  meta.textContent = `${driverName} · Web Bluetooth`;
}

function clearCanvas() {
  if (confirm('清除画布内容?')) {
    if (cropManager) cropManager.clearImage();
    const imageFile = document.getElementById('imageFile');
    if (imageFile) imageFile.value = '';
    fillCanvas('white');
    paintManager.clearElements(); // Clear stored text positions and line segments
    if (paintManager.setBaseImageData) paintManager.setBaseImageData();
    if (paintManager.clearScheduleCache) paintManager.clearScheduleCache();
    paintManager.clearHistory();
    paintManager.saveToHistory(); // Save cleared canvas to history
    return true;
  }
  return false;
}

function getDitherSettings() {
  return {
    contrast: parseFloat(document.getElementById('ditherContrast').value),
    brightness: parseFloat(document.getElementById('ditherBrightness').value),
    saturation: parseFloat(document.getElementById('ditherSaturation').value),
    alg: document.getElementById('ditherAlg').value,
    strength: parseFloat(document.getElementById('ditherStrength').value),
    mode: document.getElementById('ditherMode').value
  };
}

function prepareDitherImageData(sourceImageData, settings) {
  const imageData = new ImageData(
    new Uint8ClampedArray(sourceImageData.data),
    sourceImageData.width,
    sourceImageData.height
  );

  adjustBrightnessSaturation(imageData, settings.brightness, settings.saturation);
  adjustContrast(imageData, settings.contrast);
  return imageData;
}

function processCanvasImageData() {
  const settings = getDitherSettings();
  if (!ditherPreviewActive || !ditherSourceImageData) {
    ditherSourceImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  const sourceImageData = cloneImageData(ditherSourceImageData);
  const imageData = prepareDitherImageData(sourceImageData, settings);
  return processImageData(ditherImage(imageData, settings.alg, settings.strength, settings.mode), settings.mode);
}

function convertDithering() {
  paintManager.redrawTextElements();
  paintManager.redrawLineSegments();
  if (paintManager.redrawTodoItems) paintManager.redrawTodoItems();
  if (paintManager.drawSchedule) paintManager.drawSchedule();

  const settings = getDitherSettings();
  const processedData = processCanvasImageData();
  const finalImageData = decodeProcessedData(processedData, canvas.width, canvas.height, settings.mode);
  ctx.putImageData(finalImageData, 0, 0);
  ditherPreviewActive = true;

  paintManager.saveToHistory(); // Save dithered image to history
}

function applyDither() {
  convertDithering();
}

function setDitherAdjustment(id, value, digits) {
  const input = document.getElementById(id);
  const label = document.getElementById(`${id}Value`);
  input.value = value;
  label.innerText = parseFloat(value).toFixed(digits);
  updateRangeFill(input);
}

function resetDitherAdjustments() {
  setDitherAdjustment('ditherStrength', 1.0, 1);
  setDitherAdjustment('ditherContrast', 1.2, 1);
  setDitherAdjustment('ditherBrightness', 0, 0);
  setDitherAdjustment('ditherSaturation', 1.2, 1);
  applyDither();
}

function clampUiOpacity(value) {
  const opacity = parseFloat(value);
  if (Number.isNaN(opacity)) return DEFAULT_UI_OPACITY;
  return Math.min(1, Math.max(0, opacity));
}

function applyUiOpacity(value) {
  const opacity = clampUiOpacity(value);
  document.documentElement.style.setProperty('--ui-opacity', opacity.toFixed(2));
  document.documentElement.style.setProperty('--ui-footer-opacity', Math.max(0, opacity - 0.1).toFixed(2));
  document.documentElement.style.setProperty('--ui-border-opacity', opacity.toFixed(2));
  document.documentElement.style.setProperty('--ui-border-soft-opacity', (opacity * 0.08).toFixed(3));
  document.documentElement.style.setProperty('--ui-blue-border-soft-opacity', (opacity * 0.16).toFixed(3));

  const range = document.getElementById('uiOpacityRange');
  const label = document.getElementById('uiOpacityValue');
  if (range) {
    range.value = opacity.toFixed(2);
    updateRangeFill(range);
  }
  if (label) label.innerText = `${Math.round(opacity * 100)}%`;
}

function loadUiOpacity() {
  try {
    applyUiOpacity(localStorage.getItem(UI_OPACITY_STORAGE_KEY) || DEFAULT_UI_OPACITY);
  } catch (e) {
    console.error(e);
    applyUiOpacity(DEFAULT_UI_OPACITY);
  }
}

function saveUiOpacity(value) {
  const opacity = clampUiOpacity(value);
  applyUiOpacity(opacity);
  try {
    localStorage.setItem(UI_OPACITY_STORAGE_KEY, opacity.toFixed(2));
  } catch (e) {
    console.error(e);
  }
}

function clampGlassClarity(value) {
  const clarity = parseFloat(value);
  if (Number.isNaN(clarity)) return DEFAULT_GLASS_CLARITY;
  return Math.min(1, Math.max(0, clarity));
}

function applyGlassClarity(value) {
  const clarity = clampGlassClarity(value);
  const blur = (1 - clarity) * MAX_GLASS_BLUR;
  const backgroundBlur = blur * 0.55;
  document.documentElement.style.setProperty('--glass-blur-size', `${blur.toFixed(1)}px`);
  document.documentElement.style.setProperty('--page-bg-glass-blur-size', `${backgroundBlur.toFixed(1)}px`);

  const range = document.getElementById('glassClarityRange');
  const label = document.getElementById('glassClarityValue');
  if (range) {
    range.value = clarity.toFixed(2);
    updateRangeFill(range);
  }
  if (label) label.innerText = `${Math.round(clarity * 100)}%`;
}

function loadGlassClarity() {
  try {
    applyGlassClarity(localStorage.getItem(GLASS_CLARITY_STORAGE_KEY) || DEFAULT_GLASS_CLARITY);
  } catch (e) {
    console.error(e);
    applyGlassClarity(DEFAULT_GLASS_CLARITY);
  }
}

function saveGlassClarity(value) {
  const clarity = clampGlassClarity(value);
  applyGlassClarity(clarity);
  try {
    localStorage.setItem(GLASS_CLARITY_STORAGE_KEY, clarity.toFixed(2));
  } catch (e) {
    console.error(e);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = parseFloat(value);
  if (Number.isNaN(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizePageBackgroundSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const fit = ['cover', 'contain', '100% 100%'].includes(source.fit) ? source.fit : DEFAULT_PAGE_BACKGROUND_SETTINGS.fit;
  return {
    fit,
    zoom: clampNumber(source.zoom, 0.5, 3, DEFAULT_PAGE_BACKGROUND_SETTINGS.zoom),
    offsetX: clampNumber(source.offsetX, -40, 40, DEFAULT_PAGE_BACKGROUND_SETTINGS.offsetX),
    offsetY: clampNumber(source.offsetY, -40, 40, DEFAULT_PAGE_BACKGROUND_SETTINGS.offsetY),
    rotate: clampNumber(source.rotate, -180, 180, DEFAULT_PAGE_BACKGROUND_SETTINGS.rotate),
    flipX: source.flipX === true,
    flipY: source.flipY === true,
    brightness: clampNumber(source.brightness, 0.4, 1.6, DEFAULT_PAGE_BACKGROUND_SETTINGS.brightness),
    contrast: clampNumber(source.contrast, 0.5, 1.8, DEFAULT_PAGE_BACKGROUND_SETTINGS.contrast),
    saturation: clampNumber(source.saturation, 0, 2, DEFAULT_PAGE_BACKGROUND_SETTINGS.saturation),
    mask: clampNumber(source.mask, 0, 0.7, DEFAULT_PAGE_BACKGROUND_SETTINGS.mask)
  };
}

function setRangeControl(rangeId, labelId, value, formatter) {
  const range = document.getElementById(rangeId);
  const label = document.getElementById(labelId);
  if (range) {
    range.value = value;
    updateRangeFill(range);
  }
  if (label) label.innerText = formatter(value);
}

function syncPageBackgroundSettingsControls(settings) {
  setRangeControl('bgZoomRange', 'bgZoomValue', settings.zoom, (value) => `${Math.round(value * 100)}%`);
  setRangeControl('bgOffsetXRange', 'bgOffsetXValue', settings.offsetX, (value) => `${Math.round(value)}%`);
  setRangeControl('bgOffsetYRange', 'bgOffsetYValue', settings.offsetY, (value) => `${Math.round(value)}%`);
  setRangeControl('bgRotateRange', 'bgRotateValue', settings.rotate, (value) => `${Math.round(value)}°`);
  setRangeControl('bgBrightnessRange', 'bgBrightnessValue', settings.brightness, (value) => `${Math.round(value * 100)}%`);
  setRangeControl('bgContrastRange', 'bgContrastValue', settings.contrast, (value) => `${Math.round(value * 100)}%`);
  setRangeControl('bgSaturationRange', 'bgSaturationValue', settings.saturation, (value) => `${Math.round(value * 100)}%`);
  setRangeControl('bgMaskRange', 'bgMaskValue', settings.mask, (value) => `${Math.round(value * 100)}%`);

  document.querySelectorAll('[data-bg-fit]').forEach((button) => {
    button.classList.toggle('active', button.dataset.bgFit === settings.fit);
  });
  document.querySelectorAll('[data-bg-toggle]').forEach((button) => {
    button.classList.toggle('active', settings[button.dataset.bgToggle] === true);
  });
}

function applyPageBackgroundSettings(settings) {
  const normalized = normalizePageBackgroundSettings(settings);
  document.documentElement.style.setProperty('--page-bg-fit', normalized.fit);
  document.documentElement.style.setProperty(
    '--page-bg-transform',
    `translate(${normalized.offsetX}%, ${normalized.offsetY}%) scale(${normalized.flipX ? -normalized.zoom : normalized.zoom}, ${normalized.flipY ? -normalized.zoom : normalized.zoom}) rotate(${normalized.rotate}deg)`
  );
  document.documentElement.style.setProperty(
    '--page-bg-filter',
    `brightness(${normalized.brightness}) contrast(${normalized.contrast}) saturate(${normalized.saturation})`
  );
  document.documentElement.style.setProperty('--page-bg-overlay-opacity', normalized.mask.toFixed(2));
  syncPageBackgroundSettingsControls(normalized);
  return normalized;
}

function savePageBackgroundSettings(settings) {
  const normalized = applyPageBackgroundSettings(settings);
  try {
    localStorage.setItem(PAGE_BACKGROUND_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch (e) {
    console.error(e);
  }
  return normalized;
}

function loadPageBackgroundSettings() {
  let settings = DEFAULT_PAGE_BACKGROUND_SETTINGS;
  try {
    const stored = localStorage.getItem(PAGE_BACKGROUND_SETTINGS_STORAGE_KEY);
    if (stored) settings = JSON.parse(stored);
  } catch (e) {
    console.error(e);
  }
  return applyPageBackgroundSettings(settings);
}

function updatePageBackgroundSetting(key, value) {
  const current = readPageBackgroundSettingsFromControls();
  current[key] = value;
  savePageBackgroundSettings(current);
}

function readPageBackgroundSettingsFromControls() {
  const activeFit = document.querySelector('[data-bg-fit].active');
  return normalizePageBackgroundSettings({
    fit: activeFit ? activeFit.dataset.bgFit : DEFAULT_PAGE_BACKGROUND_SETTINGS.fit,
    flipX: document.querySelector('[data-bg-toggle="flipX"]')?.classList.contains('active'),
    flipY: document.querySelector('[data-bg-toggle="flipY"]')?.classList.contains('active'),
    zoom: document.getElementById('bgZoomRange')?.value,
    offsetX: document.getElementById('bgOffsetXRange')?.value,
    offsetY: document.getElementById('bgOffsetYRange')?.value,
    rotate: document.getElementById('bgRotateRange')?.value,
    brightness: document.getElementById('bgBrightnessRange')?.value,
    contrast: document.getElementById('bgContrastRange')?.value,
    saturation: document.getElementById('bgSaturationRange')?.value,
    mask: document.getElementById('bgMaskRange')?.value
  });
}

function openBackgroundSettings() {
  const modal = document.getElementById('backgroundSettingsModal');
  if (modal) modal.hidden = false;
}

function closeBackgroundSettings() {
  const modal = document.getElementById('backgroundSettingsModal');
  if (modal) modal.hidden = true;
}

function toggleBackgroundControls(forceOpen) {
  const panel = document.getElementById('backgroundControls');
  const button = document.getElementById('toggleBackgroundControls');
  if (!panel || !button) return;
  const show = typeof forceOpen === 'boolean' ? forceOpen : panel.hidden;
  panel.hidden = !show;
  button.classList.toggle('active', show);
  button.setAttribute('aria-expanded', String(show));
}

function resetBackgroundAdjustments() {
  savePageBackgroundSettings(DEFAULT_PAGE_BACKGROUND_SETTINGS);
}

function applyPageBackground(dataUrl) {
  if (!dataUrl) {
    document.body.classList.remove('custom-background');
    document.documentElement.style.setProperty('--page-bg-image', 'none');
    return;
  }

  document.body.classList.add('custom-background');
  document.documentElement.style.setProperty('--page-bg-image', `url("${dataUrl}")`);
}

function loadPageBackground() {
  try {
    applyPageBackground(localStorage.getItem(PAGE_BACKGROUND_STORAGE_KEY));
  } catch (e) {
    console.error(e);
  }
}

function clearPageBackground() {
  try {
    localStorage.removeItem(PAGE_BACKGROUND_STORAGE_KEY);
  } catch (e) {
    console.error(e);
  }
  const input = document.getElementById('pageBackgroundFile');
  if (input) input.value = '';
  applyPageBackground('');
}

function resetBackgroundDefaults() {
  try {
    localStorage.removeItem(PAGE_BACKGROUND_STORAGE_KEY);
    localStorage.removeItem(PAGE_BACKGROUND_SETTINGS_STORAGE_KEY);
    localStorage.removeItem(UI_OPACITY_STORAGE_KEY);
    localStorage.removeItem(GLASS_CLARITY_STORAGE_KEY);
  } catch (e) {
    console.error(e);
  }
  const input = document.getElementById('pageBackgroundFile');
  if (input) input.value = '';
  applyPageBackground('');
  applyPageBackgroundSettings(DEFAULT_PAGE_BACKGROUND_SETTINGS);
  applyUiOpacity(DEFAULT_UI_OPACITY);
  applyGlassClarity(DEFAULT_GLASS_CLARITY);
}

function resizeBackgroundImage(image) {
  const scale = Math.min(1, PAGE_BACKGROUND_MAX_SIZE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d');
  bgCanvas.width = width;
  bgCanvas.height = height;
  bgCtx.fillStyle = '#ffffff';
  bgCtx.fillRect(0, 0, width, height);
  bgCtx.drawImage(image, 0, 0, width, height);
  return bgCanvas.toDataURL('image/jpeg', PAGE_BACKGROUND_QUALITY);
}

function setPageBackgroundFromFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    alert('请选择图片文件作为网页背景。');
    return;
  }

  const image = new Image();
  image.onload = function () {
    URL.revokeObjectURL(image.src);
    try {
      const dataUrl = resizeBackgroundImage(image);
      localStorage.setItem(PAGE_BACKGROUND_STORAGE_KEY, dataUrl);
      savePageBackgroundSettings(DEFAULT_PAGE_BACKGROUND_SETTINGS);
      applyPageBackground(dataUrl);
    } catch (e) {
      console.error(e);
      alert('背景图片保存失败，请换一张更小的图片。');
    }
  };
  image.onerror = function () {
    URL.revokeObjectURL(image.src);
    alert('背景图片读取失败，请换一张图片。');
  };
  image.src = URL.createObjectURL(file);
}

function setActiveGlobalNav(link) {
  document.querySelectorAll('.global-nav a').forEach((item) => item.classList.remove('active'));
  if (link) link.classList.add('active');
}

function initGlobalNavActive() {
  const links = document.querySelectorAll('.global-nav a');
  links.forEach((link) => {
    link.addEventListener('click', () => setActiveGlobalNav(link));
  });

  const current = Array.from(links).find((link) => link.getAttribute('href') === window.location.hash);
  setActiveGlobalNav(current || document.querySelector('.global-nav .global-brand'));
}

function updateRangeFill(range) {
  if (!range) return;
  const min = parseFloat(range.min || '0');
  const max = parseFloat(range.max || '100');
  const value = parseFloat(range.value || '0');
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  range.style.setProperty('--range-fill', `${Math.max(0, Math.min(100, percent))}%`);
}

function initRangeFill() {
  document.querySelectorAll('input[type="range"]').forEach((range) => {
    updateRangeFill(range);
    range.addEventListener('input', () => updateRangeFill(range));
  });
}

function initEventHandlers() {
  initGlobalNavActive();
  initRangeFill();
  updateDriverMeta();
  document.getElementById("clear-canvas").addEventListener("click", clearCanvas);
  const imageDropZone = document.getElementById('imageDropZone');
  const imageFile = document.getElementById('imageFile');
  if (imageDropZone && imageFile) {
    imageDropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      imageDropZone.classList.add('drag-over');
    });
    imageDropZone.addEventListener('dragleave', () => imageDropZone.classList.remove('drag-over'));
    imageDropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      imageDropZone.classList.remove('drag-over');
      const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
      if (!file || !file.type.startsWith('image/')) {
        addLog('拖放失败：请选择有效的图片文件。');
        return;
      }
      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        imageFile.files = transfer.files;
      } catch (_) {
        addLog('浏览器无法同步拖放文件，请改用文件选择按钮。');
        return;
      }
      updateImage(file);
    });
  }
  document.getElementById("resetDitherAdjustments").addEventListener("click", resetDitherAdjustments);
  document.getElementById("pageBackgroundFile").addEventListener("change", (e) => {
    setPageBackgroundFromFile(e.target.files[0]);
  });
  document.getElementById("toggleBackgroundControls").addEventListener("click", () => toggleBackgroundControls());
  document.getElementById("openBackgroundSettings").addEventListener("click", openBackgroundSettings);
  document.getElementById("closeBackgroundSettings").addEventListener("click", closeBackgroundSettings);
  document.getElementById("doneBackgroundSettings").addEventListener("click", closeBackgroundSettings);
  document.getElementById("resetBackgroundAdjustments").addEventListener("click", resetBackgroundAdjustments);
  document.getElementById("backgroundSettingsModal").addEventListener("click", (e) => {
    if (e.target.id === 'backgroundSettingsModal') closeBackgroundSettings();
  });
  document.querySelectorAll('[data-bg-fit]').forEach((button) => {
    button.addEventListener('click', () => updatePageBackgroundSetting('fit', button.dataset.bgFit));
  });
  document.querySelectorAll('[data-bg-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const current = readPageBackgroundSettingsFromControls();
      current[button.dataset.bgToggle] = !current[button.dataset.bgToggle];
      savePageBackgroundSettings(current);
    });
  });
  [
    ['bgZoomRange', 'zoom'],
    ['bgOffsetXRange', 'offsetX'],
    ['bgOffsetYRange', 'offsetY'],
    ['bgRotateRange', 'rotate'],
    ['bgBrightnessRange', 'brightness'],
    ['bgContrastRange', 'contrast'],
    ['bgSaturationRange', 'saturation'],
    ['bgMaskRange', 'mask']
  ].forEach(([rangeId, key]) => {
    document.getElementById(rangeId).addEventListener('input', (e) => updatePageBackgroundSetting(key, e.target.value));
  });
  document.getElementById("clearPageBackground").addEventListener("click", clearPageBackground);
  document.getElementById("resetBackgroundDefaults").addEventListener("click", resetBackgroundDefaults);
  document.getElementById("uiOpacityRange").addEventListener("input", (e) => {
    saveUiOpacity(e.target.value);
  });
  document.getElementById("glassClarityRange").addEventListener("input", (e) => {
    saveGlassClarity(e.target.value);
  });
  document.getElementById("ditherMode").addEventListener("change", () => {
    if (paintManager && typeof paintManager.refreshMatterTemplatePalette === 'function') {
      paintManager.refreshMatterTemplatePalette();
    }
  });
  document.getElementById("ditherStrength").addEventListener("input", (e) => {
    document.getElementById("ditherStrengthValue").innerText = parseFloat(e.target.value).toFixed(1);
    applyDither();
  });
  document.getElementById("ditherContrast").addEventListener("input", (e) => {
    document.getElementById("ditherContrastValue").innerText = parseFloat(e.target.value).toFixed(1);
    applyDither();
  });
  document.getElementById("ditherBrightness").addEventListener("input", (e) => {
    document.getElementById("ditherBrightnessValue").innerText = parseFloat(e.target.value).toFixed(0);
    applyDither();
  });
  document.getElementById("ditherSaturation").addEventListener("input", (e) => {
    document.getElementById("ditherSaturationValue").innerText = parseFloat(e.target.value).toFixed(1);
    applyDither();
  });
}

function checkDebugMode() {
  const link = document.getElementById('debug-toggle');
  const urlParams = new URLSearchParams(window.location.search);
  const debugMode = urlParams.get('debug');

  if (debugMode === 'true') {
    document.body.classList.add('dark-mode');
    link.innerHTML = '正常模式';
    link.setAttribute('href', window.location.pathname);
    addLog("注意：开发模式功能已开启！错误设置可能导致连接异常或显示异常，不懂请不要随意修改，否则后果自负！", "⚠", "warning");
  } else {
    document.body.classList.remove('dark-mode');
    link.innerHTML = '开发模式';
    link.setAttribute('href', window.location.pathname + '?debug=true');
  }
}

document.body.onload = () => {
  textDecoder = null;
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext("2d");

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  paintManager = new PaintManager(canvas, ctx);
  cropManager = new CropManager(canvas, ctx, paintManager);
  cropManager.setRenderCallback(renderTransformedImagePreview);
  if (paintManager.setBaseImageData) paintManager.setBaseImageData();

  paintManager.initPaintTools();
  cropManager.initCropTools();
  initEventHandlers();
  window.addEventListener('pagehide', disconnectDeviceOnPageExit);
  window.addEventListener('beforeunload', disconnectDeviceOnPageExit);
  disconnectStaleBleConnections();
  updateButtonStatus();
  checkDebugMode();
  loadUiOpacity();
  loadGlassClarity();
  loadPageBackgroundSettings();
  loadPageBackground();
}




