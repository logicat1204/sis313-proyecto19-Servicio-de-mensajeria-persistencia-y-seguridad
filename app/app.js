require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mysql2   = require('mysql2/promise');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

const APP_NAME  = process.env.APP_NAME || 'app';
const PORT      = process.env.PORT     || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

// --- Pool de conexiones MariaDB ---
const pool = mysql2.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.getConnection()
  .then(conn => { console.log(`[${APP_NAME}] Conexión a MariaDB exitosa`); conn.release(); })
  .catch(err  => { console.error(`[${APP_NAME}] ERROR MariaDB:`, err.message); process.exit(1); });

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit en endpoints de auth
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Demasiados intentos, espera 15 minutos.' } });

// --- Middleware de autenticación JWT ---
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// --- Health check ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', node: APP_NAME, timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────
//  SISTEMA DE LOGIN
// ─────────────────────────────────────────────────────

// Registro de nuevo usuario
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username y password requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)',
      [username.substring(0, 50), hash, email?.substring(0, 100) || null]
    );
    res.json({ success: true, message: 'Usuario registrado correctamente' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'El usuario ya existe' });
    console.error(`[${APP_NAME}] Error registro:`, err);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Credenciales requeridas' });
  try {
    const [rows] = await pool.query(
      'SELECT id, username, password_hash, is_active FROM users WHERE username = ?',
      [username]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Cuenta desactivada' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    // Actualizar last_login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: `${process.env.SESSION_EXPIRES_HOURS || 24}h` }
    );
    res.json({ success: true, token, username: user.username, node: APP_NAME });
  } catch (err) {
    console.error(`[${APP_NAME}] Error login:`, err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Verificar token (para mantener sesión)
app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ valid: true, username: req.user.username, node: APP_NAME });
});

// ─────────────────────────────────────────────────────
//  API REST DEL CHAT (requiere autenticación)
// ─────────────────────────────────────────────────────

app.get('/api/messages', requireAuth, async (req, res) => {
  const room  = req.query.room  || 'general';
  const limit = parseInt(req.query.limit) || 50;
  try {
    const [rows] = await pool.query(
      'SELECT id, username, content, room, created_at FROM messages WHERE room = ? ORDER BY created_at DESC LIMIT ?',
      [room, limit]
    );
    res.json({ node: APP_NAME, room, messages: rows.reverse() });
  } catch (err) {
    console.error(`[${APP_NAME}] Error GET /api/messages:`, err);
    res.status(500).json({ error: 'Error consultando mensajes' });
  }
});

let messageCount = 0;
app.get('/api/stats', (req, res) => {
  res.json({ node: APP_NAME, messages_since_start: messageCount, uptime_seconds: Math.floor(process.uptime()) });
});

// ─────────────────────────────────────────────────────
//  WEBSOCKET (autenticado mediante token)
// ─────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token de autenticación requerido'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

io.on('connection', (socket) => {
  const username = socket.user.username;
  console.log(`[${APP_NAME}] ${username} conectado: ${socket.id}`);

  socket.on('join_room', (room) => {
    socket.join(room);
    socket.emit('system_message', {
      content: `${username} se unió a "${room}" (nodo: ${APP_NAME})`,
      timestamp: new Date().toISOString()
    });
  });

  socket.on('send_message', async (data) => {
    const { content, room } = data;
    if (!content || !room) return;
    try {
      const [result] = await pool.query(
        'INSERT INTO messages (user_id, username, content, room) VALUES (?, ?, ?, ?)',
        [socket.user.id, username.substring(0, 50), content.substring(0, 1000), room]
      );
      messageCount++;
      const message = { id: result.insertId, username, content, room, node: APP_NAME, created_at: new Date().toISOString() };
      io.to(room).emit('receive_message', message);
    } catch (err) {
      console.error(`[${APP_NAME}] Error send_message:`, err);
      socket.emit('error_message', { error: 'Error al enviar mensaje' });
    }
  });

  socket.on('disconnect', () => console.log(`[${APP_NAME}] ${username} desconectado`));
});

server.listen(PORT, () => console.log(`[${APP_NAME}] Servidor en puerto ${PORT}`));
