// MCP (Model Context Protocol) 服务
// 为 Hermes 等智能体提供 tools 接口

const {
  submitReimbursement, listReimbursements, getReimbursement,
  getDashboardStats, addAuditLog, approveReimbursement, rejectReimbursement,
} = require('./reimbursement');

const MCP_TOOLS = [
  {
    name: 'submit_reimbursement',
    description: '提交一张新的报销单。智能体通过 API Token 鉴权后调用。',
    inputSchema: {
      type: 'object',
      properties: {
        submitterId: { type: 'string', description: '提交者邮箱' },
        submitterName: { type: 'string', description: '提交者名称' },
        amount: { type: 'number', description: '报销金额（人民币）' },
        description: { type: 'string', description: '报销事由描述' },
        category: { type: 'string', enum: ['general', 'transport', 'meal', 'office'], description: '报销类别' },
        attachments: { type: 'array', items: { type: 'object' }, description: '附件列表' },
      },
      required: ['submitterId', 'amount', 'description'],
    },
  },
  {
    name: 'query_reimbursements',
    description: '查询报销单列表，可按状态筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        submitterType: { type: 'string', enum: ['human', 'agent'] },
        submitterId: { type: 'string' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'get_reimbursement_detail',
    description: '获取单张报销单详情。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '报销单 ID' } },
      required: ['id'],
    },
  },
  {
    name: 'approve_reimbursement',
    description: '审批通过一张报销单。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        approverId: { type: 'string' },
        approverName: { type: 'string' },
        comment: { type: 'string' },
      },
      required: ['id', 'approverId'],
    },
  },
  {
    name: 'reject_reimbursement',
    description: '拒绝一张报销单。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        approverId: { type: 'string' },
        approverName: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['id', 'approverId', 'reason'],
    },
  },
  {
    name: 'get_dashboard_stats',
    description: '获取报销系统仪表盘统计信息。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleMcpRequest(request) {
  const { id, method, params } = request;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'esther-reimbursement-mcp', version: '3.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    let result;
    try {
      switch (name) {
        case 'submit_reimbursement': {
          result = await submitReimbursement({
            submitterType: 'agent',
            submitterId: args.submitterId,
            submitterName: args.submitterName || 'Hermes Agent',
            amount: args.amount,
            currency: 'CNY',
            category: args.category || 'general',
            description: args.description,
            attachments: args.attachments || [],
            metadata: { source: 'mcp', agent: 'hermes' },
          });
          await addAuditLog({
            action: 'mcp_submit', targetId: result.data?.id || null,
            actorId: args.submitterId, actorName: args.submitterName || 'Hermes',
            details: { args, success: result.success },
          });
          break;
        }
        case 'query_reimbursements':
          result = await listReimbursements({
            status: args.status, submitterType: args.submitterType,
            submitterId: args.submitterId, limit: args.limit || 20,
          });
          break;
        case 'get_reimbursement_detail':
          result = await getReimbursement(args.id);
          break;
        case 'approve_reimbursement':
          result = await approveReimbursement(args.id, args.approverId, args.approverName || 'Esther', args.comment || '');
          break;
        case 'reject_reimbursement':
          result = await rejectReimbursement(args.id, args.approverId, args.approverName || 'Esther', args.reason || '未说明');
          break;
        case 'get_dashboard_stats':
          result = { success: true, data: await getDashboardStats() };
          break;
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
      }
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

module.exports = { handleMcpRequest, MCP_TOOLS };
