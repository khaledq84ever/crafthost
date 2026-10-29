const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const DEFAULT_SECRETS = new Set(['change-me-please', 'change-me-to-a-long-random-string']);
const SECRET = process.env.JWT_SECRET || 'change-me-please';
// A known secret lets anyone mint an admin token, so production refuses to boot without a real one.
if (process.env.NODE_ENV === 'production') {
  if (DEFAULT_SECRETS.has(SECRET)) throw new Error('JWT_SECRET must be set to a long random string in production');
  if (SECRET.length < 32) console.warn('[auth] JWT_SECRET is shorter than 32 characters; use a longer random value');
}

function hashPassword(p) { return bcrypt.hashSync(p, 10); }
function verifyPassword(p, h) { return typeof p === 'string' && bcrypt.compareSync(p, h); }

// `tv` (token version) is bumped on password change/reset, which revokes every older token.
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.token_version || 0 },
    SECRET,
    { expiresIn: '30d' },
  );
}

/** Checks the signature and expiry only. Use authenticate() to also check the user is still valid. */
function verifyToken(token) {
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

/** Returns the user a token belongs to, or null if it is invalid, expired, revoked or the user is gone. */
function authenticate(token) {
  const payload = token ? verifyToken(token) : null;
  if (!payload) return null;
  const user = db
    .prepare('SELECT id, username, email, role, balance_cents, token_version FROM users WHERE id = ?')
    .get(payload.id);
  if (!user || (payload.tv || 0) !== user.token_version) return null;
  delete user.token_version;
  return user;
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const user = authenticate(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, authenticate, authMiddleware, adminOnly };
