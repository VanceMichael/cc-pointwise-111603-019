// 回环来源读取客户端。readTracked 在既有 read 之上支持 ETag/304：
// 304 表示来源版本未变化，调用方据此跳过重复入库。
export class TrackedSourceClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local source required');
    this.baseUrl = address;
  }

  async readTracked(path, { etag = null, timeoutMs = 2000 } = {}) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('source origin changed');
    // 同一个控制器覆盖响应头与正文读取：超时即中止整个操作，避免 body 挂起。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`source timeout: ${path}`)), timeoutMs);
    try {
      const headers = etag ? { 'if-none-match': etag } : {};
      const response = await fetch(address, { headers, signal: controller.signal });
      if (response.status === 304) {
        return { notModified: true, text: null, contentType: null, etag: response.headers.get('etag') };
      }
      if (!response.ok) throw new Error(`source ${response.status}: ${path}`);
      const text = await response.text();
      return {
        notModified: false,
        text,
        contentType: response.headers.get('content-type'),
        etag: response.headers.get('etag'),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
