// MCP OAuth 服务 — 精简复用 service-deployer 的 Google OAuth 认证体系
// 支持 Hermes `hermes mcp add --auth oauth` 标准流程

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || '';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// PKCE helpers
function generateCodeVerifier() { return crypto.randomBytes(64).toString('base64url'); }
function generateCodeChallenge(verifier) { return crypto.createHash('sha256').update(verifier).digest('base64url'); }
function generateTokenId() { return crypto.randomBytes(32).toString('base64url'); }

// In-memory stores
const pkceSessions = new Map();  // state → { codeChallenge, codeVerifier, redirectUri, exp }

function cleanExpired() {
  const now = Date.now();
  for (const [k, v] of pkceSessions) { if (v.exp < now) pkceSessions.delete(k); }
}
setInterval(cleanExpired, 60000);

// Google OAuth URL
function getGoogleAuthUrl(state, codeChallenge) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${BASE_URL}/mcp/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  if (ALLOWED_DOMAIN) params.set('hd', ALLOWED_DOMAIN);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Google callback → exchange code for user info
async function handleGoogleCallback(code, codeVerifier) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: `${BASE_URL}/mcp/auth/google/callback`,
    code_verifier: codeVerifier,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: params });
  const data = await res.json();
  const decoded = jwt.decode(data.id_token);
  if (!decoded) throw new Error('Failed to decode Google ID token');
  if (ALLOWED_DOMAIN && decoded.hd !== ALLOWED_DOMAIN) {
    throw new Error(`仅 @${ALLOWED_DOMAIN} 可登录`);
  }
  return { sub: decoded.sub, email: decoded.email || '', name: decoded.name || '' };
}

// JWT access token (1 hour)
function issueAccessToken(user) {
  return jwt.sign({ sub: user.sub, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' });
}

function verifyAccessToken(token) {
  try { return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); }
  catch { return null; }
}

// PKCE session store
function storePkceSession(state, codeChallenge, codeVerifier, redirectUri) {
  pkceSessions.set(state, { codeChallenge, codeVerifier, redirectUri, exp: Date.now() + 10 * 60 * 1000 });
}

function getAndDeletePkceSession(state) {
  const s = pkceSessions.get(state);
  if (s) pkceSessions.delete(state);
  return s;
}

// Auth codes (10 min TTL)
const authCodes = new Map();
function issueAuthCode(user, codeChallenge) {
  const code = generateTokenId();
  authCodes.set(code, { user, codeChallenge, exp: Date.now() + 10 * 60 * 1000 });
  return code;
}

function consumeAuthCode(code, codeVerifier) {
  const entry = authCodes.get(code);
  if (!entry || entry.exp < Date.now()) return null;
  const expected = generateCodeChallenge(codeVerifier);
  if (!crypto.timingSafeEqual(Buffer.from(entry.codeChallenge), Buffer.from(expected))) return null;
  authCodes.delete(code);
  return entry.user;
}

// OAuth metadata
function getOAuthMetadata() {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/mcp/authorize`,
    token_endpoint: `${BASE_URL}/mcp/token`,
    scopes_supported: ['openid', 'email', 'profile'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
  };
}

// MCP 鉴权中间件（Bearer Token、JWT、Google session 三合一）
const { findUserByToken } = require('../services/token');

async function mcpAuth(req, res, next) {
  // 1. Web session（Google OAuth 登录后）
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  // 2. Bearer Token（报销系统 API token）
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    // 先试 MCP JWT
    const jwtUser = verifyAccessToken(token);
    if (jwtUser) { req.user = jwtUser; return next(); }
    // 再试报销系统 API Token
    const apiUser = await findUserByToken(token);
    if (apiUser) { req.user = apiUser; return next(); }
  }
  res.status(401).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32001, message: '未认证' } });
}

module.exports = {
  generateCodeVerifier, generateCodeChallenge,
  getGoogleAuthUrl, handleGoogleCallback,
  issueAccessToken, verifyAccessToken,
  storePkceSession, getAndDeletePkceSession,
  issueAuthCode, consumeAuthCode,
  getOAuthMetadata, mcpAuth,
};
