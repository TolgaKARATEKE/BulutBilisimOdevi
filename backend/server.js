const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = parseInt(process.env.PORT) || 3001;
const CANVAS_SIZE = parseInt(process.env.CANVAS_SIZE) || 100;
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS) || 5000;
const APP_VERSION = process.env.APP_VERSION || '1.0.0';

// In-memory canvas (flat array, index = y*SIZE + x)
const canvas = new Array(CANVAS_SIZE * CANVAS_SIZE).fill('#FFFFFF');

// Rate limiting: ip -> last placed timestamp
const cooldowns = new Map();

// Stats
let totalPixelsPlaced = 0;
let connectedClients = 0;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.set('trust proxy', true);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: APP_VERSION, uptime: process.uptime() });
});

// ── Stats ──────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json({
    totalPixelsPlaced,
    connectedClients,
    canvasSize: CANVAS_SIZE,
    version: APP_VERSION,
  });
});

// ── Get full canvas ────────────────────────────────────────────────────────────
app.get('/api/canvas', (req, res) => {
  res.json({ canvas, size: CANVAS_SIZE });
});

// ── Place a pixel ──────────────────────────────────────────────────────────────
app.post('/api/pixel', async (req, res) => {
  const { x, y, color } = req.body;
  const ip = req.ip || 'unknown';

  // Validate coordinates
  if (
    typeof x !== 'number' || typeof y !== 'number' ||
    x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE ||
    !Number.isInteger(x) || !Number.isInteger(y)
  ) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  // Validate color
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    return res.status(400).json({ error: 'Invalid color format' });
  }

  // Rate limiting
  const lastPlaced = cooldowns.get(ip);
  const now = Date.now();
  if (lastPlaced && now - lastPlaced < COOLDOWN_MS) {
    const remainingMs = COOLDOWN_MS - (now - lastPlaced);
    return res.status(429).json({
      error: 'Cooldown active',
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
    });
  }

  // Update in-memory canvas
  canvas[y * CANVAS_SIZE + x] = color;
  cooldowns.set(ip, now);
  totalPixelsPlaced++;

  // Persist to database
  try {
    await db.query(
      `INSERT INTO pixels (x, y, color, placed_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (x, y) DO UPDATE
         SET color = EXCLUDED.color,
             placed_by = EXCLUDED.placed_by,
             placed_at = NOW()`,
      [x, y, color, ip]
    );
  } catch (err) {
    console.error('[DB] Write error:', err.message);
  }

  // Broadcast to all WebSocket clients
  const message = JSON.stringify({ type: 'pixel', x, y, color });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });

  res.json({ success: true, x, y, color });
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  connectedClients++;
  console.log(`[WS] Client connected (total: ${connectedClients})`);

  // Send current canvas snapshot
  ws.send(JSON.stringify({ type: 'canvas', canvas, size: CANVAS_SIZE }));

  // Broadcast updated client count
  broadcast({ type: 'stats', connectedClients, totalPixelsPlaced });

  ws.on('close', () => {
    connectedClients--;
    broadcast({ type: 'stats', connectedClients, totalPixelsPlaced });
    console.log(`[WS] Client disconnected (total: ${connectedClients})`);
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
async function bootstrap() {
  // Wait for DB with retries
  for (let i = 1; i <= 10; i++) {
    try {
      await db.init();
      break;
    } catch (err) {
      console.error(`[DB] Connection attempt ${i}/10 failed: ${err.message}`);
      if (i === 10) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Load saved pixels into memory
  const result = await db.query('SELECT x, y, color FROM pixels');
  result.rows.forEach(({ x, y, color }) => {
    canvas[y * CANVAS_SIZE + x] = color;
  });
  totalPixelsPlaced = result.rows.length;
  console.log(`[DB] Loaded ${result.rows.length} pixels`);

  server.listen(PORT, () => {
    console.log(`[SERVER] v${APP_VERSION} listening on port ${PORT}`);
    console.log(`[SERVER] Canvas size: ${CANVAS_SIZE}x${CANVAS_SIZE}`);
    console.log(`[SERVER] Cooldown: ${COOLDOWN_MS}ms`);
  });
}

bootstrap().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
