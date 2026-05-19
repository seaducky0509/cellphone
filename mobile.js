const videoEl = document.querySelector("#camera");
const previewEl = document.querySelector("#preview");
const overlayEl = document.querySelector("#overlay");
const captureEl = document.querySelector("#capture");
const startButton = document.querySelector("#start");
const toggleButton = document.querySelector("#toggle");
const landingView = document.querySelector("#landing-view");
const appShells = document.querySelectorAll(".app-shell");
const enterHostButton = document.querySelector("#enter-host");
const enterViewerButton = document.querySelector("#enter-viewer");
const backendInput = document.querySelector("#backend-url");
const saveUrlButton = document.querySelector("#save-url");
const reloadConfigButton = document.querySelector("#reload-config");
const stateEl = document.querySelector("#state");
const dotEl = document.querySelector("#dot");
const latestPlateEl = document.querySelector("#latest-plate");
const alertEl = document.querySelector("#alert");
const alertPlateEl = document.querySelector("#alert-plate");
const plateListEl = document.querySelector("#plate-list");
const elapsedEl = document.querySelector("#elapsed");
const mqttEl = document.querySelector("#mqtt");
const messageEl = document.querySelector("#message");
const viewSizeEl = document.querySelector("#view-size");
const viewSizeLabelEl = document.querySelector("#view-size-label");
const tabButtons = document.querySelectorAll(".tab");
const views = document.querySelectorAll(".view");
const adminTokenEl = document.querySelector("#admin-token");
const confirmAdminTokenButton = document.querySelector("#confirm-admin-token");
const oldAdminTokenEl = document.querySelector("#old-admin-token");
const newAdminTokenEl = document.querySelector("#new-admin-token");
const confirmNewAdminTokenEl = document.querySelector("#confirm-new-admin-token");
const passwordChangeFormEl = document.querySelector("#password-change-form");
const adminPlateEl = document.querySelector("#admin-plate");
const adminOwnerEl = document.querySelector("#admin-owner");
const adminNoteEl = document.querySelector("#admin-note");
const adminStateEl = document.querySelector("#admin-state");
const adminDotEl = document.querySelector("#admin-dot");
const adminMessageEl = document.querySelector("#admin-message");
const authorizedListEl = document.querySelector("#authorized-list");
const unauthorizedListEl = document.querySelector("#unauthorized-list");
const loadAuthorizedButton = document.querySelector("#load-authorized");
const downloadAuthorizedButton = document.querySelector("#download-authorized");
const previewEventsButton = document.querySelector("#preview-events");
const downloadEventsButton = document.querySelector("#download-events");
const clearEventsButton = document.querySelector("#clear-events");
const plateFormEl = document.querySelector("#plate-form");

let stream = null;
let running = false;
let requestBusy = false;
let liveFrameBusy = false;
let timer = 0;
let backendUrl = "";
let requestSeq = 0;
let latestDrawnSeq = 0;
let lastMotionSample = null;
let lastMotionCheck = 0;
let lastMotionAt = 0;
let lastDetectionAt = 0;
let overlayHasBoxes = false;
let mobileMode = localStorage.getItem("plateMobileMode") || "host";
let appEntered = false;
let lastCommandId = 0;
let commandTimer = 0;
let viewerTimer = 0;
let warmupStarted = false;
let lastLiveFrameAt = 0;

const captureWidth = 480;
const recognizeIntervalMs = 60;
const liveFrameIntervalMs = 250;
const requestTimeoutMs = 3000;
const motionClearThreshold = 45;
const motionCanvas = document.createElement("canvas");
motionCanvas.width = 48;
motionCanvas.height = 27;

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function setState(text, level = "") {
  stateEl.textContent = text;
  dotEl.className = `dot ${level}`.trim();
}

function setAdminState(text, level = "") {
  adminStateEl.textContent = text;
  adminStateEl.className = `status-text ${level}`.trim();
  adminDotEl.className = `dot ${level}`.trim();
}

function adminToken() {
  return adminTokenEl.value.trim();
}

function adminHeaders() {
  return { "X-Admin-Token": adminToken() };
}

async function ensureBackendUrlForAdmin() {
  if (!backendUrl) {
    await loadBackendConfig();
  }
  if (!backendUrl) {
    throw new Error("尚未取得後端網址，請先更新 tunnel 設定。");
  }
}

function switchTab(name) {
  tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  views.forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  if (name === "admin") {
    window.setTimeout(() => adminTokenEl.focus(), 0);
  } else {
    window.setTimeout(resizeOverlay, 0);
  }
}

