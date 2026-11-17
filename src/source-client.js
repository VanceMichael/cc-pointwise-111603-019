import { connect } from 'node:net';

/**
 * 仅允许回环来源的 HTTP 客户端。
 *
 * 使用 node:net 直接发起 HTTP/1.1 请求，不经过全局代理（环境里的
 * HTTP_PROXY/HTTPS_PROXY 会让 fetch 把 127.0.0.1 请求也送向代理并超时），
 * 同时在构造期强制主机名为 127.0.0.1，保证来源边界不被环境配置改变。
 */
export class SourceClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local source required');
    if (address.protocol !== 'http:') throw new Error('local source must use http');
    this.baseUrl = address;
  }

  read(path) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) {
      return Promise.reject(new Error('source origin changed'));
    }
    const port = Number(address.port) || 80;
    const target = `${address.pathname}${address.search}`;
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      const chunks = [];
      const timer = setTimeout(() => {
        socket.destroy(new Error('source request timeout'));
      }, 2000);
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('end', () => {
        clearTimeout(timer);
        const response = Buffer.concat(chunks);
        if (response.length === 0) {
          reject(new Error(`source connection closed without response: ${target}`));
          return;
        }
        try {
          resolve(this.#parse(response, target));
        } catch (error) {
          reject(error);
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`,
      );
    });
  }

  #parse(buffer, path) {
    const text = buffer.toString('utf8');
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd === -1) throw new Error('malformed source response');
    const head = text.slice(0, headerEnd);
    const [statusLine, ...headerLines] = head.split('\r\n');
    const statusCode = Number(statusLine.split(' ')[1]);
    const headers = Object.fromEntries(headerLines.map((line) => {
      const index = line.indexOf(':');
      return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
    }));
    let body = buffer.subarray(headerEnd + 4);
    if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
      body = this.#dechunk(body);
    }
    if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
      throw new Error(`source ${statusCode}: ${path}`);
    }
    return {
      text: body.toString('utf8'),
      contentType: headers['content-type'] ?? null,
      etag: headers.etag ?? null,
      status: statusCode,
    };
  }

  #dechunk(buffer) {
    const parts = [];
    let offset = 0;
    while (offset < buffer.length) {
      const lineEnd = buffer.indexOf('\r\n', offset);
      if (lineEnd === -1) break;
      const size = parseInt(buffer.subarray(offset, lineEnd).toString('ascii').trim(), 16);
      if (!Number.isInteger(size) || size <= 0) break;
      const dataStart = lineEnd + 2;
      parts.push(buffer.subarray(dataStart, dataStart + size));
      offset = dataStart + size + 2; // 跳过数据块后的 CRLF
    }
    return Buffer.concat(parts);
  }
}
