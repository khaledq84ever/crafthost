const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET = process.env.JWT_SECRET || 'change-me-please';

function hashPassword(p) { return bcrypt.hashSync(p, 10); }
function verifyPassword(p, h) { return bcrypt.compareSync(p, h); }

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  const user = db.prepare('SELECT id, username, email, role, balance_cents FROM users WHERE id = ?').get(payload.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, authMiddleware, adminOnly };
