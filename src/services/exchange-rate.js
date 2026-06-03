// 汇率服务 — 自动获取每日汇率
// 使用 Frankfurter API（免费，无需 key）：https://www.frankfurter.dev/

const fetch = require('node-fetch');

const EXCHANGE_API = 'https://api.frankfurter.dev/latest';

// 缓存：同一币种当天只请求一次
const rateCache = new Map();

async function getExchangeRate(fromCurrency, toCurrency = 'CNY') {
  if (fromCurrency === toCurrency) return { rate: 1, source: 'same' };

  const cacheKey = `${fromCurrency}:${toCurrency}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 3600000) { // 1小时缓存
    return { rate: cached.rate, source: 'cache' };
  }

  try {
    const resp = await fetch(`${EXCHANGE_API}?from=${fromCurrency}&to=${toCurrency}`, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const rate = json.rates?.[toCurrency];
    if (!rate) throw new Error(`no rate for ${toCurrency}`);

    rateCache.set(cacheKey, { rate, ts: Date.now() });
    return { rate, source: 'api' };
  } catch (e) {
    return { rate: null, source: 'error', error: e.message };
  }
}

module.exports = { getExchangeRate };