function setViewerSize(value) {
  const size = Math.max(360, Math.min(1100, Number(value) || 760));
  document.documentElement.style.setProperty("--viewer-width", `${size}px`);
  viewSizeEl.value = String(size);
  viewSizeLabelEl.textContent = `${size}px`;
  localStorage.setItem("plateViewerWidth", String(size));
  window.setTimeout(resizeOverlay, 0);
}

async function loadBackendConfig() {
  try {
    const response = await fetch(`./backend-config.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`讀取設定失敗：HTTP ${response.status}`);
    }
    const config = await response.json();
    const configuredUrl = normalizeUrl(config.backendUrl);
    const savedUrl = normalizeUrl(localStorage.getItem("plateBackendUrl"));
    backendUrl = configuredUrl || savedUrl;
    if (configuredUrl) {
      localStorage.setItem("plateBackendUrl", configuredUrl);
    }
    backendInput.value = backendUrl;
    if (backendUrl) {
      setState("後端已設定", "ok");
      messageEl.textContent = config.updatedAt ? `設定更新時間：${config.updatedAt}` : "後端網址已讀取";
      warmupBackend();
    } else {
      setState("尚未設定後端", "warn");
      messageEl.textContent = "請先在電腦端啟動 tunnel。";
    }
  } catch (error) {
    setState("設定讀取失敗", "warn");
    messageEl.textContent = error.message;
  }
}

async function assertBackendReady() {
  await loadBackendConfig();
  if (!backendUrl) {
    throw new Error("尚未取得後端網址，請先在電腦端執行 tunnel 更新腳本。");
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${backendUrl}/api/status?t=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(`後端連線失敗：${error.message}`);
  } finally {
    window.clearTimeout(timeout);
  }
}

function warmupBackend() {
  if (warmupStarted || !backendUrl) {
    return;
  }
  warmupStarted = true;
  fetch(`${backendUrl}/api/mobile-warmup`, {
    method: "POST",
    cache: "no-store",
    keepalive: true,
  }).catch(() => {
    warmupStarted = false;
  });
}

function saveBackendUrl() {
  backendUrl = normalizeUrl(backendInput.value);
  localStorage.setItem("plateBackendUrl", backendUrl);
  setState(backendUrl ? "後端網址已儲存" : "尚未設定後端", backendUrl ? "ok" : "warn");
}

function setMobileMode(mode) {
  mobileMode = mode === "viewer" ? "viewer" : "host";
  localStorage.setItem("plateMobileMode", mobileMode);
  window.clearTimeout(commandTimer);
  window.clearTimeout(viewerTimer);
  if (!appEntered) {
    return;
  }
  if (mobileMode === "viewer") {
    closeCamera();
    startButton.textContent = "遠端開啟鏡頭";
    toggleButton.textContent = "遠端開始辨識";
    toggleButton.disabled = false;
    setState("手機觀看端", "info");
    messageEl.textContent = "觀看 A 手機主機端畫面，可遠端控制鏡頭與辨識。";
    pollViewerState();
  } else {
    startButton.textContent = stream ? "關閉鏡頭" : "開啟鏡頭";
    toggleButton.textContent = running ? "停止辨識" : "開始辨識";
    toggleButton.disabled = !stream;
    setState("手機主機端", "info");
    messageEl.textContent = "此手機會開啟鏡頭並傳送畫面給後端辨識。";
    warmupBackend();
    startHostCommandPolling();
  }
}

function enterApp(mode) {
  appEntered = true;
  landingView.classList.add("hidden");
  appShells.forEach((element) => element.classList.remove("hidden"));
  switchTab("recognition");
  setMobileMode(mode);
}

async function startHostCommandPolling() {
  try {
    if (!backendUrl) {
      await loadBackendConfig();
    }
    if (backendUrl) {
      const response = await fetch(
        `${backendUrl}/api/mobile-command?last_id=999999999&camera_open=${stream ? "true" : "false"}&recognition_running=${running ? "true" : "false"}&t=${Date.now()}`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const data = await response.json();
        lastCommandId = Number(data.command_id || 0);
      }
    }
  } catch (error) {
    messageEl.textContent = `遠端命令同步失敗：${error.message}`;
  } finally {
    pollHostCommand();
  }
}

async function sendMobileControl(command) {
  await assertBackendReady();
  const response = await fetch(`${backendUrl}/api/mobile-control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`遠端控制失敗：HTTP ${response.status}`);
  }
  return response.json();
}

