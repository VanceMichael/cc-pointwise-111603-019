import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 原子写入的 JSON 文档仓库，用于观测版本库与评估日志。
export class JsonRepository {
  constructor(path, rootKey) {
    this.path = path;
    this.rootKey = rootKey;
  }

  async read() {
    try {
      const document = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(document[this.rootKey])) {
        throw new Error(`${this.path} has no ${this.rootKey} array`);
      }
      return structuredClone(document[this.rootKey]);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async replace(rows) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ [this.rootKey]: rows }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}

// 只追加的 JSON Lines 仓库，用于已发农户提示依据（forecast ledger）。
// 没有替换/删除接口：已发记录不能随当前校准升级或来源撤回被改写。
export class JsonlAppendRepository {
  constructor(path) {
    this.path = path;
  }

  async readAll() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return text.split('\n').filter((line) => line.trim() !== '').map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${this.path} line ${index + 1} is not valid JSON`);
      }
    });
  }

  async append(row) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(row)}\n`, { flag: 'a' });
  }
}
