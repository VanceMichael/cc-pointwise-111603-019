import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 持久化 JSON 文档存储：写入采用临时文件 + 原子 rename，
 * 缺省文档由 defaultValue 决定，绝不把“文件不存在”解释成业务零值。
 */
export class JsonStore {
  constructor(path, defaultValue) {
    this.path = path;
    this.defaultValue = defaultValue;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(this.defaultValue);
      throw error;
    }
  }

  async save(document) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