async function pollHostCommand() {
  if (mobileMode !== "host") {
    return;
  }
  try {
    if (backendUrl) {
      const response = await fetch(
        `${backendUrl}/api/mobile-command?last_id=${lastCommandId}&camera_open=${stream ? "true" : "false"}&recognition_running=${running ? "true" : "false"}&t=${Date.now()}`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const data = await response.json();
        if (data.command_id) {
          lastCommandId = Number(data.command_id);
        }
        if (data.command) {
          await applyHostCommand(data.command);
        }
      }
    }
  } catch (error) {
    messageEl.textContent = `遠端命令讀取失敗：${error.message}`;
  } finally {
    commandTimer = window.setTimeout(pollHostCommand, 250);
  }
}

async function applyHostCommand(command) {
  if (command === "open_camera") {
    await openCamera();
  } else if (command === "close_camera") {
    closeCamera();
  } else if (command === "start_recognition") {
    if (!stream) {
      await openCamera();
    }
    if (!running) {
      await toggleRecognition();
    }
  } else if (command === "stop_recognition" && running) {
    await toggleRecognition();
  }
}

async function pollViewerState() {
  if (mobileMode !== "viewer") {
    return;
  }
  try {
    if (!backendUrl) {
      await loadBackendConfig();
    }
    if (backendUrl) {
      const response = await fetch(`${backendUrl}/api/mobile-live-state?t=${Date.now()}`, { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        await renderViewerState(data);
      }
    }
  } catch (error) {
    setState("觀看端連線錯誤", "warn");
    messageEl.textContent = error.message;
  } finally {
    viewerTimer = window.setTimeout(pollViewerState, 350);
  }
}

async function renderViewerState(data) {
  const result = data.result || { plates: [], width: 0, height: 0 };
  const host = data.host || {};
  startButton.textContent = host.camera_open ? "遠端關閉鏡頭" : "遠端開啟鏡頭";
  toggleButton.textContent = host.recognition_running ? "遠端停止辨識" : "遠端開始辨識";
  toggleButton.disabled = false;
  if (!host.camera_open) {
    clearViewerFrame();
    updatePanel({ ok: true, plates: [], message: "手機主機端鏡頭已關閉" });
    setState("等待手機主機端", "info");
    messageEl.textContent = "A 手機主機端鏡頭已關閉。";
    return;
  }
  if (data.frame_available && data.frame_url) {
    await drawViewerFrame(`${backendUrl}${data.frame_url}`);
    drawResults(result, { width: result.width, height: result.height });
    updatePanel(result);
  } else {
    clearViewerFrame();
    setState("等待手機主機端", "info");
    messageEl.textContent = "A 手機主機端尚未傳送畫面。";
  }
}

function clearViewerFrame() {
  clearOverlay();
  clearAlertForNewScan();
  const context = previewEl.getContext("2d", { willReadFrequently: false });
  context.clearRect(0, 0, previewEl.width, previewEl.height);
  latestPlateEl.textContent = "--";
  plateListEl.innerHTML = "";
}

function drawViewerFrame(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      resizeOverlay();
      const context = previewEl.getContext("2d", { willReadFrequently: false });
      context.clearRect(0, 0, previewEl.width, previewEl.height);
      context.drawImage(image, 0, 0, previewEl.width, previewEl.height);
      resolve();
    };
    image.onerror = () => resolve();
    image.src = url;
  });
}

async function openCamera() {
  if (stream) {
    return;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      aspectRatio: { ideal: 1.7777778 },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  startButton.textContent = "關閉鏡頭";
  toggleButton.disabled = false;
  setState("鏡頭已開啟", "ok");
  messageEl.textContent = "請按開始辨識。";
  resizeOverlay();
  requestAnimationFrame(renderPreview);
}

function closeCamera() {
  if (!stream) {
    return;
  }
  running = false;
  window.clearTimeout(timer);
  for (const track of stream.getTracks()) {
    track.stop();
  }
  stream = null;
  videoEl.srcObject = null;
  startButton.textContent = "開啟鏡頭";
  toggleButton.textContent = "開始辨識";
  toggleButton.disabled = true;
  clearOverlay();
  clearAlertForNewScan();
  const previewContext = previewEl.getContext("2d");
  previewContext.clearRect(0, 0, previewEl.width, previewEl.height);
  setState("鏡頭已關閉", "");
  messageEl.textContent = "請先開啟鏡頭。";
}

function resizeOverlay() {
  const rect = previewEl.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
  const height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
  previewEl.width = width;
  previewEl.height = height;
  overlayEl.width = width;
  overlayEl.height = height;
  clearOverlay();
}

function resizeOverlayOnly() {
  const rect = previewEl.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
  const height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
  if (overlayEl.width !== width) {
    overlayEl.width = width;
  }
  if (overlayEl.height !== height) {
    overlayEl.height = height;
  }
  clearOverlay();
}

function clearOverlay() {
  const context = overlayEl.getContext("2d");
  context.clearRect(0, 0, overlayEl.width, overlayEl.height);
  overlayHasBoxes = false;
}

function clearAlertForNewScan() {
  document.body.classList.remove("alerting");
  alertEl.classList.remove("show");
  alertPlateEl.textContent = "--";
}

function sourceCoverRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = targetWidth / scale;
  const height = targetHeight / scale;
  const x = (sourceWidth - width) / 2;
  const y = (sourceHeight - height) / 2;
  return { x, y, width, height };
}

