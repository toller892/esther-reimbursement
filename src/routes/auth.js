// 认证路由：Google OAuth + @feedmob.com 白名单 + Token 管理

const express = require('express');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { getTokenForUser, resetTokenForUser, registerUser } = require('../services/token');

const router = express.Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3459/auth/google/callback';
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || '';

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
    scope: ['profile', 'email'],
  }, async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || '';
    if (ALLOWED_DOMAIN) {
      const domain = email.split('@')[1];
      if (domain !== ALLOWED_DOMAIN) {
        return done(null, false, { message: `仅 @${ALLOWED_DOMAIN} 邮箱可登录` });
      }
    }
    const user = {
      id: profile.id,
      email,
      name: profile.displayName || profile.name?.givenName || '未知用户',
      photo: profile.photos?.[0]?.value || '',
      provider: 'google',
    };
    await registerUser(user);
    return done(null, user);
  }));
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ success: false, error: '请先登录' });
}

// Google 登录入口
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// Google 回调
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=login_failed' }),
  (req, res) => res.redirect('/')
);

// 退出
router.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// 当前用户信息 + API Token
router.get('/me', ensureAuth, async (req, res) => {
  const token = await getTokenForUser(req.user.id);
  res.json({ success: true, data: { ...req.user, apiToken: token } });
});

// Mock 登录（开发测试用）
router.post('/mock-login', async (req, res) => {
  const email = req.body.email || 'demo@feedmob.com';
  if (process.env.ALLOWED_DOMAIN) {
    const domain = email.split('@')[1];
    if (domain !== process.env.ALLOWED_DOMAIN) {
      return res.status(403).json({ success: false, error: `仅 @${process.env.ALLOWED_DOMAIN} 邮箱可登录` });
    }
  }
  const mockUser = {
    id: req.body.id || `mock-${Date.now()}`,
    email,
    name: req.body.name || '演示用户',
    photo: '',
    provider: 'mock',
  };
  await registerUser(mockUser);
  req.login(mockUser, (err) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, data: mockUser });
  });
});

// 重置 Token
router.post('/reset-token', ensureAuth, async (req, res) => {
  const newToken = await resetTokenForUser(req.user.id);
  res.json({ success: true, data: { apiToken: newToken } });
});

module.exports = { router, ensureAuth };
