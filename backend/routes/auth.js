const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, authMiddleware } = require('../lib/auth');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

router.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password too short (min 8)' });
  if (password.length > 128) return res.status(400).json({ error: 'Password too long (max 128)' });
  if (username.length < 3) return res.status(400).json({ error: 'Username too short (min 3)' });
  if (username.length > 32) return res.status(400).json({ error: 'Username too long (max 32)' });
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
  if (exists) return res.status(409).json({ error: 'Email or username already exists' });

  const hash = hashPassword(password);
  const info = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(username, email, hash);
  const user = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(info.lastInsertRowid);

  const token = signToken(user);
  res.cookie('token', token, COOKIE_OPTS);

  // Auto-provision a free-tier starter server so the user can immediately join in-game.
  // Failure here must NOT block registration — log and continue.
  let starter = null;
  if (process.env.AUTO_STARTER !== '0') {
    try {
      const { createServerForUser } = require('./servers');
      starter = await createServerForUser(
        user,
        {
          name: `${user.username}'s server`,
          type: 'paper',
          // 2 GB plan / 1.5 GB heap comfortably fits Paper 1.21.x. Override
          // via STARTER_VERSION env if you want all new accounts on a specific
          // version (e.g. for stable testing).
          version: process.env.STARTER_VERSION || '1.21.1',
          plan: 'free',
          region: 'eu',
          motd: `Welcome to ${user.username}'s server!`,
          difficulty: 'normal',
          gamemode: 'survival',
          whitelist: false,
        },
        req.ip
      );
    } catch (err) {
      console.warn('[register] starter server skipped:', err.message);
    }
  }

  res.json({ token, user, starter });
});

router.post('/login', (req, res) => {
  const { email, password, remember } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(email, email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  db.prepare('UPDATE users SET last_login = strftime(\'%s\',\'now\') WHERE id = ?').run(user.id);
  const token = signToken(user);
  // If "remember me" is unchecked, drop maxAge so the cookie clears when the
  // browser closes (session cookie). Default (and missing field) → 30 days.
  const opts = (remember === false)
    ? { httpOnly: COOKIE_OPTS.httpOnly, secure: COOKIE_OPTS.secure, sameSite: COOKIE_OPTS.sameSite }
    : COOKIE_OPTS;
  res.cookie('token', token, opts);
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: COOKIE_OPTS.sameSite });
  res.json({ ok: true });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// PATCH /api/auth/me { email?, username? } — update profile fields. Requires current password.
router.patch('/me', authMiddleware, (req, res) => {
  const { email, username, current_password } = req.body || {};
  if (!current_password) return res.status(400).json({ error: 'Current password required' });

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u || !verifyPassword(current_password, u.password_hash)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const updates = [];
  const params = [];
  if (email && email !== u.email) {
    const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
    if (taken) return res.status(409).json({ error: 'Email already in use' });
    updates.push('email = ?'); params.push(email);
  }
  if (username && username !== u.username) {
    if (username.length < 3) return res.status(400).json({ error: 'Username too short (min 3)' });
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
    if (taken) return res.status(409).json({ error: 'Username already in use' });
    updates.push('username = ?'); params.push(username);
  }
  if (!updates.length) return res.json({ ok: true, user: { id: u.id, username: u.username, email: u.email, role: u.role } });

  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const fresh = db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(req.user.id);
  // Re-sign token so the JWT payload reflects new username
  const token = signToken(fresh);
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ ok: true, user: fresh });
});

// POST /api/auth/change-password { current_password, new_password }
router.post('/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 8) return res.status(400).json({ error: 'Password too short (min 8)' });

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u || !verifyPassword(current_password, u.password_hash)) {
    return res.status(401).json({ error: 'Invalid current password' });
  }
  const hash = hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  // Invalidate any outstanding reset tokens for this user
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// DELETE /api/auth/me { password, confirm } — permanently delete account + cascade.
router.delete('/me', authMiddleware, async (req, res) => {
  const { password, confirm } = req.body || {};
  if (confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  if (!password) return res.status(400).json({ error: 'Password required' });

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!u || !verifyPassword(password, u.password_hash)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  if (u.role === 'admin') {
    return res.status(403).json({ error: 'Admin accounts cannot be self-deleted. Demote first.' });
  }

  // Stop & remove servers + free TCP proxies before deleting the row.
  try {
    const dc = require('../lib/controller');
    const railway = require('../lib/railway-api');
    const servers = db.prepare('SELECT s.*, p.ram_mb, p.cpu_cores FROM servers s JOIN plans p ON s.plan_id = p.id WHERE s.user_id = ?').all(req.user.id);
    for (const s of servers) {
      try { await dc.stopServer(s); } catch {}
      if (s.proxy_id && railway.isConfigured()) {
        try { await railway.deleteTcpProxy(s.proxy_id); } catch {}
      }
    }
  } catch {}

  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  res.clearCookie('token', { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: COOKIE_OPTS.sameSite });
  res.json({ ok: true });
});

// POST /api/auth/forgot { email } — issues a one-shot password reset token.
// No email service is wired, and the link must NEVER go back to the requester:
// that let anyone who knew (or guessed) an email take over the account. The
// link goes to the server log + a platform event instead — the owner verifies
// the person in Discord and hands them the link out-of-band.
const crypto = require('crypto');
router.post('/forgot', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const generic = {
    ok: true,
    message: 'If an account exists, a reset link has been issued. Ask in our Discord to receive it.',
  };
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) return res.json(generic); // same shape — no enumeration
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, expires);
  // Host header (not attacker-supplied Origin) — behind Railway's proxy this
  // is the real deploy host, so the logged link can't be poisoned.
  const resetUrl = `${req.protocol}://${req.get('host')}/reset.html?token=${token}`;
  console.log(`[auth] password reset requested for ${user.email} (user ${user.id}): ${resetUrl} — expires in 60 min`);
  require('../lib/events').record('password_reset_requested', null, { user_id: user.id, email: user.email });
  res.json(generic);
});

// POST /api/auth/reset { token, password } — set new password using the token.
router.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token + password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password too short (min 8)' });

  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row) return res.status(400).json({ error: 'Invalid or expired token' });
  if (row.used_at) return res.status(400).json({ error: 'Token already used' });
  if (row.expires_at < Math.floor(Date.now() / 1000)) return res.status(400).json({ error: 'Token expired' });

  const hash = hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  db.prepare('UPDATE password_resets SET used_at = strftime(\'%s\',\'now\') WHERE token = ?').run(token);
  // Invalidate any other outstanding tokens for this user
  db.prepare('DELETE FROM password_resets WHERE user_id = ? AND token != ?').run(row.user_id, token);

  res.json({ ok: true, message: 'Password updated. Please sign in.' });
});

module.exports = router;
