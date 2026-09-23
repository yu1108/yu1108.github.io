let bleDevice, gattServer;
let epdService, epdCharacteristic;
let startTime, msgIndex, appVersion;
let canvas, ctx, textDecoder;
let paintManager, cropManager;

// 响应等待器（GET_SLOTS/GET_SLOT_INFO/GET_REMARK 的回包首字节 'S'/'I'/'R' 需单独拦截）
let pendingNotifyWaiters = [];
// 最近一次槽位总览（存图前判断是否需先删旧）
let slotsCache = null;

// 新旧两套 UUID（新版设备用 9c0f515b…，旧版 nRF 用 62750001…）
const UUID_NEW_SERVICE = '9c0f515b-807c-5046-a268-30ee68b0f783';
const UUID_NEW_WRITE = 'e5e118ff-f14d-5fa5-9b6d-c6fc7725b510';
const UUID_NEW_NOTIFY = '11a366e9-ae6d-5cda-8d80-6e502f8cd319';
const UUID_LEG_SERVICE = '62750001-d828-918d-fb46-b6c11c675aec';
const UUID_LEG_WRITE = '62750002-d828-918d-fb46-b6c11c675aec';
const UUID_LEG_NOTIFY = '62750003-d828-918d-fb46-b6c11c675aec';

const EpdCmd = {
  SET_PINS: 0x00,
  INIT: 0x01,
  CLEAR: 0x02,
  SEND_CMD: 0x03,
  SEND_DATA: 0x04,
  REFRESH: 0x05,
  SLEEP: 0x06,

  SET_TIME: 0x20,

  WRITE_IMG: 0x30, // v1.6

  // 动态存图 / 槽位管理（与 Flutter epd_service 一致）
  STORE_BEGIN: 0x40,
  STORE_DATA: 0x41,
  STORE_END: 0x42,
  STORE_DELETE: 0x43,
  DISPLAY_SLOT: 0x45,
  GET_SLOTS: 0x46,
  SET_REMARK: 0x49,
  GET_REMARK: 0x4A,
  GET_SLOT_INFO: 0x4B,

  SET_CONFIG: 0x90,
  SYS_RESET: 0x91,
  SYS_SLEEP: 0x92,
  CFG_ERASE: 0x99,
};

