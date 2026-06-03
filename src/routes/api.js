// REST API 路由
// 所有 /api/* 接口支持两种鉴权:
//   1. Web session（Google 登录后自动带 cookie）
//   2. Bearer Token（Authorization: Bearer esther_xxx，用于 agent/skill 调用）

const express = require('express');
const multer = require('multer');
const path = require('path');
const { findUserByToken } = require('../services/token');
const { ocrInvoice } = require('../services/ocr');
const {
  submitReimbursement, approveReimbursement, rejectReimbursement,
  deleteReimbursement, listReimbursements, getReimbursement,
  getDashboardStats, listAuditLogs,
} = require('../services/reimbursement');
const auditMiddleware = require('../middleware/audit');

const router = express.Router();

// Multer: 上传发票（JPG/PNG/WebP/PDF）
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|webp|pdf)$/i.test(file.originalname);
    cb(null, ok);
  },
});

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

// 仪表盘
router.get('/dashboard', apiAuth, async (req, res) => {
  try { res.json({ success: true, data: await getDashboardStats() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 上传 + OCR（一步到位：上传文件 → OCR → 返回识别结果）
router.post('/ocr', apiAuth, upload.array('invoices', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: '请上传发票文件（JPG/PNG/WebP/PDF）' });
    }
    const results = [];
    for (const f of req.files) {
      const ocr = await ocrInvoice(f.path);
      results.push({
        filename: f.filename,
        originalName: f.originalname,
        path: `/uploads/${f.filename}`,
        size: f.size,
        ocr,
      });
    }
    res.json({ success: true, data: results });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 人工提交报销（上传发票 + 表单）
router.post('/reimbursements', apiAuth, upload.array('invoices', 5), auditMiddleware('submit_human'), async (req, res) => {
  try {
    const attachments = (req.files || []).map(f => ({
      filename: f.filename,
      originalName: f.originalname,
      path: `/uploads/${f.filename}`,
      size: f.size,
    }));

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
