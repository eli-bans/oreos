const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

require('./db/schema'); // initialize DB

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_URL, credentials: true },
});

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sessions', require('./routes/sessions'));

app.get('/health', (_, res) => res.json({ ok: true }));

require('./sockets')(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Oreos server running on http://localhost:${PORT}`));
