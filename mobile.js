const videoEl = document.querySelector("#camera");
const previewEl = document.querySelector("#preview");
const overlayEl = document.querySelector("#overlay");
const captureEl = document.querySelector("#capture");
const startButton = document.querySelector("#start");
const toggleButton = document.querySelector("#toggle");
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

let stream = null;
let running = false;
let requestBusy = false;
let timer = 0;
let backendUrl = "";
let previewFrame = { width: 0, height: 0 };
let requestSeq = 0;
let latestDrawnSeq = 0;
let lastMotionSample = null;
let lastMotionCheck = 0;
let lastMotionAt = 0;
let overlayHasBoxes = false;
const captureWidth = 640;
const recognizeIntervalMs = 80;
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

async function loadBackendConfig() {
  try {
    const response = await fetch(`./backend-config.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`設定檔讀取失敗 ${response.status}`);
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
      setState("後端網址已載入", "ok");
      messageEl.textContent = config.updatedAt ? `設定更新時間：${config.updatedAt}` : "後端網址已載入";
    } else {
      setState("尚未設定後端", "warn");
      messageEl.textContent = "請先執行電腦端 tunnel 啟動腳本，或手動填入後端網址";
    }
  } catch (error) {
    setState("設定讀取失敗", "warn");
    messageEl.textContent = error.message;
  }
}

function saveBackendUrl() {
  backendUrl = normalizeUrl(backendInput.value);
  localStorage.setItem("plateBackendUrl", backendUrl);
  setState(backendUrl ? "後端網址已儲存" : "尚未設定後端", backendUrl ? "ok" : "warn");
}

async function openCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      aspectRatio: { ideal: 1.7777778 },
    },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  toggleButton.disabled = false;
  setState("鏡頭已開啟", "ok");
  messageEl.textContent = "按開始辨識後會傳送手機截圖到後端";
  resizeOverlay();
  requestAnimationFrame(renderPreview);
}

function resizeOverlay() {
  const rect = previewEl.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * window.devicePixelRatio));
  const height = Math.max(1, Math.round(rect.height * window.devicePixelRatio));
  previewEl.width = width;
  previewEl.height = height;
  overlayEl.width = width;
  overlayEl.height = height;
  previewFrame = { width, height };
  overlayEl.getContext("2d").clearRect(0, 0, overlayEl.width, overlayEl.height);
}

function clearOverlay() {
  const context = overlayEl.getContext("2d");
  context.clearRect(0, 0, overlayEl.width, overlayEl.height);
  overlayHasBoxes = false;
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
  if (!stream) {
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
  }
  requestAnimationFrame(renderPreview);
}

function detectMotion() {
  const now = performance.now();
  if (!running || now - lastMotionCheck < 220 || !previewEl.width || !previewEl.height) {
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
    if (overlayHasBoxes) {
      clearOverlay();
      messageEl.textContent = "畫面移動中，等待重新偵測車牌";
    }
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
      0.72,
    ),
  );
}

function drawResults(result, captureMeta) {
  if (captureMeta && (result.width !== captureMeta.width || result.height !== captureMeta.height)) {
    clearOverlay();
    return;
  }
  resizeOverlay();
  const context = overlayEl.getContext("2d");
  context.clearRect(0, 0, overlayEl.width, overlayEl.height);
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
  setState(unauthorized.length ? "偵測到未登錄車牌" : running ? "辨識中" : "已停止", unauthorized.length ? "warn" : "ok");
}

async function recognizeOnce() {
  if (!running || !backendUrl) {
    return;
  }
  if (requestBusy) {
    return;
  }
  requestBusy = true;
  const seq = ++requestSeq;
  try {
    const capture = await captureFrame();
    const response = await fetch(`${backendUrl}/api/mobile-recognize`, {
      method: "POST",
      headers: {
        "Content-Type": "image/jpeg",
        "X-Frame-Id": String(seq),
      },
      body: capture.blob,
      cache: "no-store",
    });
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
    drawResults(result, capture);
    updatePanel(result);
  } catch (error) {
    clearOverlay();
    setState("連線錯誤", "warn");
    messageEl.textContent = error.message;
  } finally {
    requestBusy = false;
    if (running) {
      window.clearTimeout(timer);
      timer = window.setTimeout(recognizeOnce, recognizeIntervalMs);
    }
  }
}

function toggleRecognition() {
  running = !running;
  toggleButton.textContent = running ? "停止辨識" : "開始辨識";
  setState(running ? "辨識中" : "已停止", running ? "ok" : "");
  if (running) {
    lastMotionSample = null;
    recognizeOnce();
  } else {
    window.clearTimeout(timer);
    clearOverlay();
  }
}

startButton.addEventListener("click", async () => {
  try {
    await openCamera();
  } catch (error) {
    setState("鏡頭開啟失敗", "warn");
    messageEl.textContent = error.message;
  }
});
toggleButton.addEventListener("click", toggleRecognition);
saveUrlButton.addEventListener("click", saveBackendUrl);
reloadConfigButton.addEventListener("click", loadBackendConfig);
window.addEventListener("resize", resizeOverlay);
window.addEventListener("orientationchange", () => window.setTimeout(resizeOverlay, 250));
window.setInterval(loadBackendConfig, 30000);
loadBackendConfig();
