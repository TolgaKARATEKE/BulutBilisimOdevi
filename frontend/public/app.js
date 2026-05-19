/* ─────────────────────────────────────────────
   r/place — Mini Collaborative Canvas
   Frontend Application Logic
───────────────────────────────────────────── */

const CANVAS_SIZE = 100;
const PIXEL_SIZE = 8; // px per pixel at zoom=1
const COOLDOWN_MS = 5000;

// Reddit r/place 32-color palette
const PALETTE = [
  '#FFFFFF','#E4E4E4','#888888','#222222',
  '#FFA7D1','#E50000','#E59500','#A06A42',
  '#E5D900','#94E044','#02BE01','#00D3DD',
  '#0083C7','#0000EA','#CF6EE4','#820080',
  '#FF4500','#FF6534','#FFA800','#FFD635',
  '#7EED56','#00CC78','#009EAA','#00756F',
  '#2450A4','#3690EA','#51E9F4','#493AC1',
  '#6D001A','#BE0039','#FF99AA','#FFB470',
];

// ─── State ──────────────────────────────────────────────────────────────────
let canvas, ctx, minimap, mctx;
let canvasData = new Array(CANVAS_SIZE * CANVAS_SIZE).fill('#FFFFFF');
let selectedColor = '#E50000';
let zoom = 4;
let panX = 0, panY = 0;
let isDragging = false;
let dragStartX, dragStartY, panStartX, panStartY;
let hoverX = -1, hoverY = -1;
let cooldownEnd = 0;
let cooldownRAF = null;
let ws = null;
let wsReconnectTimer = null;

const $main         = document.getElementById('main');
const $container    = document.getElementById('canvas-container');
const $hoverOutline = document.getElementById('hover-outline');
const $crosshairH   = document.getElementById('crosshair-h');
const $crosshairV   = document.getElementById('crosshair-v');
const $zoomLevel    = document.getElementById('zoom-level');
const $coordDisplay = document.getElementById('coord-display');
const $onlineCount  = document.getElementById('online-count');
const $pixelsCount  = document.getElementById('pixels-count');
const $palette      = document.getElementById('palette');
const $selectedPrev = document.getElementById('selected-color-preview');
const $selectedHex  = document.getElementById('selected-color-hex');
const $cooldownBar  = document.getElementById('cooldown-bar');
const $cooldownLbl  = document.getElementById('cooldown-label');
const $btnPlace     = document.getElementById('btn-place');
const $toast        = document.getElementById('toast');
const $connDot      = document.getElementById('conn-dot');
const $connLabel    = document.getElementById('conn-label');
const $versionBadge = document.getElementById('version-badge');
const $minimapVP    = document.getElementById('minimap-viewport');

// ─── Init ────────────────────────────────────────────────────────────────────
function init() {
  canvas = document.getElementById('canvas');
  ctx    = canvas.getContext('2d');
  canvas.width  = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;

  minimap = document.getElementById('minimap');
  mctx    = minimap.getContext('2d');
  minimap.width  = CANVAS_SIZE;
  minimap.height = CANVAS_SIZE;

  buildPalette();
  setSelectedColor(selectedColor);
  applyTransform();
  centerView();

  // Load canvas then connect WS
  fetchCanvas();
  connectWebSocket();
  startCooldownLoop();

  // Events
  $main.addEventListener('wheel',      onWheel,     { passive: false });
  $main.addEventListener('mousedown',  onMouseDown);
  $main.addEventListener('mousemove',  onMouseMove);
  $main.addEventListener('mouseup',    onMouseUp);
  $main.addEventListener('mouseleave', onMouseLeave);
  $main.addEventListener('dblclick',   onDoubleClick);
  $main.addEventListener('touchstart', onTouchStart, { passive: false });
  $main.addEventListener('touchmove',  onTouchMove,  { passive: false });
  $main.addEventListener('touchend',   onTouchEnd);

  document.getElementById('btn-zoom-in') .addEventListener('click', () => doZoom(1.5));
  document.getElementById('btn-zoom-out').addEventListener('click', () => doZoom(1 / 1.5));
  document.getElementById('btn-reset-view').addEventListener('click', centerView);
  $btnPlace.addEventListener('click', placePixelAtHover);

  minimap.parentElement.addEventListener('click', onMinimapClick);

  window.addEventListener('resize', () => { updateMinimapViewport(); });
}

