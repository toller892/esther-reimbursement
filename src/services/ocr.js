// 火山 Ark OCR 服务
// - 检测 PDF 自动转 PNG（pdftoppm）再喂给 vision 模型
// - 支持 JPG/PNG/WebP/PDF

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const ARK_API_KEY = () => process.env.ARK_API_KEY || '';
const ARK_MODEL = () => process.env.ARK_OCR_MODEL || 'doubao-seed-1-6-vision-250815';

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

// PDF -> PNG (第一页 200dpi)，返回临时 PNG 路径
function pdfToPng(pdfPath) {
  const outBase = path.join(os.tmpdir(), `pdf-${Date.now()}-${Math.random().toString(36).slice(2,8)}`);
  try {
    execSync(`pdftoppm -png -r 200 -f 1 -l 1 "${pdfPath}" "${outBase}"`, { timeout: 30000 });
    // pdftoppm 输出 outBase-1.png 或 outBase-01.png
    const candidates = [`${outBase}-1.png`, `${outBase}-01.png`];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error('pdftoppm 未生成 PNG');
  } catch (e) {
    throw new Error(`PDF 转 PNG 失败: ${e.message}`);
  }
}

function fileToDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };
  const mime = mimeMap[ext];
  if (!mime) throw new Error(`不支持的图片格式: ${ext}`);
  return `data:image/${mime};base64,${buf.toString('base64')}`;
}

async function ocrInvoice(filePath) {
  if (!ARK_API_KEY()) {
    return { success: false, error: 'ARK_API_KEY 未配置，无法调用火山 Ark OCR' };
  }
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `文件不存在: ${filePath}` };
  }

  // PDF 先转 PNG
  let imgPath = filePath;
  let tmpPng = null;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    try {
      tmpPng = pdfToPng(filePath);
      imgPath = tmpPng;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  try {
    const dataUrl = fileToDataUrl(imgPath);
    const body = {
      model: ARK_MODEL(),
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: PROMPT },
        ],
      }],
      temperature: 0.1,
    };

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
        sourceType: ext === '.pdf' ? 'pdf->png' : 'image',
        usage: json.usage || null,
      },
    };
  } catch (err) {
    return { success: false, error: `调用 Ark 失败: ${err.message}` };
  } finally {
    // 清理临时 PNG
    if (tmpPng && fs.existsSync(tmpPng)) {
      try { fs.unlinkSync(tmpPng); } catch (e) {}
    }
  }
}

module.exports = { ocrInvoice };