const canvasSizes = [
  { name: '1.54_152_152', width: 152, height: 152 },
  { name: '1.54_200_200', width: 200, height: 200 },
  { name: '2.13_212_104', width: 212, height: 104 },
  { name: '2.13_250_122', width: 250, height: 122 },
  { name: '2.13_104_212', width: 104, height: 212 },
  { name: '2.13_122_250', width: 122, height: 250 },
  { name: '2.13_128_250', width: 128, height: 250 },
  { name: '2.66_296_152', width: 296, height: 152 },
  { name: '2.9_296_128', width: 296, height: 128 },
  { name: '2.9_384_168', width: 384, height: 168 },
  { name: '3.5_384_184', width: 384, height: 184 },
  { name: '3.7_416_240', width: 416, height: 240 },
  { name: '3.97_800_480', width: 800, height: 480 },
  { name: '3.98_768_552', width: 768, height: 552 },
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

function resetVariables() {
  gattServer = null;
  epdService = null;
  epdCharacteristic = null;
  msgIndex = 0;
  document.getElementById("log").value = '';
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
  addLog(bytes2hex(payload), '⇑');
  try {
    if (withResponse)
      await epdCharacteristic.writeValueWithResponse(Uint8Array.from(payload));
    else
      await epdCharacteristic.writeValueWithoutResponse(Uint8Array.from(payload));
  } catch (e) {
    console.error(e);
    if (e.message) addLog("write: " + e.message);
    return false;
  }
  return true;
}

// 等待首字节匹配指定值的通知回包（GET_SLOTS→'S' 等）。5s 超时。
// matchSlot 可选：要求回包第 2 字节等于某 slot（GET_SLOT_INFO/GET_REMARK）。
// 返回的 promise 上挂 .cancel()：write 失败时调用以移除等待器。
function awaitNotify(firstByte, minLen, matchSlot) {
  let w;
  const p = new Promise((resolve, reject) => {
    w = {
      match: (d) => d.length >= minLen && d[0] === firstByte && (matchSlot == null || d[1] === matchSlot),
      resolve, reject, timer: null,
    };
    w.timer = setTimeout(() => {
      const i = pendingNotifyWaiters.indexOf(w);
      if (i >= 0) pendingNotifyWaiters.splice(i, 1);
      reject(new Error('通知等待超时'));
    }, 5000);
    pendingNotifyWaiters.push(w);
  });
  p.cancel = () => {
    if (!w) return;
    clearTimeout(w.timer);
    const i = pendingNotifyWaiters.indexOf(w);
    if (i >= 0) pendingNotifyWaiters.splice(i, 1);
  };
  return p;
}

// ditherMode → 设备 colorByte（黑白=1，三色/黑白黄=2，四色/六色=3）
function colorModeToByte(mode) {
  if (mode === 'blackWhiteColor') return 1;
  if (mode === 'threeColor' || mode === 'blackWhiteYellow') return 2;
  return 3; // fourColor / sixColor
}

async function writeImage(data, step = 'bw') {
  const chunkSize = document.getElementById('mtusize').value - 2;
  const interleavedCount = document.getElementById('interleavedcount').value;
  const count = Math.round(data.length / chunkSize);
  let chunkIdx = 0;
  let noReplyCount = interleavedCount;

  for (let i = 0; i < data.length; i += chunkSize) {
    let currentTime = (new Date().getTime() - startTime) / 1000.0;
    setStatus(`${step == 'bw' ? '黑白' : '颜色'}块: ${chunkIdx + 1}/${count + 1}, 总用时: ${currentTime}s`);
    const payload = [
      (step == 'bw' ? 0x0F : 0x00) | (i == 0 ? 0x00 : 0xF0),
      ...data.slice(i, i + chunkSize),
    ];
    if (noReplyCount > 0) {
      await write(EpdCmd.WRITE_IMG, payload, false);
      noReplyCount--;
    } else {
      await write(EpdCmd.WRITE_IMG, payload, true);
      noReplyCount = interleavedCount;
    }
    chunkIdx++;
  }
}

async function setDriver() {
  await write(EpdCmd.SET_PINS, document.getElementById("epdpins").value);
  await write(EpdCmd.INIT, document.getElementById("epddriver").value);
}

async function syncTime(mode) {
  if (mode === 2) {
    if (!confirm('提醒：时钟模式目前使用全刷实现，此功能目前多用于修复老化屏残影问题，不建议长期开启，是否继续？')) return;
  }
  const timestamp = new Date().getTime() / 1000;
  const data = new Uint8Array([
    (timestamp >> 24) & 0xFF,
    (timestamp >> 16) & 0xFF,
    (timestamp >> 8) & 0xFF,
    timestamp & 0xFF,
    -(new Date().getTimezoneOffset() / 60),
    mode
  ]);
  if (await write(EpdCmd.SET_TIME, data)) {
    addLog("时间已同步！");
    addLog("屏幕刷新完成前请不要操作。");
  }
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

async function sendimg() {
  if (cropManager.isCropMode()) {
    alert("请先完成图片裁剪！发送已取消。");
    return;
  }

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

  startTime = new Date().getTime();
  const status = document.getElementById("status");
  status.parentElement.style.display = "block";

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processedData = processImageData(imageData, ditherMode);

  updateButtonStatus(true);

  await write(EpdCmd.INIT);

  if (ditherMode === 'fourColor') {
    await writeImage(processedData, 'color');
  } else if (ditherMode === 'threeColor') {
    const halfLength = Math.floor(processedData.length / 2);
    const blackWhiteData = processedData.slice(0, halfLength);
    const redWhiteData = processedData.slice(halfLength);
    if (epdDriverSelect.value === '08' || epdDriverSelect.value === '09') {
      await writeImage(convertUC8159(blackWhiteData, redWhiteData), 'bw');
    } else {
      await writeImage(blackWhiteData, 'bw');
      await writeImage(redWhiteData, 'red');
    }
  } else if (ditherMode === 'blackWhiteColor') {
    if (epdDriverSelect.value === '08' || epdDriverSelect.value === '09') {
      const emptyData = new Uint8Array(processedData.length).fill(0xFF);
      await writeImage(convertUC8159(processedData, emptyData), 'bw');
    } else {
      await writeImage(processedData, 'bw');
    }
  } else if (ditherMode === 'blackWhiteYellow') {
    const halfLength = Math.floor(processedData.length / 2);
    const blackWhiteData = processedData.slice(0, halfLength);
    const yellowWhiteData = processedData.slice(halfLength);
    if (epdDriverSelect.value === '08' || epdDriverSelect.value === '09') {
      await writeImage(convertUC8159(blackWhiteData, yellowWhiteData), 'bw');
    } else {
      await writeImage(blackWhiteData, 'bw');
      await writeImage(yellowWhiteData, 'red');
    }
  } else {
    addLog("当前固件不支持此颜色模式。");
    updateButtonStatus();
    return;
  }

  await write(EpdCmd.REFRESH);
  updateButtonStatus();

  const sendTime = (new Date().getTime() - startTime) / 1000.0;
  addLog(`发送完成！耗时: ${sendTime}s`);
  setStatus(`发送完成！耗时: ${sendTime}s`);
  addLog("屏幕刷新完成前请不要操作。");
  setTimeout(() => {
    status.parentElement.style.display = "none";
  }, 5000);
}

function downloadDataArray() {
  if (cropManager.isCropMode()) {
    alert("请先完成图片裁剪！下载已取消。");
    return;
  }

  const mode = document.getElementById('ditherMode').value;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processedData = processImageData(imageData, mode);

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

function updateButtonStatus(forceDisabled = false) {
  const connected = gattServer != null && gattServer.connected;
  const status = forceDisabled ? 'disabled' : (connected ? null : 'disabled');
  document.getElementById("reconnectbutton").disabled = (gattServer == null || gattServer.connected) ? 'disabled' : null;
  document.getElementById("sendcmdbutton").disabled = status;
  document.getElementById("calendarmodebutton").disabled = status;
  document.getElementById("clockmodebutton").disabled = status;
  document.getElementById("clearscreenbutton").disabled = status;
  document.getElementById("sendimgbutton").disabled = status;
  document.getElementById("setDriverbutton").disabled = status;
}

function disconnect() {
  updateButtonStatus();
  resetVariables();
  addLog('已断开连接.');
  document.getElementById("connectbutton").innerHTML = '连接';
}

async function preConnect() {
  if (gattServer != null && gattServer.connected) {
    if (bleDevice != null && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
  }
  else {
    resetVariables();
    try {
      bleDevice = await navigator.bluetooth.requestDevice({
        optionalServices: [UUID_NEW_SERVICE, UUID_LEG_SERVICE],
        acceptAllDevices: true
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

function handleNotify(value, idx) {
  const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (idx == 0) {
    addLog(`收到配置：${bytes2hex(data)}`);
    const epdpins = document.getElementById("epdpins");
    const epddriver = document.getElementById("epddriver");
    epdpins.value = bytes2hex(data.slice(0, 7));
    if (data.length > 10) epdpins.value += bytes2hex(data.slice(10, 11));
    epddriver.value = bytes2hex(data.slice(7, 8));
    updateDitcherOptions();
    // 槽位刷新改在 connect() 末尾延迟触发，避免与 INIT 的 GATT 写冲突
  } else {
    if (textDecoder == null) textDecoder = new TextDecoder();
    const msg = textDecoder.decode(data);
    addLog(msg, '⇓');
    if (msg.startsWith('mtu=') && msg.length > 4) {
      const mtuSize = parseInt(msg.substring(4));
      document.getElementById('mtusize').value = mtuSize;
      addLog(`MTU 已更新为: ${mtuSize}`);
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
    // 先尝试新版 UUID，失败回退旧版
    let writeUuid, notifyUuid;
    try {
      epdService = await gattServer.getPrimaryService(UUID_NEW_SERVICE);
      writeUuid = UUID_NEW_WRITE; notifyUuid = UUID_NEW_NOTIFY;
      addLog('  找到 EPD Service (新版 UUID)');
    } catch (e) {
      epdService = await gattServer.getPrimaryService(UUID_LEG_SERVICE);
      writeUuid = UUID_LEG_WRITE; notifyUuid = UUID_LEG_NOTIFY;
      addLog('  找到 EPD Service (旧版 UUID)');
    }
    epdCharacteristic = await epdService.getCharacteristic(writeUuid);
    addLog('  找到 Characteristic');
  } catch (e) {
    console.error(e);
    if (e.message) addLog("connect: " + e.message);
    disconnect();
    return;
  }

  try {
    const versionCharacteristic = await epdService.getCharacteristic(notifyUuid);
    const versionData = await versionCharacteristic.readValue();
    appVersion = versionData.getUint8(0);
    addLog(`固件版本: 0x${appVersion.toString(16)}`);
  } catch (e) {
    console.error(e);
    appVersion = 0x15;
  }

  if (appVersion == 0x18) {
    const oldURL = "https://gongchen2020.top/Eink/2.13/index.html";
    alert("!!!注意!!!\n检测到设备固件版本低，请升级固件");
    if (confirm('是否访问旧版上位机？')) location.href = oldURL;
    setTimeout(() => {
    }, 500);
  }

  try {
    await epdCharacteristic.startNotifications();
    epdCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      const dv = event.target.value;
      const data = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      // 先交给响应等待器（GET_SLOTS/GET_SLOT_INFO/GET_REMARK 回包，首字节 'S'/'I'/'R'）
      if (pendingNotifyWaiters.length > 0) {
        const w = pendingNotifyWaiters[0];
        if (w.match(data)) {
          clearTimeout(w.timer);
          pendingNotifyWaiters.shift();
          w.resolve(data);
          return; // 命中：不再走 handleNotify / 不递增 msgIndex
        }
      }
      handleNotify(dv, msgIndex++);
    });
  } catch (e) {
    console.error(e);
    if (e.message) addLog("startNotifications: " + e.message);
  }

  await write(EpdCmd.INIT);

  document.getElementById("connectbutton").innerHTML = '断开';
  updateButtonStatus();

  // 配置/MTU/时间通知通常在 INIT 后 1~2 秒内到达；延迟刷新槽位，等 GATT 栈空闲，
  // 避免「GATT operation already in progress」。
  setTimeout(() => {
    if (gattServer && gattServer.connected) refreshSlots();
  }, 1500);
}

function setStatus(statusText) {
  document.getElementById("status").innerHTML = statusText;
}

function addLog(logTXT, action = '') {
  const log = document.getElementById("log");
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ":" +
    String(now.getMinutes()).padStart(2, '0') + ":" +
    String(now.getSeconds()).padStart(2, '0') + " ";

  const logEntry = document.createElement('div');
  const timeSpan = document.createElement('span');
  logEntry.className = 'log-line';
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
  ctx.fillStyle = style;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function setCanvasTitle(title) {
  const canvasTitle = document.querySelector('.canvas-title');
  if (canvasTitle) {
    canvasTitle.innerText = title;
    canvasTitle.style.display = title && title !== '' ? 'block' : 'none';
  }
}

function updateImage() {
  const imageFile = document.getElementById('imageFile');
  if (imageFile.files.length == 0) {
    fillCanvas('white');
    return;
  }

  const image = new Image();
  image.onload = function () {
    URL.revokeObjectURL(this.src);
    if (image.width / image.height == canvas.width / canvas.height) {
      if (cropManager.isCropMode()) cropManager.exitCropMode();
      ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvas.width, canvas.height);
      convertDithering();
    } else {
      alert(`图片宽高比例与画布不匹配，将进入裁剪模式。\n请放大图片后移动图片使其充满画布, 再点击"完成"按钮。`);
      paintManager.setActiveTool(null, '');
      cropManager.initializeCrop();
    }
  };
  image.src = URL.createObjectURL(imageFile.files[0]);
}

function updateCanvasSize() {
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

  if (colorMode) document.getElementById('ditherMode').value = colorMode;
  if (canvasSize) document.getElementById('canvasSize').value = canvasSize;

  updateCanvasSize(); // always update image
}

function rotateCanvas() {
  const currentWidth = canvas.width;
  const currentHeight = canvas.height;

  // Capture current canvas content
  const imageData = ctx.getImageData(0, 0, currentWidth, currentHeight);

  // Swap canvas dimensions
  canvas.width = currentHeight;
  canvas.height = currentWidth;

  // Create temporary canvas for rotation
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = currentWidth;
  tempCanvas.height = currentHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.putImageData(imageData, 0, 0);

  // Draw rotated image on the resized canvas
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(90 * Math.PI / 180);
  ctx.drawImage(tempCanvas, -currentWidth / 2, -currentHeight / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform

  paintManager.clearHistory(); // Clear history as canvas size changed
  paintManager.clearElements(); // Clear stored text positions and line segments
  paintManager.saveToHistory(); // Save rotated canvas to history
}

function clearCanvas() {
  if (confirm('清除画布内容?')) {
    fillCanvas('white');
    paintManager.clearElements(); // Clear stored text positions and line segments
    if (cropManager.isCropMode()) cropManager.exitCropMode();
    paintManager.saveToHistory(); // Save cleared canvas to history
    return true;
  }
  return false;
}

function convertDithering() {
  paintManager.redrawTextElements();
  paintManager.redrawLineSegments();

  const contrast = parseFloat(document.getElementById('ditherContrast').value);
  const currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const imageData = new ImageData(
    new Uint8ClampedArray(currentImageData.data),
    currentImageData.width,
    currentImageData.height
  );

  adjustContrast(imageData, contrast);

  const alg = document.getElementById('ditherAlg').value;
  const strength = parseFloat(document.getElementById('ditherStrength').value);
  const mode = document.getElementById('ditherMode').value;
  const processedData = processImageData(ditherImage(imageData, alg, strength, mode), mode);
  const finalImageData = decodeProcessedData(processedData, canvas.width, canvas.height, mode);
  ctx.putImageData(finalImageData, 0, 0);

  paintManager.saveToHistory(); // Save dithered image to history
}

function applyDither() {
  cropManager.finishCrop(() => convertDithering());
}

function initEventHandlers() {
  document.getElementById("ditherStrength").addEventListener("input", (e) => {
    document.getElementById("ditherStrengthValue").innerText = parseFloat(e.target.value).toFixed(1);
    applyDither();
  });
  document.getElementById("ditherContrast").addEventListener("input", (e) => {
    document.getElementById("ditherContrastValue").innerText = parseFloat(e.target.value).toFixed(1);
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
    addLog("注意：开发模式功能已开启！不懂请不要随意修改，否则后果自负！");
  } else {
    document.body.classList.remove('dark-mode');
    link.innerHTML = '开发模式';
    link.setAttribute('href', window.location.pathname + '?debug=true');
  }
}

// 待办显示相关函数
let todoList = []; // 存储待办列表
let currentTodoMode = 'single'; // 当前模式: single 或 list

// 切换待办显示模式
function toggleTodoMode() {
  const mode = document.getElementById('todo-mode').value;
  currentTodoMode = mode;

  const singlePanel = document.getElementById('single-todo-panel');
  const listPanel = document.getElementById('list-todo-panel');

  if (mode === 'single') {
    singlePanel.style.display = 'block';
    listPanel.style.display = 'none';
  } else {
    singlePanel.style.display = 'none';
    listPanel.style.display = 'block';
    // 切换到列表模式时，自动渲染一次预览
    renderTodoList();
  }

  addLog(`切换到${mode === 'single' ? '单个待办' : '待办列表'}模式`);
}

// 文字换行处理函数
function wrapText(text, maxWidth, fontSize) {
  const lines = [];
  let currentLine = '';

  // 设置字体以便正确测量宽度
  ctx.font = `${fontSize}px sans-serif`;

  for (let i = 0; i < text.length; i++) {
    const testLine = currentLine + text[i];
    const metrics = ctx.measureText(testLine);

    if (metrics.width > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = text[i];
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

// 单个待办模式渲染
function renderSingleTodo() {
  const date = document.getElementById('todo-date').value;
  const time = document.getElementById('todo-time').value;
  const title = document.getElementById('todo-title').value.trim();
  const content = document.getElementById('todo-content').value.trim();
  const priority = parseInt(document.getElementById('todo-priority').value);

  if (!title) {
    alert('请输入待办标题！');
    return;
  }

  // 获取用户设置的字体大小
  const titleSizeSetting = document.getElementById('todo-title-size').value;
  const contentSizeSetting = document.getElementById('todo-content-size').value;
  const dateSizeSetting = document.getElementById('todo-date-size').value;

  // 获取当前画布尺寸
  const w = canvas.width;
  const h = canvas.height;

  // 清空画布为白色背景
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  // 根据优先级选择颜色
  let titleColor, borderColor;
  switch (priority) {
    case 1: // 高优先级 - 红色
      titleColor = '#E53935'; // 深红
      borderColor = '#FF0000';
      break;
    case 2: // 中优先级 - 黑色
    default: // 低优先级 - 灰色
      titleColor = '#000000';
      borderColor = '#000000';
  }

  // 绘制边框
  ctx.strokeStyle = titleColor;
  ctx.lineWidth = Math.max(2, Math.floor(w / 200));
  ctx.strokeRect(10, 10, w - 20, h - 20);

  // 绘制内框
  ctx.lineWidth = 1;
  ctx.strokeRect(15, 15, w - 30, h - 30);

  // 绘制日期时间 - 确保设置fillStyle
  ctx.fillStyle = titleColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  let dateTimeText = '';
  if (date) {
    const dateObj = new Date(date);
    dateTimeText = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;
  }
  if (time) {
    if (dateTimeText) dateTimeText += ' ';
    dateTimeText += time;
  }

  // 日期时间字体大小
  const dateTimeSize = dateSizeSetting === 'auto' ? Math.floor(h / 12) : parseInt(dateSizeSetting);
  ctx.font = `bold ${dateTimeSize}px sans-serif`;
  ctx.fillText(dateTimeText, 25, 25);

  //  绘制标题
  const titleSize = titleSizeSetting === 'auto' ? Math.floor(h / 6) : parseInt(titleSizeSetting);
  ctx.font = `bold ${titleSize}px sans-serif`;
  ctx.fillStyle = titleColor;  // 确保设置文字颜色

  // 标题换行处理
  const maxWidth = w - 50;
  const titleLines = wrapText(title, maxWidth, titleSize);
  const lineHeight = titleSize * 1.3;
  let yPos = 25 + dateTimeSize + 20;

  titleLines.forEach(line => {
    ctx.fillStyle = titleColor;  // 每次绘制前都设置颜色
    ctx.fillText(line, 25, yPos);
    yPos += lineHeight;
  });

  // 绘制内容
  if (content) {
    const contentSize = contentSizeSetting === 'auto' ? Math.floor(h / 8) : parseInt(contentSizeSetting);
    ctx.font = `${contentSize}px sans-serif`;
    const contentLines = wrapText(content, maxWidth, contentSize);
    const contentLineHeight = contentSize * 1.4;

    yPos += 15; // 与标题间距

    contentLines.forEach(line => {
      ctx.fillStyle = titleColor;  // 每次绘制前都设置颜色
      ctx.fillText(line, 25, yPos);
      yPos += contentLineHeight;
    });
  }

  // 绘制优先级标记（右下角）
  const prioritySize = Math.floor(w / 30);
  ctx.font = `${prioritySize}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';

  let priorityText = '';
  switch (priority) {
    case 1: priorityText = '高优先级'; break;
    case 2: priorityText = '中优先级'; break;
    case 3: priorityText = '低优先级'; break;
  }
  ctx.fillText(priorityText, w - 15, h - 15);

  addLog('单个待办内容已渲染到画布，请点击"发送图片"发送到墨水屏。');
  setCanvasTitle('单个待办预览');
}

// 待办列表模式渲染
function renderTodoList() {
  const listTitle = document.getElementById('todo-list-title').value.trim() || '待办清单';
  const date = document.getElementById('todo-date').value;

  // 获取当前画布尺寸
  const w = canvas.width;
  const h = canvas.height;

  // 清空画布为白色背景
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  // 绘制边框
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, w - 16, h - 16);

  // 绘制内框
  ctx.lineWidth = 1;
  ctx.strokeRect(12, 12, w - 24, h - 24);

  // 绘制列表标题
  ctx.fillStyle = '#000000';  // 确保设置文字颜色
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const titleSize = Math.floor(h / 10);
  ctx.font = `bold ${titleSize}px sans-serif`;
  ctx.fillText(listTitle, Math.floor(w / 2), 20);

  // 绘制日期
  const dateSize = Math.floor(h / 14);  // 移到外面，确保后续可以访问
  if (date) {
    const dateObj = new Date(date);
    const dateText = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;
    ctx.font = `${dateSize}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(dateText, 20, 20 + titleSize + 10);
  }

  // 绘制待办列表
  if (todoList.length === 0) {
    ctx.font = `${Math.floor(h / 16)}px sans-serif`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.fillText('暂无待办事项', Math.floor(w / 2), Math.floor(h / 2));
    
  } else {
    const itemFontSize = Math.floor(h / 18);
    const itemX = 25;
    let itemY = 20 + titleSize + (date ? dateSize + 10 : 10);
    todoList.forEach((item, index) => {
      // 绘制复选框
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      const boxSize = itemFontSize - 2;
      ctx.strokeRect(itemX, itemY, boxSize, boxSize);

      // 如果已完成，填充复选框
      if (item.done) {
        ctx.fillStyle = '#E53935';  // 红色填充
        ctx.fillRect(itemX + 2, itemY + 2, boxSize - 4, boxSize - 4);
      }

      // 绘制序号
      ctx.font = `${Math.floor(itemFontSize * 0.8)}px sans-serif`;
      ctx.fillStyle = item.done ? '#E53935' : '#000000';  // 完成后序号变红色
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const numberText = `${index + 1}.`;
      const numberX = itemX + boxSize + 5;
      ctx.fillText(numberText, numberX, itemY + Math.floor(boxSize / 2));

      // 测量序号宽度
      const numberWidth = ctx.measureText(numberText).width;

      // 绘制待办文字（在序号后面）
      ctx.font = `${itemFontSize}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const textX = numberX + numberWidth + 5;  // 序号X + 序号宽度 + 间距
      const textMaxWidth = w - textX - 10;
      const itemText = item.text.length > 25 ? item.text.substring(0, 25) + '...' : item.text;
      const textY = itemY + Math.floor(boxSize / 2);

      // 绘制文字
      ctx.fillStyle = item.done ? '#E53935' : '#000000';  // 完成后文字变红色
      ctx.fillText(itemText, textX, textY);

      // 如果已完成，绘制删除线（红色）
      if (item.done) {
        const textMetrics = ctx.measureText(itemText);
        ctx.strokeStyle = '#E53935';  // 红色删除线
        ctx.lineWidth = 2;  // 加粗删除线
        ctx.beginPath();
        ctx.moveTo(textX, textY);
        ctx.lineTo(textX + textMetrics.width, textY);
        ctx.stroke();
      }

      itemY += itemFontSize + 5;

      // 超出一页则停止绘制
      if (itemY > h - 30) {
        ctx.font = `${Math.floor(h / 20)}px sans-serif`;
        ctx.fillStyle = '#666666';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`...还有 ${todoList.length - index - 1} 项`, w - 10, h - 10);
        return;
      }
    });
  }

  addLog(`待办列表已渲染，共 ${todoList.length} 项，请点击"发送图片"发送到墨水屏。`);
  setCanvasTitle('待办列表预览');
}

// 添加待办事项到列表
function addTodoItem() {
  const input = document.getElementById('new-todo-item');
  const text = input.value.trim();

  if (!text) {
    alert('请输入待办内容！');
    return;
  }

  todoList.push({ text: text, done: false });
  input.value = ''; // 清空输入框

  updateTodoListDisplay();
  addLog(`已添加待办: ${text}`);
}

// 处理待办输入框回车事件
function handleTodoInputKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    addTodoItem();
  }
}

// 清空待办列表
function clearTodoList() {
  if (todoList.length === 0) {
    alert('列表已经是空的了！');
    return;
  }

  if (!confirm('确认清空所有待办事项？')) {
    return;
  }

  todoList = [];
  updateTodoListDisplay();
  addLog('待办列表已清空');
}

// 更新待办列表显示
function updateTodoListDisplay() {
  const display = document.getElementById('todo-list-display');
  const countSpan = document.getElementById('todo-count');

  countSpan.textContent = todoList.length;

  if (todoList.length === 0) {
    display.innerHTML = '<div class="todo-empty">暂无待办事项</div>';
  } else {
    let html = '<div class="todo-items-container">';
    todoList.forEach((item, index) => {
      html += `<div class="todo-item">`;
      html += `<span class="todo-number">${index + 1}.</span>`;
      html += `<span class="todo-text ${item.done ? 'todo-done' : ''}">${item.text}</span>`;
      html += `<button type="button" onclick="toggleTodoDone(${index})" class="todo-toggle-btn">${item.done ? '标记未完成' : '标记完成'}</button>`;
      html += `<button type="button" onclick="removeTodoItem(${index})" class="todo-delete-btn">删除</button>`;
      html += '</div>';
    });
    html += '</div>';
    display.innerHTML = html;
  }
}

// 切换待办事项完成状态
function toggleTodoDone(index) {
  if (index >= 0 && index < todoList.length) {
    todoList[index].done = !todoList[index].done;
    updateTodoListDisplay();
    addLog(`${todoList[index].done ? '已完成' : '未完成'}: ${todoList[index].text}`);
  }
}

// 删除待办事项
function removeTodoItem(index) {
  if (index >= 0 && index < todoList.length) {
    const removed = todoList.splice(index, 1)[0];
    updateTodoListDisplay();
    addLog(`已删除: ${removed.text}`);
  }
}

// 预览功能（根据当前模式）
function previewTodo() {
  if (currentTodoMode === 'single') {
    renderSingleTodo();
  } else {
    renderTodoList();
  }
}

// 发送功能（根据当前模式）
async function sendTodo() {
  if (currentTodoMode === 'single') {
    const title = document.getElementById('todo-title').value.trim();
    if (!title) {
      alert('请输入待办标题！');
      return;
    }

    renderSingleTodo();

    if (!confirm('单个待办内容已渲染，确认发送到墨水屏？')) {
      return;
    }

    convertDithering();
  } else {
    if (todoList.length === 0) {
      alert('请先添加待办事项！');
      return;
    }

    renderTodoList();

    if (!confirm('待办列表已渲染，共 ' + todoList.length + ' 项，确认发送到墨水屏？')) {
      return;
    }

    convertDithering();
  }
}

// 页面加载时初始化日期为今天和默认模式
document.addEventListener('DOMContentLoaded', () => {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  document.getElementById('todo-date').value = dateStr;

  // 默认选中单个待办模式
  toggleTodoMode();
});

document.body.onload = () => {
  textDecoder = null;
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext("2d");

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  paintManager = new PaintManager(canvas, ctx);
  cropManager = new CropManager(canvas, ctx, paintManager);

  paintManager.initPaintTools();
  cropManager.initCropTools();
  initEventHandlers();
  updateButtonStatus();
  checkDebugMode();
}

// 全局旋转函数（供HTML onclick调用）
function rotateImage(angle) {
  if (cropManager && cropManager.rotateImage) {
    cropManager.rotateImage(angle);
  }
}

function rotateImageCustom() {
  if (cropManager && cropManager.rotateImageCustom) {
    cropManager.rotateImageCustom();
  }
}

// ============ 动态存图 / 槽位管理（与 Flutter epd_service 协议一致） ============

// GET_SLOTS → 槽位总览。回包 'S'(0x53)+nb+header(34B)+bitmap(nb)
async function getSlots() {
  if (!epdCharacteristic) return null;
  const p = awaitNotify(0x53, 36, null);
  const ok = await write(EpdCmd.GET_SLOTS, null, true);
  if (!ok) { p.cancel(); return null; }
  try {
    const d = await p;
    const status = parseSlotsReply(d);
    slotsCache = status;
    addLog('📋 槽位总览: ' + status.slotCount + ' 槽, ' + status.validBitmap.filter(Boolean).length + ' 个有图');
    return status;
  } catch (e) {
    addLog('获取槽位总览失败: ' + e.message);
    return null;
  }
}

function parseSlotsReply(d) {
  const u16 = (o) => d[o] | (d[o + 1] << 8);
  const u32 = (o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);
  const slotCount = d[20];
  const validBitmap = [];
  for (let i = 0; i < slotCount; i++) {
    const byteK = d[36 + (i >> 3)];
    validBitmap.push((byteK & (1 << (i & 7))) !== 0);
  }
  return {
    slotCount, validBitmap,
    keyWidth: u16(6), keyHeight: u16(8), keyColor: d[10], keyIc: d[11],
    imageBytes: u32(12), slotSize: u32(16),
    rotationMode: d[22], rotationInterval: d[23], currentSlot: d[24],
    weekdayMap: Array.from(d.subarray(25, 32)),
  };
}

// GET_SLOT_INFO → 单槽详情（16B meta）。回包 'I'(0x49)+slot+16B
async function getSlotInfo(slot) {
  const p = awaitNotify(0x49, 18, slot);
  const ok = await write(EpdCmd.GET_SLOT_INFO, [slot], true);
  if (!ok) { p.cancel(); return null; }
  try {
    const d = await p;
    const m = d.subarray(2, 18);
    return {
      valid: m[0] === 0x01, color: m[1],
      width: m[2] | (m[3] << 8), height: m[4] | (m[5] << 8),
      dataLen: m[6] | (m[7] << 8) | (m[8] << 16) | (m[9] << 24),
    };
  } catch (e) {
    return null;
  }
}

async function deleteSlot(slot) {
  addLog('🗑️ 删除 slot ' + slot);
  return await write(EpdCmd.STORE_DELETE, [slot], true);
}

async function displaySlot(slot) {
  addLog('🖥️ 显示 slot ' + slot);
  return await write(EpdCmd.DISPLAY_SLOT, [slot], true);
}

// SET_REMARK：[0x49][slot][GBK字节≤64]
async function setRemark(slot, text) {
  let bytes = [];
  if (text && text.length > 0) {
    const enc = window.GBK.encode(text);
    if (enc.length > 64) {
      throw new Error('备注超过 64 字节（当前 ' + enc.length + '）');
    }
    bytes = Array.from(enc);
  }
  return await write(EpdCmd.SET_REMARK, [slot, ...bytes], true);
}

// GET_REMARK：[0x4A][slot] → 'R'(0x52)+slot+64B（GBK，去尾 0xFF）
async function getRemark(slot) {
  const p = awaitNotify(0x52, 66, slot);
  const ok = await write(EpdCmd.GET_REMARK, [slot], true);
  if (!ok) { p.cancel(); return ''; }
  try {
    const d = await p;
    return window.GBK.decode(d.subarray(2, 2 + 64));
  } catch (e) {
    return '';
  }
}

// 把当前 canvas 图像存入指定槽（含可选备注）
async function storeImageToSlot(slot, remarkText) {
  if (cropManager && cropManager.isCropMode && cropManager.isCropMode()) {
    alert('请先完成图片裁剪！');
    return false;
  }
  const ditherMode = document.getElementById('ditherMode').value;
  const canvasSize = document.getElementById('canvasSize').value;
  const sizeObj = canvasSizes.find((s) => s.name === canvasSize);
  if (!sizeObj) { alert('画布尺寸无效'); return false; }
  const width = sizeObj.width, height = sizeObj.height;
  const colorByte = colorModeToByte(ditherMode);

  startTime = new Date().getTime();
  document.getElementById('status').parentElement.style.display = 'block';
  setStatus('编码图像...');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processedData = processImageData(imageData, ditherMode);

  // 若该槽已占用，先删旧
  if (slotsCache && slot < slotsCache.slotCount && slotsCache.validBitmap[slot]) {
    setStatus('清理旧内容...');
    await deleteSlot(slot);
    await new Promise((r) => setTimeout(r, 200));
  }

  // 1. STORE_BEGIN [slot, wLo, wHi, hLo, hHi, colorByte]
  const begin = [slot, width & 0xFF, (width >> 8) & 0xFF, height & 0xFF, (height >> 8) & 0xFF, colorByte];
  setStatus('存储到 slot ' + slot + '...');
  if (!await write(EpdCmd.STORE_BEGIN, begin, true)) return false;
  await new Promise((r) => setTimeout(r, 800)); // 等 flash 擦除

  // 2. STORE_DATA 分片（chunk = mtu - 1，仅 cmd 1 字节开销；每 interleaved 片确认一次，末片确认）
  const mtu = parseInt(document.getElementById('mtusize').value) || 244;
  const chunkSize = Math.max(1, mtu - 1);
  const interleaved = parseInt(document.getElementById('interleavedcount').value) || 50;
  const total = Math.ceil(processedData.length / chunkSize);
  let noReply = interleaved;
  let idx = 0;
  for (let i = 0; i < processedData.length; i += chunkSize) {
    const chunk = processedData.subarray(i, Math.min(i + chunkSize, processedData.length));
    const isLast = i + chunkSize >= processedData.length;
    idx++;
    setStatus('数据块: ' + idx + '/' + total);
    if (noReply > 0 && !isLast) {
      await write(EpdCmd.STORE_DATA, chunk, false);
      noReply--;
    } else {
      await write(EpdCmd.STORE_DATA, chunk, true);
      noReply = interleaved;
    }
  }

  // 3. STORE_END
  if (!await write(EpdCmd.STORE_END, null, true)) return false;
  await new Promise((r) => setTimeout(r, 100));

  // 4. 备注
  if (remarkText != null && remarkText !== '') {
    try {
      await setRemark(slot, remarkText);
    } catch (e) {
      alert('备注写入失败: ' + e.message);
    }
  }

  addLog('✅ slot ' + slot + ' 存储完成');
  setStatus('');
  await refreshSlots();
  return true;
}

// 刷新槽位列表 UI（getSlots + 逐槽备注，顺序读取避免等待器并发）
async function refreshSlots() {
  if (!epdCharacteristic) return;
  const status = await getSlots();
  const container = document.getElementById('slotsList');
  if (!container) return;
  if (!status) {
    container.innerHTML = '<div style="color:#666">未获取到槽位（设备可能不支持动态存图）</div>';
    return;
  }
  let html = '<div style="margin:6px 0;color:#666;font-size:13px">共 ' + status.slotCount +
    ' 槽，当前显示槽 ' + status.currentSlot + '；画布 ' + status.keyWidth + '×' + status.keyHeight + '</div>';
  for (let s = 0; s < status.slotCount; s++) {
    const valid = status.validBitmap[s];
    const cur = s === status.currentSlot;
    html += '<div class="slot-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:4px 0;border-bottom:1px solid #eee">' +
      '<span style="min-width:52px;font-weight:bold">槽 ' + s + (cur ? ' *' : '') + '</span>' +
      '<span style="min-width:50px;color:' + (valid ? 'green' : '#999') + '">' + (valid ? '有图' : '空') + '</span>' +
      '<span id="slotRemark_' + s + '" style="flex:1;color:#444;min-width:60px">' + (valid ? '…' : '') + '</span>' +
      '<button class="primary" style="font-size:12px" onclick="storeSlotPrompt(' + s + ')">存入</button>' +
      '<button class="secondary" style="font-size:12px" onclick="displaySlot(' + s + ').then(refreshSlots)">显示</button>' +
      '<button class="secondary" style="font-size:12px" onclick="deleteSlot(' + s + ').then(refreshSlots)">删除</button>' +
      '</div>';
  }
  container.innerHTML = html;
  for (let s = 0; s < status.slotCount; s++) {
    if (!status.validBitmap[s]) continue;
    const rm = await getRemark(s);
    const el = document.getElementById('slotRemark_' + s);
    if (el) el.textContent = rm || '(无备注)';
  }
}

// 「存入」按钮：弹备注输入 → storeImageToSlot
async function storeSlotPrompt(slot) {
  const remark = prompt('存入当前画布到槽 ' + slot + '。\n可选备注（中文按 GBK，≤64 字节）：', '');
  if (remark === null) return;
  if (remark && window.GBK && window.GBK.byteLength(remark) > 64) {
    alert('备注超过 64 字节（当前 ' + window.GBK.byteLength(remark) + '），请缩短');
    return;
  }
  await storeImageToSlot(slot, remark);
}