// 汇率服务 — 每日汇率获取
// 使用 open.er-api.com（免费，无需 key）

const fetch = require('node-fetch');

const EXCHANGE_API = 'https://open.er-api.com/v6/latest';

const rateCache = new Map();

async function getExchangeRate(fromCurrency, toCurrency = 'CNY') {
  if (fromCurrency === toCurrency) return { rate: 1, source: 'same' };

  const cacheKey = `${fromCurrency}:${toCurrency}`;
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 3600000) {
    return { rate: cached.rate, source: 'cache' };
  }

  try {
    const resp = await fetch(`${EXCHANGE_API}/${fromCurrency}`, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.result !== 'success') throw new Error('API result not success');
    const rate = json.rates?.[toCurrency];
    if (!rate) throw new Error(`no rate for ${toCurrency}`);

    rateCache.set(cacheKey, { rate, ts: Date.now() });
    return { rate, source: 'api' };
  } catch (e) {
    return { rate: null, source: 'error', error: e.message };
  }
}

// 获取所有可用汇率（供前端显示）
async function getRatesForBase(baseCurrency = 'USD') {
  try {
    const resp = await fetch(`${EXCHANGE_API}/${baseCurrency}`, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    return { success: true, data: { base: baseCurrency, rates: json.rates, updated: json.time_last_update_utc } };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { getExchangeRate, getRatesForBase };