function renderPreview() {
  if (!stream || mobileMode !== "host") {
    return;
  }
  const sourceWidth = videoEl.videoWidth || 1280;
  const sourceHeight = videoEl.videoHeight || 720;
  if (previewEl.width && previewEl.height && sourceWidth && sourceHeight) {
    const rect = sourceCoverRect(sourceWidth, sourceHeight, previewEl.width, previewEl.height);
    const context = previewEl.getContext("2d", { willReadFrequently: false });
    context.drawImage(
      videoEl,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      previewEl.width,
      previewEl.height,
    );
    detectMotion();
    if (!running) {
      uploadLiveFrame();
    }
  }
  requestAnimationFrame(renderPreview);
}

function detectMotion() {
  const now = performance.now();
  if (!running || now - lastMotionCheck < 180 || !previewEl.width || !previewEl.height) {
    return;
  }
  lastMotionCheck = now;
  const context = motionCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(previewEl, 0, 0, motionCanvas.width, motionCanvas.height);
  const current = context.getImageData(0, 0, motionCanvas.width, motionCanvas.height).data;
  if (!lastMotionSample) {
    lastMotionSample = new Uint8ClampedArray(current);
    return;
  }
  let diff = 0;
  for (let index = 0; index < current.length; index += 4) {
    diff +=
      Math.abs(current[index] - lastMotionSample[index]) +
      Math.abs(current[index + 1] - lastMotionSample[index + 1]) +
      Math.abs(current[index + 2] - lastMotionSample[index + 2]);
  }
  const averageDiff = diff / (motionCanvas.width * motionCanvas.height * 3);
  lastMotionSample = new Uint8ClampedArray(current);
  if (averageDiff > motionClearThreshold) {
    lastMotionAt = now;
    lastDetectionAt = 0;
    clearOverlay();
    clearAlertForNewScan();
    setState("辨識車牌中", "ok");
    messageEl.textContent = "畫面已移動，正在辨識新車牌。";
  }
}

function captureFrame() {
  const previewWidth = previewEl.width || 1280;
  const previewHeight = previewEl.height || 720;
  const width = Math.min(captureWidth, previewWidth);
  const height = Math.round((previewHeight / previewWidth) * width);
  captureEl.width = width;
  captureEl.height = height;
  const context = captureEl.getContext("2d", { willReadFrequently: false });
  context.drawImage(previewEl, 0, 0, width, height);
  return new Promise((resolve) =>
    captureEl.toBlob(
      (blob) =>
        resolve({
          blob,
          width,
          height,
          capturedAt: performance.now(),
        }),
      "image/jpeg",
      0.62,
    ),
  );
}

async function uploadLiveFrame() {
  const now = performance.now();
  if (!backendUrl || liveFrameBusy || requestBusy || now - lastLiveFrameAt < liveFrameIntervalMs) {
    return;
  }
  liveFrameBusy = true;
  lastLiveFrameAt = now;
  try {
    const capture = await captureFrame();
    await fetch(`${backendUrl}/api/mobile-frame`, {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Frame-Id": `live-${Date.now()}`,
        "X-Frame-Width": String(capture.width),
        "X-Frame-Height": String(capture.height),
      },
      body: capture.blob,
      cache: "no-store",
    });
  } catch (error) {
    // Live preview upload is best-effort; recognition errors are reported separately.
  } finally {
    liveFrameBusy = false;
  }
}