// ─── Palette ─────────────────────────────────────────────────────────────────
function buildPalette() {
  PALETTE.forEach(color => {
    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    swatch.title = color;
    swatch.dataset.color = color;
    swatch.addEventListener('click', () => setSelectedColor(color));
    $palette.appendChild(swatch);
  });
}

function setSelectedColor(color) {
  selectedColor = color;
  $selectedPrev.style.background = color;
  $selectedHex.textContent = color;
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
  });
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────
function applyTransform() {
  const totalW = CANVAS_SIZE * PIXEL_SIZE * zoom;
  const totalH = CANVAS_SIZE * PIXEL_SIZE * zoom;
  
  // Use CSS width/height to scale the container and the canvas inside it
  $container.style.width  = totalW + 'px';
  $container.style.height = totalH + 'px';
  $container.style.transform = `translate(${panX}px, ${panY}px)`;
  
  $zoomLevel.textContent = zoom.toFixed(1) + '×';
  updateMinimapViewport();
}

function centerView() {
  const rect = $main.getBoundingClientRect();
  const totalW = CANVAS_SIZE * PIXEL_SIZE * zoom;
  const totalH = CANVAS_SIZE * PIXEL_SIZE * zoom;
  panX = (rect.width  - totalW) / 2;
  panY = (rect.height - totalH) / 2;
  applyTransform();
}

