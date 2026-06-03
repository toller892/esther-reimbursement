// Cloudflare R2 存储服务
// S3 兼容 API — 存储发票文件（PDF/图片），返回公开 URL

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'html-screenshots';
const R2_PUBLIC = process.env.R2_PUBLIC_URL || '';

// 报销专用前缀，避免和 page-publisher 冲突
const PREFIX = 'reimbursement/';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

// 上传文件 buffer → R2，返回 { key, url }
async function uploadFile(buffer, originalName, mimeType) {
  const ext = originalName.split('.').pop() || 'bin';
  const hash = crypto.randomBytes(8).toString('hex');
  const ts = Date.now();
  const key = `${PREFIX}${ts}-${hash}-${originalName}`;

  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));

  const url = R2_PUBLIC ? `${R2_PUBLIC}/${key}` : key;
  return { key, url, size: buffer.length };
}

// 从 R2 下载文件 → 本地临时路径
const fs = require('fs');
const path = require('path');
const os = require('os');

async function downloadToTemp(key) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
  }));

  const tmpPath = path.join(os.tmpdir(), `r2-${Date.now()}-${path.basename(key)}`);
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  fs.writeFileSync(tmpPath, Buffer.concat(chunks));
  return tmpPath;
}

// 下载为流 → 直接 pipe 到 HTTP response（不落盘）
async function downloadStream(key) {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  const response = await s3.send(cmd);
  return {
    stream: response.Body,
    contentType: response.ContentType || 'application/octet-stream',
    contentLength: response.ContentLength,
  };
}

module.exports = { uploadFile, downloadToTemp, downloadStream };