function drawResults(result, captureMeta) {
  if (captureMeta && (result.width !== captureMeta.width || result.height !== captureMeta.height)) {
    clearOverlay();
    return;
  }
  resizeOverlayOnly();
  const context = overlayEl.getContext("2d");
  const sourceWidth = Math.max(1, result.width || captureEl.width);
  const sourceHeight = Math.max(1, result.height || captureEl.height);
  const scaleX = overlayEl.width / sourceWidth;
  const scaleY = overlayEl.height / sourceHeight;
  context.lineWidth = 4 * window.devicePixelRatio;
  context.font = `${18 * window.devicePixelRatio}px "Segoe UI", sans-serif`;
  context.textBaseline = "top";

  for (const item of result.plates || []) {
    const box = item.box || {};
    const x = box.x1 * scaleX;
    const y = box.y1 * scaleY;
    const w = (box.x2 - box.x1) * scaleX;
    const h = (box.y2 - box.y1) * scaleY;
    const danger = item.status === "unauthorized";
    context.strokeStyle = danger ? "#dc2626" : "#16a34a";
    context.fillStyle = danger ? "#dc2626" : "#16a34a";
    context.strokeRect(x, y, w, h);
    const label = `${item.plate} ${danger ? "未登錄" : "已登錄"} ${Number(item.confidence || 0).toFixed(2)}`;
    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(0, y - 28 * window.devicePixelRatio);
    context.fillRect(x, labelY, labelWidth, 26 * window.devicePixelRatio);
    context.fillStyle = "#111827";
    context.fillText(label, x + 6, labelY + 3);
  }
  overlayHasBoxes = (result.plates || []).length > 0;
}

function updatePanel(result) {
  const plates = Array.isArray(result.plates) ? result.plates : [];
  const unauthorized = plates.filter((item) => item.status === "unauthorized");
  const latest = plates.map((item) => item.plate).join(", ");
  latestPlateEl.textContent = latest || "--";
  elapsedEl.textContent = result.elapsed ? `${Number(result.elapsed).toFixed(3)} 秒` : "--";
  mqttEl.textContent = result.mqtt_last_sent === "sent" ? "已送出" : result.mqtt_last_sent === "skipped" ? "未送出" : "--";
  messageEl.textContent = result.message || "--";
  document.body.classList.toggle("alerting", unauthorized.length > 0);
  alertEl.classList.toggle("show", unauthorized.length > 0);
  alertPlateEl.textContent = unauthorized.map((item) => item.plate).join(", ") || "--";
  plateListEl.innerHTML = plates
    .map((item) => {
      const danger = item.status === "unauthorized";
      const label = danger ? "未登錄" : "已登錄";
      return `<div class="chip ${danger ? "danger" : "allowed"}"><span>${item.plate}</span><small>${label} ${Number(item.confidence || 0).toFixed(3)}</small></div>`;
    })
    .join("");
  setState(unauthorized.length ? "偵測到未登錄車牌" : running ? "辨識車牌中" : "已停止", unauthorized.length ? "warn" : "ok");
}

async function recognizeOnce() {
  if (!running || !backendUrl || requestBusy) {
    return;
  }
  requestBusy = true;
  const seq = ++requestSeq;
  try {
    if (!overlayHasBoxes) {
      clearAlertForNewScan();
      setState("辨識車牌中", "ok");
      messageEl.textContent = "正在辨識新畫面...";
    }
    const capture = await captureFrame();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);
    const response = await fetch(`${backendUrl}/api/mobile-recognize`, {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Frame-Id": String(seq),
      },
      body: capture.blob,
      cache: "no-store",
      signal: controller.signal,
    });
    window.clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`後端回應 ${response.status}`);
    }
    const result = await response.json();
    if (result.request_id && result.request_id !== String(seq)) {
      return;
    }
    if (seq < latestDrawnSeq || seq !== requestSeq) {
      return;
    }
    if (lastMotionAt > capture.capturedAt) {
      return;
    }
    latestDrawnSeq = seq;
    const plates = Array.isArray(result.plates) ? result.plates : [];
    if (plates.length > 0) {
      lastDetectionAt = performance.now();
      drawResults(result, capture);
      updatePanel(result);
    } else if (overlayHasBoxes && performance.now() - lastDetectionAt < 2500) {
      messageEl.textContent = "持續追蹤目前車牌...";
    } else {
      drawResults(result, capture);
      updatePanel(result);
    }
  } catch (error) {
    if (!overlayHasBoxes) {
      clearOverlay();
      clearAlertForNewScan();
      setState("辨識車牌中", "ok");
      messageEl.textContent = error.name === "AbortError" ? "本次辨識超過 3 秒，已送出下一張畫面。" : error.message;
    } else {
      messageEl.textContent = error.name === "AbortError" ? "持續追蹤目前車牌，本次辨識逾時。" : error.message;
    }
  } finally {
    requestBusy = false;
    if (running) {
      window.clearTimeout(timer);
      timer = window.setTimeout(recognizeOnce, recognizeIntervalMs);
    }
  }
}

