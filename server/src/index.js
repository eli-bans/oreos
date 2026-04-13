const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

require('./db/schema'); // initialize DB

/** Comma-separated list, e.g. https://app.example.com,http://localhost:5173 — no trailing slashes */
function parseAllowedOrigins() {
  const raw = process.env.CLIENT_URL || 'http://localhost:5173';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins();

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalized = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(normalized)) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true },
});

app.use(cors(corsOptions));
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/compile', require('./routes/compile'));

app.get('/health', (_, res) => res.json({ ok: true }));

require('./sockets')(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Oreos server running on http://localhost:${PORT}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
});
