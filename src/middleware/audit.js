// 审计中间件
const { addAuditLog } = require('../services/reimbursement');

function auditMiddleware(action) {
  return async (req, res, next) => {
    const originalSend = res.send.bind(res);
    res.send = async function (body) {
      res.send = originalSend;
      const result = originalSend(body);
      try {
        const actorId = req.user?.id || req.body?.approverId || req.headers['x-user-id'] || req.body?.submitterId || 'anonymous';
        const actorName = req.user?.name || req.body?.approverName || req.headers['x-user-name'] || req.body?.submitterName || actorId;
        const targetId = req.params?.id || req.body?.id || null;
        await addAuditLog({
          action,
          targetId,
          actorId,
          actorName,
          details: { method: req.method, path: req.path, responseStatus: res.statusCode },
        });
      } catch (e) {
        console.error('Audit log error:', e.message);
      }
      return result;
    };
    next();
  };
}

module.exports = auditMiddleware;
