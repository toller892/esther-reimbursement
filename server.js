const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const apiRoutes = require('./src/routes/api');
const authModule = require('./src/routes/auth');
const { handleMcpRequest } = require('./src/services/mcp');

const app = express();
const PORT = process.env.PORT || 3459;
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// 从 PUBLIC_BASE_URL 推导 cookie path，确保子路径部署时 session 正常
const cookiePath = (process.env.PUBLIC_BASE_URL && new URL(process.env.PUBLIC_BASE_URL).pathname.replace(/\/+$/, '')) || '/';
app.use(session({
  secret: process.env.SESSION_SECRET || 'esther-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, path: cookiePath || '/' },
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(cors());
app.use(express.json());

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 认证
app.use('/auth', authModule.router);

// REST API
app.use('/api', apiRoutes);

// MCP JSON-RPC
app.post('/mcp', async (req, res) => {
  try {
    const response = await handleMcpRequest(req.body);
    res.json(response);
  } catch (err) {
    res.status(500).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32000, message: err.message } });
  }
});

// MCP SSE
const mcpClients = new Map();
app.get('/mcp/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const clientId = Date.now().toString();
  res.write(`event: endpoint\ndata: /mcp/message?clientId=${clientId}\n\n`);
  mcpClients.set(clientId, res);
  req.on('close', () => mcpClients.delete(clientId));
});
app.post('/mcp/message', async (req, res) => {
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

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`Esther Reimbursement V3 on http://localhost:${PORT}`);
  console.log(`Public URL: ${BASE}`);
  console.log(`Endpoints:`);
  console.log(`  Web  : ${BASE}/`);
  console.log(`  Auth : ${BASE}/auth/google`);
  console.log(`  API  : ${BASE}/api/reimbursements`);
  console.log(`  OCR  : ${BASE}/api/ocr`);
  console.log(`  MCP  : ${BASE}/mcp (JSON-RPC) | ${BASE}/mcp/sse (SSE)`);
  console.log(`  Dash : ${BASE}/api/dashboard`);
});