function renderFull() {
  const img = ctx.createImageData(CANVAS_SIZE, CANVAS_SIZE);
  for (let i = 0; i < canvasData.length; i++) {
    const color = canvasData[i] || '#FFFFFF';
    const [r, g, b] = hexToRgb(color);
    img.data[i * 4]     = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  renderMinimap();
}

function renderPixel(x, y, color) {
  const [r, g, b] = hexToRgb(color);
  const img = ctx.createImageData(1, 1);
  img.data[0] = r; img.data[1] = g; img.data[2] = b; img.data[3] = 255;
  ctx.putImageData(img, x, y);
  // Update minimap
  mctx.fillStyle = color;
  mctx.fillRect(x, y, 1, 1);
}

function renderMinimap() {
  const imgData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  mctx.putImageData(imgData, 0, 0);
}

// ─── Minimap viewport indicator ───────────────────────────────────────────────
function updateMinimapViewport() {
  const rect   = $main.getBoundingClientRect();
  const scale  = 120 / CANVAS_SIZE; // minimap is 120px

  const pixelW = CANVAS_SIZE * PIXEL_SIZE * zoom;
  const pixelH = CANVAS_SIZE * PIXEL_SIZE * zoom;

  // Visible portion in canvas-pixel coords
  const visL = Math.max(0, -panX / (PIXEL_SIZE * zoom));
  const visT = Math.max(0, -panY / (PIXEL_SIZE * zoom));
  const visW = Math.min(CANVAS_SIZE, rect.width  / (PIXEL_SIZE * zoom));
  const visH = Math.min(CANVAS_SIZE, rect.height / (PIXEL_SIZE * zoom));

  $minimapVP.style.left   = (visL * scale) + 'px';
  $minimapVP.style.top    = (visT * scale) + 'px';
  $minimapVP.style.width  = (visW * scale) + 'px';
  $minimapVP.style.height = (visH * scale) + 'px';
}

function onMinimapClick(e) {
  const rect  = minimap.getBoundingClientRect();
  const scale = CANVAS_SIZE / 120;
  const cx    = (e.clientX - rect.left) * scale;
  const cy    = (e.clientY - rect.top)  * scale;
  const mainR = $main.getBoundingClientRect();
  panX = mainR.width  / 2 - cx * PIXEL_SIZE * zoom;
  panY = mainR.height / 2 - cy * PIXEL_SIZE * zoom;
  applyTransform();
}

// ─── Mouse / touch interaction ────────────────────────────────────────────────
function clientToPixel(cx, cy) {
  const rect = $main.getBoundingClientRect();
  const relX = cx - rect.left - panX;
  const relY = cy - rect.top  - panY;
  const px = Math.floor(relX / (PIXEL_SIZE * zoom));
  const py = Math.floor(relY / (PIXEL_SIZE * zoom));
  return { px, py };
}

function onMouseDown(e) {
  if (e.button === 1 || e.button === 2) {
    // Middle/right: start pan
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX  = panX;
    panStartY  = panY;
    $main.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
  // Left button: start potential pan
  isDragging  = true;
  dragStartX  = e.clientX;
  dragStartY  = e.clientY;
  panStartX   = panX;
  panStartY   = panY;
}

let didDrag = false;
function onMouseMove(e) {
  const { px, py } = clientToPixel(e.clientX, e.clientY);
  updateHover(px, py, e.clientX, e.clientY);

  if (isDragging) {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      didDrag = true;
      panX = panStartX + dx;
      panY = panStartY + dy;
      applyTransform();
      $main.style.cursor = 'grabbing';
    }
  }
}

function onMouseUp(e) {
  isDragging = false;
  $main.style.cursor = 'crosshair';
  if (!didDrag && e.button === 0) {
    const { px, py } = clientToPixel(e.clientX, e.clientY);
    if (isValid(px, py)) placePixel(px, py);
  }
  didDrag = false;
}

function onMouseLeave() {
  isDragging = false;
  hoverX = hoverY = -1;
  $coordDisplay.textContent = '—';
  $crosshairH.style.display = 'none';
  $crosshairV.style.display = 'none';
  if ($hoverOutline) $hoverOutline.style.display = 'none';
}

function onDoubleClick(e) {
  doZoom(1.5, e.clientX, e.clientY);
}

function updateHover(px, py, cx, cy) {
  if (!isValid(px, py)) {
    $coordDisplay.textContent = '—';
    $crosshairH.style.display = 'none';
    $crosshairV.style.display = 'none';
    if ($hoverOutline) $hoverOutline.style.display = 'none';
    hoverX = hoverY = -1;
    return;
  }
  hoverX = px; hoverY = py;
  $coordDisplay.textContent = `(${px}, ${py})`;

  // Crosshair position relative to #main
  const cellSize = PIXEL_SIZE * zoom;
  const cellL = panX + px * cellSize;
  const cellT = panY + py * cellSize;
  const cellCX = cellL + cellSize / 2;
  const cellCY = cellT + cellSize / 2;

  $crosshairH.style.display = 'block';
  $crosshairH.style.top     = cellCY + 'px';
  $crosshairV.style.display = 'block';
  $crosshairV.style.left    = cellCX + 'px';

  // Hover outline is INSIDE the #canvas-container, so it just needs left/top without pan offset
  if ($hoverOutline) {
    $hoverOutline.style.display = 'block';
    $hoverOutline.style.left    = (px * cellSize) + 'px';
    $hoverOutline.style.top     = (py * cellSize) + 'px';
    $hoverOutline.style.width   = cellSize + 'px';
    $hoverOutline.style.height  = cellSize + 'px';
  }
}

// ─── Touch support ────────────────────────────────────────────────────────────
let lastTouchDist = 0;
let touchPanStart = null;

function onTouchStart(e) {
  if (e.touches.length === 2) {
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  } else if (e.touches.length === 1) {
    isDragging = true;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
    panStartX  = panX;
    panStartY  = panY;
    didDrag    = false;
  }
  e.preventDefault();
}

function onTouchMove(e) {
  if (e.touches.length === 2) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    doZoom(d / lastTouchDist, cx, cy);
    lastTouchDist = d;
  } else if (e.touches.length === 1 && isDragging) {
    const dx = e.touches[0].clientX - dragStartX;
    const dy = e.touches[0].clientY - dragStartY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) didDrag = true;
    panX = panStartX + dx;
    panY = panStartY + dy;
    applyTransform();
  }
  e.preventDefault();
}

function onTouchEnd(e) {
  isDragging = false;
  if (!didDrag && e.changedTouches.length === 1) {
    const t = e.changedTouches[0];
    const { px, py } = clientToPixel(t.clientX, t.clientY);
    if (isValid(px, py)) placePixel(px, py);
  }
  didDrag = false;
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  doZoom(factor, e.clientX, e.clientY);
}

function doZoom(factor, cx, cy) {
  const mainRect = $main.getBoundingClientRect();
  let relX = mainRect.width / 2;
  let relY = mainRect.height / 2;
  if (cx !== undefined && cy !== undefined) {
    relX = cx - mainRect.left;
    relY = cy - mainRect.top;
  }

  const newZoom = Math.min(40, Math.max(0.5, zoom * factor));
  const scale   = newZoom / zoom;

  panX = relX - (relX - panX) * scale;
  panY = relY - (relY - panY) * scale;
  zoom = newZoom;
  applyTransform();
}

