// REST API 路由
// 所有 /api/* 接口支持两种鉴权:
//   1. Web session（Google 登录后自动带 cookie）
//   2. Bearer Token（Authorization: Bearer esther_xxx，用于 agent/skill 调用）

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { findUserByToken } = require('../services/token');
const { ocrInvoice } = require('../services/ocr');
const { uploadFile, downloadToTemp } = require('../services/r2');
const {
  submitReimbursement, approveReimbursement, rejectReimbursement,
  deleteReimbursement, listReimbursements, getReimbursement,
  getDashboardStats, listAuditLogs,
} = require('../services/reimbursement');
const auditMiddleware = require('../middleware/audit');

const router = express.Router();

// Multer: 内存缓冲（上传后直接推 R2，不落本地磁盘）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|webp|pdf)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// 辅助：把 multer 文件上传到 R2，然后 OCR
async function uploadAndOCR(files) {
  const results = [];
  for (const f of files) {
    const r2 = await uploadFile(f.buffer, f.originalname, f.mimetype);
    // 从 R2 下载到临时路径供 OCR 使用
    const tmpPath = await downloadToTemp(r2.key);
    let ocr;
    try {
      ocr = await ocrInvoice(tmpPath);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
    results.push({
      filename: r2.key,
      originalName: f.originalname,
      r2Url: r2.url,
      fileUrl: `/api/files/${r2.key}`,
      size: f.size,
      ocr,
    });
  }
  return results;
}

// ============ 鉴权中间件 ============
async function apiAuth(req, res, next) {
  // 1. Web session
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  // 2. Bearer Token
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const user = await findUserByToken(token);
    if (user) { req.user = user; return next(); }
  }
  res.status(401).json({ success: false, error: '未认证。Web 登录或使用 Bearer Token' });
}

// ============ 路由 ============

// 健康检查（无需鉴权）
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'esther-reimbursement', version: '3.0.0' });
});

// 汇率查询（无需鉴权）
router.get('/exchange-rate', async (req, res) => {
  try {
    const { getRatesForBase } = require('../services/exchange-rate');
    const base = req.query.base || 'USD';
    const result = await getRatesForBase(base);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 仪表盘
router.get('/dashboard', apiAuth, async (req, res) => {
  try { res.json({ success: true, data: await getDashboardStats() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 文件代理下载（鉴权后从 R2 拉取 → 流式返回）
router.get('/files/:key(*)', apiAuth, async (req, res) => {
  try {
    const { downloadStream } = require('../services/r2');
    const result = await downloadStream(req.params.key);
    res.setHeader('Content-Type', result.contentType);
    if (result.contentLength) res.setHeader('Content-Length', result.contentLength);
    result.stream.pipe(res);
  } catch (e) {
    if (e.name === 'NoSuchKey') return res.status(404).json({ success: false, error: '文件不存在' });
    res.status(500).json({ success: false, error: e.message });
  }
});

// 上传 + OCR（上传到 R2 → 下载临时文件 OCR → 返回结果 + R2 URL）
router.post('/ocr', apiAuth, upload.array('invoices', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: '请上传发票文件（JPG/PNG/WebP/PDF）' });
    }
    const results = await uploadAndOCR(req.files);
    res.json({ success: true, data: results });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 人工提交报销（上传发票到 R2 + 表单）
router.post('/reimbursements', apiAuth, upload.array('invoices', 5), auditMiddleware('submit_human'), async (req, res) => {
  try {
    // 上传文件到 R2
    const attachments = [];
    for (const f of (req.files || [])) {
      const r2 = await uploadFile(f.buffer, f.originalname, f.mimetype);
      attachments.push({
        filename: r2.key,
        originalName: f.originalname,
        r2Url: r2.url,
        fileUrl: `/api/files/${r2.key}`,
        size: f.size,
      });
    }

    const result = await submitReimbursement({
      submitterType: 'human',
      submitterId: req.user.email || req.body.submitterId,
      submitterName: req.user.name || req.body.submitterName,
      amount: parseFloat(req.body.amount),
      currency: req.body.currency || 'CNY',
      category: req.body.category || 'general',
      description: req.body.description || '',
      attachments,
      metadata: req.body.metadata ? JSON.parse(req.body.metadata) : {},
    });
    if (!result.success) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 智能体提交报销（JSON body，附件为已上传路径）
router.post('/reimbursements/agent', apiAuth, auditMiddleware('submit_agent'), async (req, res) => {
  try {
    const result = await submitReimbursement({
      submitterType: 'agent',
      submitterId: req.user.email || req.body.submitterId,
      submitterName: req.user.name || req.body.submitterName,
      amount: req.body.amount,
      currency: req.body.currency || 'CNY',
      category: req.body.category || 'general',
      description: req.body.description || '',
      attachments: req.body.attachments || [],
      metadata: { ...req.body.metadata, source: 'api' },
    });
    if (!result.success) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 查询列表
router.get('/reimbursements', apiAuth, async (req, res) => {
  try {
    const result = await listReimbursements({
      status: req.query.status,
      submitterType: req.query.submitterType,
      submitterId: req.query.submitterId,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 单条详情
router.get('/reimbursements/:id', apiAuth, async (req, res) => {
  try {
    const result = await getReimbursement(req.params.id);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 删除
router.delete('/reimbursements/:id', apiAuth, auditMiddleware('delete'), async (req, res) => {
  try {
    const result = await deleteReimbursement(req.params.id);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 修改（仅可改 pending 状态）
router.patch('/reimbursements/:id', apiAuth, auditMiddleware('update'), async (req, res) => {
  try {
    const { updateReimbursement } = require('../services/reimbursement');
    const result = await updateReimbursement(req.params.id, {
      amount: req.body.amount !== undefined ? parseFloat(req.body.amount) : undefined,
      category: req.body.category,
      description: req.body.description,
      metadata: req.body.metadata,
    });
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 审批通过
router.post('/reimbursements/:id/approve', apiAuth, auditMiddleware('approve'), async (req, res) => {
  try {
    const result = await approveReimbursement(
      req.params.id,
      req.user.email || req.body.approverId || 'esther',
      req.user.name || req.body.approverName || 'Esther',
      req.body.comment || ''
    );
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 审批拒绝
router.post('/reimbursements/:id/reject', apiAuth, auditMiddleware('reject'), async (req, res) => {
  try {
    const result = await rejectReimbursement(
      req.params.id,
      req.user.email || req.body.approverId || 'esther',
      req.user.name || req.body.approverName || 'Esther',
      req.body.reason || '未说明原因'
    );
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 审计日志
router.get('/audit-logs', apiAuth, async (req, res) => {
  try {
    const result = await listAuditLogs({
      targetId: req.query.targetId,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 50,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