async function toggleRecognition() {
  if (!running) {
    try {
      setState("檢查後端連線", "warn");
      messageEl.textContent = "正在重新讀取最新後端設定...";
      await assertBackendReady();
    } catch (error) {
      running = false;
      clearOverlay();
      setState("連線錯誤", "warn");
      messageEl.textContent = error.message;
      return;
    }
  }
  running = !running;
  toggleButton.textContent = running ? "停止辨識" : "開始辨識";
  setState(running ? "辨識車牌中" : "已停止", running ? "ok" : "");
  if (running) {
    lastMotionSample = null;
    window.setTimeout(recognizeOnce, 0);
  } else {
    window.clearTimeout(timer);
    clearOverlay();
    clearAlertForNewScan();
  }
}

function renderAuthorizedList(items) {
  if (!items.length) {
    authorizedListEl.innerHTML = `<div class="admin-message">目前沒有登錄車牌。</div>`;
    return;
  }
  authorizedListEl.innerHTML = items
    .map(
      (item) => `
        <div class="authorized-item">
          <strong>${item.plate || ""}</strong>
          <span>${item.owner || ""}</span>
          <span>${item.note || ""}</span>
          <button type="button" data-delete-plate="${item.plate || ""}">刪除</button>
        </div>
      `,
    )
    .join("");
}

