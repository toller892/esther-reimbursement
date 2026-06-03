// API Token 工具
// 策略 A: 每个 Google 账号一个稳定 Token = HMAC-SHA256(userId + version, TOKEN_SECRET).slice(0,40)
// version 存在 KV: token_version:<userId>，重置 Token 时 +1
// 校验: 给定一个 Bearer token，遍历所有已注册用户，找到能匹配的那个 userId

const crypto = require('crypto');
const store = require('../models/store');

const SECRET = () => process.env.TOKEN_SECRET || 'change-me-token-secret';
const PREFIX = 'esther_';

async function getVersion(userId) {
  const v = await store.get(`token_version:${userId}`);
  return v === null ? 1 : v;
}

async function bumpVersion(userId) {
  const v = await getVersion(userId);
  await store.set(`token_version:${userId}`, v + 1);
  return v + 1;
}

function compute(userId, version) {
  const h = crypto.createHmac('sha256', SECRET())
    .update(`${userId}|${version}`)
    .digest('hex');
  return PREFIX + h.slice(0, 40);
}

async function getTokenForUser(userId) {
  const v = await getVersion(userId);
  return compute(userId, v);
}

async function resetTokenForUser(userId) {
  await bumpVersion(userId);
  return getTokenForUser(userId);
}

// 注册用户档案（首次登录调用），便于反向查找 token -> user
async function registerUser(user) {
  const key = `user:${user.id}`;
  const existing = await store.get(key);
  if (!existing) {
    await store.set(key, {
      id: user.id,
      email: user.email,
      name: user.name,
      photo: user.photo || '',
      provider: user.provider || 'google',
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    });
  } else {
    existing.lastLoginAt = new Date().toISOString();
    existing.name = user.name;
    existing.photo = user.photo || existing.photo;
    await store.set(key, existing);
  }
}

async function listUsers() {
  return store.list('user:');
}

// 反查：给定 token，找到对应 userId
async function findUserByToken(token) {
  if (!token || !token.startsWith(PREFIX)) return null;
  const users = await listUsers();
  for (const u of users) {
    const expected = await getTokenForUser(u.id);
    if (expected === token) return u;
  }
  return null;
}

module.exports = {
  getTokenForUser,
  resetTokenForUser,
  registerUser,
  findUserByToken,
  listUsers,
};
