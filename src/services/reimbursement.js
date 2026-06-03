// 报销业务核心服务
// 约束: 单次 ≤150 CNY, 每月 ≤3 次, 仅 CNY

const { v4: uuidv4 } = require('uuid');
const store = require('../models/store');

const CONFIG = {
  MAX_AMOUNT_PER_REQUEST: 150,
  MAX_REQUESTS_PER_MONTH: 3,
  CURRENCY: 'CNY',
};

function monthKey(userId, date) {
  const d = new Date(date);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `count:${userId}:${ym}`;
}

function recordKey(id) { return `reimbursement:${id}`; }

async function getMonthlyCount(userId, date) {
  const val = await store.get(monthKey(userId, date));
  return val || 0;
}

async function submitReimbursement({
  submitterType, submitterId, submitterName,
  amount, currency = 'CNY', category = 'general',
  description = '', attachments = [], metadata = {},
}) {
  if (typeof amount !== 'number' || amount <= 0) {
    return { success: false, error: '金额必须为正数' };
  }
  if (amount > CONFIG.MAX_AMOUNT_PER_REQUEST) {
    return { success: false, error: `单次报销金额不得超过 ${CONFIG.MAX_AMOUNT_PER_REQUEST} ${CONFIG.CURRENCY}` };
  }
  if (currency !== 'CNY') {
    return { success: false, error: '当前仅支持人民币(CNY)报销' };
  }
  if (submitterType === 'human' && (!attachments || attachments.length === 0)) {
    return { success: false, error: '人工提交必须上传发票附件' };
  }

  const now = new Date().toISOString();
  const monthlyCount = await getMonthlyCount(submitterId, now);
  if (monthlyCount >= CONFIG.MAX_REQUESTS_PER_MONTH) {
    return { success: false, error: `本月报销额度已用完（最多 ${CONFIG.MAX_REQUESTS_PER_MONTH} 次）` };
  }

  const id = uuidv4();
  const record = {
    id,
    submitterType,
    submitterId,
    submitterName,
    amount,
    currency,
    category,
    description,
    attachments,
    status: 'pending',
    priority: submitterType === 'agent' ? 'high' : 'normal',
    createdAt: now,
    updatedAt: now,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectionReason: null,
    comment: null,
    metadata,
  };

  await store.set(recordKey(id), record);
  await store.incr(monthKey(submitterId, now));
  return { success: true, data: record };
}

async function approveReimbursement(id, approverId, approverName, comment = '') {
  const record = await store.get(recordKey(id));
  if (!record) return { success: false, error: '报销单不存在' };
  if (record.status !== 'pending') return { success: false, error: '该报销单已处理，无法重复审批' };

  const now = new Date().toISOString();
  record.status = 'approved';
  record.approvedBy = approverId;
  record.approvedByName = approverName;
  record.approvedAt = now;
  record.comment = comment;
  record.updatedAt = now;

  await store.set(recordKey(id), record);
  return { success: true, data: record };
}

async function rejectReimbursement(id, approverId, approverName, reason) {
  const record = await store.get(recordKey(id));
  if (!record) return { success: false, error: '报销单不存在' };
  if (record.status !== 'pending') return { success: false, error: '该报销单已处理，无法重复审批' };

  const now = new Date().toISOString();
  record.status = 'rejected';
  record.approvedBy = approverId;
  record.approvedByName = approverName;
  record.rejectionReason = reason;
  record.updatedAt = now;

  // 拒绝时退回月度额度
  const countKey = monthKey(record.submitterId, record.createdAt);
  const currentCount = await store.get(countKey);
  if (currentCount > 0) await store.set(countKey, currentCount - 1);

  await store.set(recordKey(id), record);
  return { success: true, data: record };
}

async function deleteReimbursement(id) {
  const record = await store.get(recordKey(id));
  if (!record) return { success: false, error: '报销单不存在' };
  await store.del(recordKey(id));
  return { success: true, data: { id, deleted: true } };
}

async function listReimbursements({ status, submitterType, submitterId, page = 1, limit = 20 } = {}) {
  let records = await store.list('reimbursement:');
  records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (status) records = records.filter(r => r.status === status);
  if (submitterType) records = records.filter(r => r.submitterType === submitterType);
  if (submitterId) records = records.filter(r => r.submitterId === submitterId);

  const total = records.length;
  const start = (page - 1) * limit;
  return { success: true, data: records.slice(start, start + limit), total, page, limit };
}

async function getReimbursement(id) {
  const record = await store.get(recordKey(id));
  if (!record) return { success: false, error: '报销单不存在' };
  return { success: true, data: record };
}

async function getDashboardStats() {
  const records = await store.list('reimbursement:');
  const pending = records.filter(r => r.status === 'pending');
  const approved = records.filter(r => r.status === 'approved');
  const rejected = records.filter(r => r.status === 'rejected');
  return {
    total: records.length,
    pending: pending.length,
    approved: approved.length,
    rejected: rejected.length,
    pendingAgent: pending.filter(r => r.submitterType === 'agent').length,
    pendingHuman: pending.filter(r => r.submitterType === 'human').length,
    totalAmountApproved: approved.reduce((s, r) => s + r.amount, 0),
    totalAmountPending: pending.reduce((s, r) => s + r.amount, 0),
  };
}

async function addAuditLog({ action, targetId, actorId, actorName, details }) {
  const id = uuidv4();
  const log = { id, action, targetId, actorId, actorName, details, timestamp: new Date().toISOString() };
  await store.set(`audit:${id}`, log);
  return log;
}

async function listAuditLogs({ targetId, page = 1, limit = 50 } = {}) {
  let logs = await store.list('audit:');
  logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (targetId) logs = logs.filter(l => l.targetId === targetId);
  const total = logs.length;
  const start = (page - 1) * limit;
  return { success: true, data: logs.slice(start, start + limit), total };
}

module.exports = {
  submitReimbursement, approveReimbursement, rejectReimbursement,
  deleteReimbursement, listReimbursements, getReimbursement,
  getDashboardStats, addAuditLog, listAuditLogs, CONFIG,
};