function renderUnauthorizedList(items) {
  if (!items.length) {
    unauthorizedListEl.innerHTML = `<div class="admin-message">目前沒有未登錄紀錄。</div>`;
    return;
  }
  unauthorizedListEl.innerHTML = items
    .map((item) => {
      const imageLink = item.image_url
        ? `<a href="${item.image_url}" target="_blank" rel="noopener">查看截圖</a>`
        : `${item.image_path || "--"}`;
      return `
        <div class="record-item">
          <strong>${item.plate || "--"}</strong>
          <div class="record-meta">
            <span>時間：${item.time || "--"}</span>
            <span>狀態：${item.status || "--"}</span>
            <span>信心值：${item.confidence || "--"}</span>
            <span>截圖：${imageLink}</span>
            <span>備註：${item.note || "--"}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

async function loadAuthorizedPlates(forceRefresh = false, successStateText = "已讀取") {
  if (authorizedListEl.dataset.visible === "1" && !forceRefresh) {
    authorizedListEl.innerHTML = "";
    authorizedListEl.dataset.visible = "0";
    loadAuthorizedButton.textContent = "預覽名單";
    setAdminState("已收合", "info");
    adminMessageEl.textContent = "登錄名單已收合。";
    return;
  }
  if (!adminToken()) {
    setAdminState("請輸入密碼", "");
    adminMessageEl.textContent = "請先輸入管理密碼。";
    return;
  }
  try {
    await ensureBackendUrlForAdmin();
    setAdminState("讀取中", "ok");
    const response = await fetch(`${backendUrl}/api/authorized-plates?t=${Date.now()}`, {
      headers: adminHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) {
        setAdminState("密碼錯誤", "warn");
        throw new Error("管理密碼錯誤");
      }
      throw new Error(`讀取失敗：HTTP ${response.status}`);
    }
    const data = await response.json();
    renderAuthorizedList(data.plates || []);
    authorizedListEl.dataset.visible = "1";
    loadAuthorizedButton.textContent = "收合名單";
    setAdminState(successStateText, "ok");
    adminMessageEl.textContent = `已讀取 ${(data.plates || []).length} 筆登錄車牌。`;
  } catch (error) {
    if (adminStateEl.textContent !== "密碼錯誤") {
      setAdminState("讀取失敗", "warn");
    }
    adminMessageEl.textContent = error.message;
  }
}

async function previewUnauthorizedEvents() {
  if (unauthorizedListEl.dataset.visible === "1") {
    unauthorizedListEl.innerHTML = "";
    unauthorizedListEl.dataset.visible = "0";
    previewEventsButton.textContent = "預覽名單";
    setAdminState("已收合", "info");
    adminMessageEl.textContent = "未登錄紀錄已收合。";
    return;
  }
  if (!adminToken()) {
    setAdminState("請輸入密碼", "");
    adminMessageEl.textContent = "請先輸入管理密碼。";
    return;
  }
  try {
    await ensureBackendUrlForAdmin();
    setAdminState("讀取中", "ok");
    const response = await fetch(`${backendUrl}/api/unauthorized-events?t=${Date.now()}`, {
      headers: adminHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401) {
        setAdminState("密碼錯誤", "warn");
        throw new Error("管理密碼錯誤");
      }
      throw new Error(`讀取失敗：HTTP ${response.status}`);
    }
    const data = await response.json();
    renderUnauthorizedList(data.records || []);
    unauthorizedListEl.dataset.visible = "1";
    previewEventsButton.textContent = "收合名單";
    setAdminState("已讀取", "ok");
    adminMessageEl.textContent = `已讀取 ${(data.records || []).length} 筆未登錄紀錄。`;
  } catch (error) {
    if (adminStateEl.textContent !== "密碼錯誤") {
      setAdminState("讀取失敗", "warn");
    }
    adminMessageEl.textContent = error.message;
  }
}

async function saveAuthorizedPlate(event) {
  event.preventDefault();
  if (!adminToken()) {
    setAdminState("請輸入密碼", "");
    adminMessageEl.textContent = "請先輸入管理密碼。";
    return;
  }
  try {
    await ensureBackendUrlForAdmin();
    const response = await fetch(`${backendUrl}/api/authorized-plates`, {
      method: "POST",
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plate: adminPlateEl.value,
        owner: adminOwnerEl.value,
        note: adminNoteEl.value,
      }),
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? "管理密碼錯誤" : `儲存失敗：HTTP ${response.status}`);
    }
    adminPlateEl.value = "";
    adminOwnerEl.value = "";
    adminNoteEl.value = "";
    setAdminState("已儲存", "ok");
    adminMessageEl.textContent = "登錄車牌已更新。";
    await loadAuthorizedPlates(true);
  } catch (error) {
    setAdminState("儲存失敗", "warn");
    adminMessageEl.textContent = error.message;
  }
}

async function deleteAuthorizedPlate(plate) {
  if (!plate || !adminToken()) {
    return;
  }
  try {
    await ensureBackendUrlForAdmin();
    const response = await fetch(`${backendUrl}/api/authorized-plates/${encodeURIComponent(plate)}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? "管理密碼錯誤" : `刪除失敗：HTTP ${response.status}`);
    }
    setAdminState("已刪除", "ok");
    adminMessageEl.textContent = `${plate} 已刪除。`;
    await loadAuthorizedPlates(true);
  } catch (error) {
    setAdminState("刪除失敗", "warn");
    adminMessageEl.textContent = error.message;
  }
}

