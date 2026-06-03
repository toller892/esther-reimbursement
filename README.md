# FeedmobAI 报销系统 V3

Web + REST API + MCP 三合一报销系统。支持 Google OAuth 登录、Bearer Token API 鉴权、火山 Ark OCR 发票识别。

仅限 `@feedmob.com` 邮箱访问。

## 功能

- **Web 界面**: Google 登录 → 仪表盘 → OCR 提交报销 → 列表审批 → Token 管理
- **REST API**: Bearer Token 鉴权，完整 CRUD + OCR + 审批
- **MCP**: JSON-RPC + SSE 双入口，6 个 tools，供 Hermes 等智能体调用
- **OCR**: 火山 Ark (doubao-1.5-vision-pro) 发票识别
- **持久化**: JSON 文件存储，重启不丢数据

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 Google OAuth 凭证和 Ark API Key

# 3. 启动
npm start
```

## 环境变量

| 变量 | 说明 | 必填 |
|---|---|---|
| `PORT` | 服务端口，默认 3459 | 否 |
| `PUBLIC_BASE_URL` | 公网 URL（影响 OAuth callback） | 是 |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | 是 |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | 是 |
| `GOOGLE_CALLBACK_URL` | OAuth 回调 URL | 是 |
| `ALLOWED_DOMAIN` | 允许登录的邮箱域名，如 `feedmob.com` | 否 |
| `SESSION_SECRET` | Session 加密密钥 | 是 |
| `TOKEN_SECRET` | API Token 派生密钥 | 是 |
| `ARK_API_KEY` | 火山 Ark API Key（OCR） | 是 |
| `ARK_OCR_MODEL` | OCR 模型名，默认 doubao-1.5-vision-pro-250328 | 否 |
| `DATA_FILE` | 数据存储文件路径 | 否 |
| `UPLOAD_DIR` | 上传文件目录 | 否 |

## API 接口

### 鉴权

所有 `/api/*` 接口需要认证：
- **Web 登录**: Google OAuth 自动带 session cookie
- **API 调用**: `Authorization: Bearer <token>`

Token 在 Web 登录后「🔑 API Token」页面获取。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（无需鉴权） |
| GET | `/api/dashboard` | 仪表盘统计 |
| POST | `/api/ocr` | 上传发票 OCR 识别 |
| POST | `/api/reimbursements` | 人工提交（multipart，带发票文件） |
| POST | `/api/reimbursements/agent` | 智能体提交（JSON body） |
| GET | `/api/reimbursements` | 查询列表（?status=pending&limit=20） |
| GET | `/api/reimbursements/:id` | 单条详情 |
| DELETE | `/api/reimbursements/:id` | 删除 |
| POST | `/api/reimbursements/:id/approve` | 审批通过 |
| POST | `/api/reimbursements/:id/reject` | 审批拒绝 |
| GET | `/api/audit-logs` | 审计日志 |

### MCP

- JSON-RPC: `POST /mcp`
- SSE: `GET /mcp/sse`

Tools: `submit_reimbursement`, `query_reimbursements`, `get_reimbursement_detail`, `approve_reimbursement`, `reject_reimbursement`, `get_dashboard_stats`

## 约束

- 单次报销上限: 150 CNY
- 每月报销次数: 3 次
- 文件大小限制: 10MB
- 支持格式: JPG/PNG/WebP/PDF
- 仅支持 CNY

## 部署

服务器: `ubuntu@3.15.32.167`
端口: 3459
域名: `https://www.html.living/reimbursement/`

```bash
# 更新代码
cd /home/ubuntu/feedmobai-reimbursement
git pull && npm install
sudo systemctl restart feedmobai-reimbursement

# 查看日志
sudo journalctl -u feedmobai-reimbursement -f
```

## License

MIT
