// KV 存储 — JSON 文件持久化版本
// 所有写操作都会同步落盘到 DATA_FILE（默认 ./data/store.json）
// 启动时若文件存在则加载，不存在则空 Map 起步

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', '..', 'data', 'store.json');

class KVStore {
  constructor(file) {
    this.file = file;
    this.data = new Map();
    this._loaded = false;
    this._saving = false;
    this._pendingSave = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) {
          this.data.set(k, v);
        }
        console.log(`[store] loaded ${this.data.size} keys from ${this.file}`);
      } else {
        const dir = path.dirname(this.file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        console.log(`[store] no existing file at ${this.file}, starting empty`);
      }
      this._loaded = true;
    } catch (e) {
      console.error(`[store] load error: ${e.message}, starting empty`);
      this._loaded = true;
    }
  }

  // 防止并发写冲突：正在写时把新的请求合并为一次
  async _save() {
    if (this._saving) {
      this._pendingSave = true;
      return;
    }
    this._saving = true;
    try {
      const obj = {};
      for (const [k, v] of this.data.entries()) obj[k] = v;
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[store] save error: ${e.message}`);
    } finally {
      this._saving = false;
      if (this._pendingSave) {
        this._pendingSave = false;
        this._save();
      }
    }
  }

  async get(key) {
    const v = this.data.get(key);
    return v === undefined ? null : v;
  }

  async set(key, value) {
    this.data.set(key, value);
    await this._save();
    return true;
  }

  async del(key) {
    this.data.delete(key);
    await this._save();
    return true;
  }

  async list(prefix) {
    const results = [];
    for (const [k, v] of this.data.entries()) {
      if (k.startsWith(prefix)) results.push(v);
    }
    return results;
  }

  async incr(key) {
    let val = await this.get(key);
    if (val === null) val = 0;
    val = (typeof val === 'number' ? val : 0) + 1;
    await this.set(key, val);
    return val;
  }
}

const store = new KVStore(DATA_FILE);

module.exports = store;
