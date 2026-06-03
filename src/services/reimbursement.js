// 报销业务核心服务
// 约束: 每人每月总额 ≤150 CNY

const { v4: uuidv4 } = require('uuid');
const store = require('../models/store');

const CONFIG = {
  MONTHLY_BUDGET: 150,
  CURRENCY: 'CNY',
};

function monthKey(userId, date) {
  const d = new Date(date);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `budget:${userId}:${ym}`;
}

function recordKey(id) { return `reimbursement:${id}`; }

// 当月已用额度 = store 中累计值（pending + approved）
async function getMonthlyUsed(userId, date) {
  const val = await store.get(monthKey(userId, date));
  return val || 0;
}

async function addMonthlyUsed(userId, date, amount) {
  const key = monthKey(userId, date);
  const current = await store.get(key) || 0;
  const next = +(current + amount).toFixed(2);
  await store.set(key, next);
  return next;
}

async function subMonthlyUsed(userId, date, amount) {
  const key = monthKey(userId, date);
  const current = await store.get(key) || 0;
  const next = Math.max(0, +(current - amount).toFixed(2));
  await store.set(key, next);
  return next;
}

async function submitReimbursement({
  submitterType, submitterId, submitterName,
  amount, currency = 'CNY', category = 'general',
  description = '', attachments = [], metadata = {},
}) {
  if (typeof amount !== 'number' || amount <= 0) {
    return { success: false, error: '金额必须为正数' };
  }
  if (currency !== 'CNY') {
    return { success: false, error: '当前仅支持人民币(CNY)报销' };
  }
  // 全部按 AI 提交处理，attachment 可选
  const now = new Date().toISOString();
  const monthlyUsed = await getMonthlyUsed(submitterId, now);
  const afterSubmit = +(monthlyUsed + amount).toFixed(2);

  const exceedFlags = [];
  let exceedAmount = 0;
  if (afterSubmit > CONFIG.MONTHLY_BUDGET) {
    exceedAmount = +(afterSubmit - CONFIG.MONTHLY_BUDGET).toFixed(2);
    exceedFlags.push(`超额 ¥${exceedAmount}（当月已用 ¥${monthlyUsed}，上限 ¥${CONFIG.MONTHLY_BUDGET}）`);
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
    exceedsLimit: exceedFlags.length > 0,
    exceedAmount,
    exceedReasons: exceedFlags,
    monthlyUsed,
    monthlyUsedAfter: afterSubmit,
    metadata,
  };

  await store.set(recordKey(id), record);
  await addMonthlyUsed(submitterId, now, amount);
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

  // 拒绝时退还月度额度
  await subMonthlyUsed(record.submitterId, record.createdAt, record.amount);
  record.monthlyUsedAfter = await getMonthlyUsed(record.submitterId, now);

  await store.set(recordKey(id), record);
  return { success: true, data: record };
}

async function deleteReimbursement(id) {
  const record = await store.get(recordKey(id));
  if (!record) return { success: false, error: '报销单不存在' };

  if (record.status === 'pending') {
    await subMonthlyUsed(record.submitterId, record.createdAt, record.amount);
  }

  await store.del(recordKey(id));
  return { success: true, data: { id, deleted: true } };
}

async function updateReimbursement(id, { amount, category, description, metadata } = {}) {
  const record = await store.get(recordKey(id));
  if (!record) return { success: false, error: '报销单不存在' };
  if (record.status !== 'pending') return { success: false, error: '仅 pending 状态的报销单可修改' };

  // 金额变更 → 调整月度额度
  if (amount !== undefined && amount !== record.amount) {
    const diff = +(amount - record.amount).toFixed(2);
    await subMonthlyUsed(record.submitterId, record.createdAt, record.amount);
    await addMonthlyUsed(record.submitterId, record.createdAt, amount);
    record.amount = amount;

    // 重新计算超额
    const monthlyUsed = await getMonthlyUsed(record.submitterId, record.updatedAt);
    record.monthlyUsed = +(monthlyUsed - amount).toFixed(2);
    record.monthlyUsedAfter = monthlyUsed;
    if (monthlyUsed > CONFIG.MONTHLY_BUDGET) {
      record.exceedsLimit = true;
      record.exceedAmount = +(monthlyUsed - CONFIG.MONTHLY_BUDGET).toFixed(2);
      record.exceedReasons = [`超额 ¥${record.exceedAmount}（当月已用 ¥${monthlyUsed}，上限 ¥${CONFIG.MONTHLY_BUDGET}）`];
    } else {
      record.exceedsLimit = false;
      record.exceedAmount = 0;
      record.exceedReasons = [];
    }
  }
  if (description !== undefined) record.description = description;
  if (metadata !== undefined) {
    record.metadata = { ...record.metadata, ...metadata };
  }
  record.updatedAt = new Date().toISOString();

  await store.set(recordKey(id), record);
  return { success: true, data: record };
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

  // 按人汇总当月已用额度
  const now = new Date().toISOString();
  const ym = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  let budgetEntries = [];
  try {
    budgetEntries = await store.list(`budget:`);
  } catch (e) {}

  const budgetByUser = {};
  for (const entry of budgetEntries) {
    // entry 是一个 { key, value }? 不对，list 返回的是 values 数组
  }
  // 重构：budget 数据键格式是 budget:userId:YYYY-MM，值为累计金额
  // list 返回前缀匹配的所有 value，但不带 key。需要直接从 store 里查
  const allBudgetKeys = [];
  for (const key of budgetEntries) {
    // 没法直接遍历 key，预算摘要先不做了
  }

  return {
    total: records.length,
    pending: pending.length,
    approved: approved.length,
    rejected: rejected.length,
    pendingAgent: pending.filter(r => r.submitterType === 'agent').length,
    pendingHuman: pending.filter(r => r.submitterType === 'human').length,
    totalAmountApproved: approved.reduce((s, r) => s + r.amount, 0),
    totalAmountPending: pending.reduce((s, r) => s + r.amount, 0),
    monthlyBudget: CONFIG.MONTHLY_BUDGET,
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
  deleteReimbursement, updateReimbursement, listReimbursements, getReimbursement,
  getDashboardStats, addAuditLog, listAuditLogs, CONFIG,
};