async function changeAdminPassword(event) {
  event.preventDefault();
  const oldPassword = oldAdminTokenEl.value.trim();
  const newPassword = newAdminTokenEl.value.trim();
  const confirmPassword = confirmNewAdminTokenEl.value.trim();
  if (!oldPassword || !newPassword || !confirmPassword) {
    setAdminState("請輸入密碼", "");
    adminMessageEl.textContent = "請輸入原始密碼、新密碼和確認新密碼。";
    return;
  }
  if (newPassword.length < 4) {
    setAdminState("新密碼太短", "warn");
    adminMessageEl.textContent = "新密碼至少需要 4 個字元。";
    return;
  }
  if (newPassword !== confirmPassword) {
    setAdminState("確認不一致", "warn");
    adminMessageEl.textContent = "新密碼和確認新密碼不一致。";
    return;
  }
  try {
    await ensureBackendUrlForAdmin();
    const response = await fetch(`${backendUrl}/api/admin-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...adminHeaders(),
      },
      body: JSON.stringify({
        old_password: oldPassword,
        new_password: newPassword,
      }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `變更密碼失敗：HTTP ${response.status}`);
    }
    adminTokenEl.value = newPassword;
    oldAdminTokenEl.value = "";
    newAdminTokenEl.value = "";
    confirmNewAdminTokenEl.value = "";
    setAdminState("密碼已變更", "ok");
    adminMessageEl.textContent = "管理密碼已更新，之後請使用新密碼。";
  } catch (error) {
    setAdminState("變更密碼失敗", "warn");
    adminMessageEl.textContent = error.message;
  }
}

async function downloadFile(path, filename) {
  if (!adminToken()) {
    setAdminState("請輸入密碼", "");
    adminMessageEl.textContent = "請先輸入管理密碼。";
    return;
  }
  try {
    await ensureBackendUrlForAdmin();
    const response = await fetch(`${backendUrl}${path}`, {
      headers: adminHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? "管理密碼錯誤" : `下載失敗：HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setAdminState("已下載", "ok");
    adminMessageEl.textContent = `${filename} 已開始下載。`;
  } catch (error) {
    setAdminState("下載失敗", "warn");
    adminMessageEl.textContent = error.message;
  }
}

async function clearUnauthorizedEvents() {
  if (!adminToken()) {
    setAdminState("請輸入密碼", "");
    adminMessageEl.textContent = "請先輸入管理密碼。";
    return;
  }
  if (!window.confirm("確定要清空未登錄紀錄嗎？截圖檔案會保留。")) {
    return;
  }
  try {
    await ensureBackendUrlForAdmin();
    const response = await fetch(`${backendUrl}/api/unauthorized-events`, {
      method: "DELETE",
      headers: adminHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? "管理密碼錯誤" : `清空紀錄失敗：HTTP ${response.status}`);
    }
    setAdminState("紀錄已清空", "ok");
    adminMessageEl.textContent = "未登錄紀錄已清空，截圖檔案已保留。";
    renderUnauthorizedList([]);
    unauthorizedListEl.dataset.visible = "1";
    previewEventsButton.textContent = "收合名單";
  } catch (error) {
    setAdminState("清空紀錄失敗", "warn");
    adminMessageEl.textContent = error.message;
  }
}

startButton.addEventListener("click", async () => {
  try {
    if (mobileMode === "viewer") {
      const closing = startButton.textContent.includes("關閉");
      await sendMobileControl(closing ? "close_camera" : "open_camera");
      messageEl.textContent = closing ? "已送出遠端關閉鏡頭命令。" : "已送出遠端開啟鏡頭命令。";
      return;
    }
    if (stream) {
      closeCamera();
    } else {
      warmupBackend();
      await openCamera();
    }
  } catch (error) {
    setState("鏡頭開啟失敗", "warn");
    messageEl.textContent = error.message;
  }
});
tabButtons.forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
toggleButton.addEventListener("click", async () => {
  if (mobileMode === "viewer") {
    try {
      const stopping = toggleButton.textContent.includes("停止");
      await sendMobileControl(stopping ? "stop_recognition" : "start_recognition");
      messageEl.textContent = stopping ? "已送出遠端停止辨識命令。" : "已送出遠端開始辨識命令。";
    } catch (error) {
      setState("遠端控制失敗", "warn");
      messageEl.textContent = error.message;
    }
    return;
  }
  toggleRecognition();
});
enterHostButton.addEventListener("click", () => enterApp("host"));
enterViewerButton.addEventListener("click", () => enterApp("viewer"));
saveUrlButton.addEventListener("click", saveBackendUrl);
reloadConfigButton.addEventListener("click", loadBackendConfig);
viewSizeEl.addEventListener("input", () => setViewerSize(viewSizeEl.value));
loadAuthorizedButton.addEventListener("click", () => loadAuthorizedPlates());
confirmAdminTokenButton.addEventListener("click", () => loadAuthorizedPlates(true, "密碼成功"));
passwordChangeFormEl.addEventListener("submit", changeAdminPassword);
adminTokenEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    loadAuthorizedPlates(true, "密碼成功");
  }
});
plateFormEl.addEventListener("submit", saveAuthorizedPlate);
downloadAuthorizedButton.addEventListener("click", () =>
  downloadFile("/api/download/authorized-plates", "已登錄車牌紀錄.xlsx"),
);
downloadEventsButton.addEventListener("click", () =>
  downloadFile("/api/download/unauthorized-events", "未登錄車牌紀錄.xlsx"),
);
previewEventsButton.addEventListener("click", previewUnauthorizedEvents);
clearEventsButton.addEventListener("click", clearUnauthorizedEvents);
authorizedListEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-plate]");
  if (button) {
    deleteAuthorizedPlate(button.dataset.deletePlate);
  }
});
window.addEventListener("resize", resizeOverlay);
window.addEventListener("orientationchange", () => window.setTimeout(resizeOverlay, 250));
window.setInterval(loadBackendConfig, 30000);
setViewerSize(localStorage.getItem("plateViewerWidth") || viewSizeEl.value);
loadBackendConfig();
setMobileMode(mobileMode);
