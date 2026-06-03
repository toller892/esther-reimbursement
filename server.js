const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const apiRoutes = require('./src/routes/api');
const authModule = require('./src/routes/auth');
const { handleMcpRequest } = require('./src/services/mcp');
const {
  getOAuthMetadata, getGoogleAuthUrl, handleGoogleCallback,
  storePkceSession, getAndDeletePkceSession,
  issueAccessToken, issueAuthCode, consumeAuthCode,
  generateCodeVerifier, generateCodeChallenge, mcpAuth,
} = require('./src/services/mcp-oauth');

const app = express();
const PORT = process.env.PORT || 3459;
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

app.use(session({
  secret: process.env.SESSION_SECRET || 'esther-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, path: '/' },
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(cors());
app.use(express.json());

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 认证
app.use('/auth', authModule.router);

// REST API
app.use('/api', apiRoutes);

// ─── MCP OAuth 端点 ────────────────────────────────────────────────

// OAuth metadata
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(getOAuthMetadata());
});

// OAuth authorize → Google 登录
app.get('/mcp/authorize', (req, res) => {
  const redirectUri = req.query.redirect_uri || '';
  const codeChallenge = req.query.code_challenge || '';
  const state = req.query.state || '';
  if (!codeChallenge) return res.status(400).json({ error: 'missing code_challenge' });
  const pkceState = state || require('crypto').randomUUID();
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  storePkceSession(pkceState, codeChallenge, verifier, redirectUri);
  const url = getGoogleAuthUrl(pkceState, challenge);
  res.redirect(302, url);
});

// Google OAuth 回调
app.get('/mcp/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).json({ error: 'access_denied' });
  if (!code || !state) return res.status(400).json({ error: 'missing code or state' });
  try {
    const session = getAndDeletePkceSession(state);
    if (!session) return res.status(400).json({ error: 'session expired' });
    const user = await handleGoogleCallback(code, session.codeVerifier);
    const authCode = issueAuthCode(user, session.codeChallenge);
    if (session.redirectUri) {
      const url = new URL(session.redirectUri);
      url.searchParams.set('code', authCode);
      if (state) url.searchParams.set('state', state);
      res.redirect(302, url.toString());
    } else {
      res.json({ code: authCode, message: 'Copy this code to your MCP client' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Token 交换
app.post('/mcp/token', async (req, res) => {
  const { code, code_verifier } = req.body || {};
  if (!code || !code_verifier) return res.status(400).json({ error: 'missing code or code_verifier' });
  const user = consumeAuthCode(code, code_verifier);
  if (!user) return res.status(400).json({ error: 'invalid code or verifier' });
  const accessToken = issueAccessToken(user);
  res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 });
});

// ─── MCP JSON-RPC（鉴权保护）───────────────────────────────────────

app.post('/mcp', mcpAuth, async (req, res) => {
  try {
    const response = await handleMcpRequest(req.body);
    res.json(response);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32000, message: err.message } });
  }
});

// MCP SSE（鉴权保护）
const mcpClients = new Map();
app.get('/mcp/sse', mcpAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const clientId = Date.now().toString();
  res.write(`event: endpoint\ndata: /mcp/message?clientId=${clientId}\n\n`);
  mcpClients.set(clientId, res);
  req.on('close', () => mcpClients.delete(clientId));
});
app.post('/mcp/message', mcpAuth, async (req, res) => {
  const clientId = req.query.clientId;
  try {
    const response = await handleMcpRequest(req.body);
    const sse = mcpClients.get(clientId);
    if (sse) sse.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    res.json(response);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32000, message: err.message } });
  }
});

// 用户文档页
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`FeedmobAI Reimbursement V3 on http://localhost:${PORT}`);
  console.log(`Public URL: ${BASE}`);
  console.log(`  Web  : ${BASE}/`);
  console.log(`  Auth : ${BASE}/auth/google`);
  console.log(`  MCP  : ${BASE}/mcp (JSON-RPC, OAuth + Bearer)`);
  console.log(`  API  : ${BASE}/api/reimbursements`);
});