// ─── Pixel placement ──────────────────────────────────────────────────────────
function placePixelAtHover() {
  if (isValid(hoverX, hoverY)) placePixel(hoverX, hoverY);
}

async function placePixel(x, y) {
  const now = Date.now();
  if (cooldownEnd > now) {
    showToast(`⏳ ${Math.ceil((cooldownEnd - now) / 1000)}s bekle`, 'error');
    return;
  }

  // Optimistic update
  canvasData[y * CANVAS_SIZE + x] = selectedColor;
  renderPixel(x, y, selectedColor);

  cooldownEnd = now + COOLDOWN_MS;
  startCooldownLoop();

  try {
    const res = await fetch('/api/pixel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y, color: selectedColor }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (res.status === 429) {
        const ms = data.remainingMs || COOLDOWN_MS;
        cooldownEnd = Date.now() + ms;
        showToast(`⏳ ${data.remainingSec || Math.ceil(ms/1000)}s bekle`, 'error');
      } else {
        showToast('❌ ' + (data.error || 'Hata'), 'error');
      }
    } else {
      showToast('✅ Piksel konuldu!', 'success');
    }
  } catch (err) {
    showToast('❌ Bağlantı hatası', 'error');
  }
}

// ─── Cooldown loop ────────────────────────────────────────────────────────────
function startCooldownLoop() {
  if (cooldownRAF) cancelAnimationFrame(cooldownRAF);
  tickCooldown();
}

function tickCooldown() {
  const now       = Date.now();
  const remaining = cooldownEnd - now;

  if (remaining <= 0) {
    $cooldownBar.style.width    = '100%';
    $cooldownBar.style.background = 'linear-gradient(90deg,#22c55e,#16a34a)';
    $cooldownLbl.textContent  = 'Hazır!';
    $btnPlace.disabled          = false;
    return;
  }

  const pct = Math.max(0, (1 - remaining / COOLDOWN_MS)) * 100;
  $cooldownBar.style.width      = pct + '%';
  $cooldownBar.style.background = 'linear-gradient(90deg,#f59e0b,#d97706)';
  $cooldownLbl.textContent      = Math.ceil(remaining / 1000) + 's';
  $btnPlace.disabled            = true;

  cooldownRAF = requestAnimationFrame(tickCooldown);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWebSocket() {
  setConnStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    setConnStatus('connected');
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'canvas') {
      canvasData = msg.canvas;
      renderFull();
    } else if (msg.type === 'pixel') {
      canvasData[msg.y * CANVAS_SIZE + msg.x] = msg.color;
      renderPixel(msg.x, msg.y, msg.color);
    } else if (msg.type === 'stats') {
      $onlineCount.textContent = msg.connectedClients || 0;
      $pixelsCount.textContent = msg.totalPixelsPlaced || 0;
    }
  };

  ws.onclose = () => {
    setConnStatus('disconnected');
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => ws.close();
}

function setConnStatus(state) {
  $connDot.className = 'stat-dot ' + state;
  $connLabel.textContent = state === 'connected'    ? 'Bağlı'
                         : state === 'connecting'   ? 'Bağlanıyor...'
                         : 'Bağlantı kesildi';
}

// ─── Initial canvas fetch ─────────────────────────────────────────────────────
async function fetchCanvas() {
  try {
    const res  = await fetch('/api/canvas');
    const data = await res.json();
    if (data.canvas) {
      canvasData = data.canvas;
      renderFull();
    }
    // Also fetch stats
    const sRes  = await fetch('/api/stats');
    const sData = await sRes.json();
    $versionBadge.textContent = 'v' + (sData.version || '1.0.0');
    $pixelsCount.textContent  = sData.totalPixelsPlaced || 0;
  } catch (err) {
    console.warn('fetchCanvas failed:', err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValid(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) &&
         x >= 0 && x < CANVAS_SIZE && y >= 0 && y < CANVAS_SIZE;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let toastTimer = null;
function showToast(msg, type = '') {
  $toast.textContent = msg;
  $toast.className   = 'show ' + type;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.className = ''; }, 2500);
}

// ─── Start ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
