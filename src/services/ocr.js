// 火山 Ark OCR 服务
// 调用 doubao-vision 模型分析发票图片/PDF，返回结构化字段
// 不再支持 Tesseract（按 V3 简化）

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const ARK_API_KEY = () => process.env.ARK_API_KEY || '';
const ARK_MODEL = () => process.env.ARK_OCR_MODEL || 'doubao-1.5-vision-pro-250328';

const PROMPT = `你是一个专业的发票识别助手。请识别这张发票图片，提取以下字段并返回严格的 JSON（不要包含 markdown 代码块）：

{
  "amount": 数字, // 发票总金额（人民币元，不带货币符号）
  "date": "YYYY-MM-DD", // 开票日期
  "merchant": "商户名称",
  "description": "消费内容简述（10-30字）",
  "category": "general" | "transport" | "meal" | "office",
  "confidence": 0-1 之间的小数 // 你对识别结果的整体置信度
}

注意：
- 金额必须为数字类型，不要加引号
- 日期格式严格为 YYYY-MM-DD
- 类别根据商户/内容自动判断：餐饮=meal、交通=transport、办公用品=office、其他=general
- 如果发票模糊无法识别某字段，对应 confidence 应低于 0.5
- 只返回 JSON，不要其他任何文字`;

function fileToDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', pdf: 'pdf' };
  const mime = mimeMap[ext] || 'octet-stream';
  return `data:image/${mime};base64,${buf.toString('base64')}`;
}

async function ocrInvoice(filePath) {
  if (!ARK_API_KEY()) {
    return { success: false, error: 'ARK_API_KEY 未配置，无法调用火山 Ark OCR' };
  }
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `文件不存在: ${filePath}` };
  }

  const dataUrl = fileToDataUrl(filePath);

  const body = {
    model: ARK_MODEL(),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
    temperature: 0.1,
  };

  try {
    const resp = await fetch(ARK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ARK_API_KEY()}`,
      },
      body: JSON.stringify(body),
      timeout: 60000,
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return { success: false, error: `Ark API ${resp.status}: ${txt.slice(0, 500)}` };
    }

    const json = await resp.json();
    const content = json.choices?.[0]?.message?.content || '';
    // 抓 JSON（防止模型偶尔加了 ```json）
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return { success: false, error: `Ark 返回非 JSON: ${content.slice(0, 300)}`, raw: content };
    }
    let extracted;
    try {
      extracted = JSON.parse(match[0]);
    } catch (e) {
      return { success: false, error: `JSON 解析失败: ${e.message}`, raw: content };
    }

    return {
      success: true,
      data: {
        extracted,
        model: ARK_MODEL(),
        usage: json.usage || null,
      },
    };
  } catch (err) {
    return { success: false, error: `调用 Ark 失败: ${err.message}` };
  }
}

module.exports = { ocrInvoice };
