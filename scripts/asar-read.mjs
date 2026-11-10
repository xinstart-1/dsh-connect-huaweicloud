/**
 * 从 app.asar 里读一个文件（只读，不落盘）。
 *
 * 为什么自己写：客户端的 @deepseek-ai/dsh-client-* 包只存在于 app.asar 里，
 * 不在 profile 的 node_modules 里。想知道 `ctx.locale` 到底怎么解析语言，
 * 只能把它从归档里取出来读——猜测的形状（`{zh, en}` 还是 `{'zh-CN', …}`）
 * 正是这次英文界面的可能原因，猜错就会再改一轮。
 *
 * asar 格式：8 字节 pickle 头 → 头长度 → JSON 头（含每个文件的 size/offset）→ 数据区。
 * 数据区起点 = 8 + 头长度（按 4 字节对齐）。
 */

import { openSync, readSync, closeSync } from 'node:fs';

/** 解析 asar 头，返回 { header, dataOffset }。 */
export function readArchiveHeader(path) {
  const fd = openSync(path, 'r');
  try {
    // 布局（全部小端），实测字节：
    //   [0..3]    4                       外层 pickle 标记
    //   [4..7]    pickle 总长
    //   [8..11]   内层 pickle 长
    //   [12..15]  L = 头 JSON 的字节数
    //   [16..]    JSON 本体，共 L 字节
    // 数据区紧跟其后。偏移猜不得，所以先取 16 字节头再按 L 读。
    const headBuf = Buffer.alloc(16);
    readSync(fd, headBuf, 0, 16, null);

    const headerSize = headBuf.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerSize);
    readSync(fd, headerBuf, 0, headerSize, null);

    const header = JSON.parse(headerBuf.toString('utf8'));
    return { header, dataOffset: 16 + headerSize };
  } finally {
    closeSync(fd);
  }
}

/** 按归档内路径（`a/b/c`）取文件内容。 */
export function readArchiveFile(path, innerPath) {
  const { header, dataOffset } = readArchiveHeader(path);
  const parts = innerPath.split('/').filter((part) => part !== '');
  let node = header;
  for (const part of parts) {
    if (node.files === undefined || node.files[part] === undefined) return undefined;
    node = node.files[part];
  }
  if (node.files !== undefined) return undefined; // 是目录
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Number(node.size));
    readSync(fd, buf, 0, Number(node.size), dataOffset + Number(node.offset));
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** 列出归档里匹配某段路径的所有文件名（只到给定深度）。 */
export function listArchivePaths(path, needle) {
  const { header } = readArchiveHeader(path);
  const hits = [];
  const walk = (node, prefix) => {
    if (node.files === undefined) {
      if (prefix.includes(needle)) hits.push(prefix);
      return;
    }
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix === '' ? name : prefix + '/' + name);
  };
  walk(header, '');
  return hits;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('asar-read.mjs');

if (invokedDirectly) {
  const asarPath = process.argv[2];
  const needle = process.argv[3];
  if (asarPath === undefined) {
    console.error('用法：node scripts/asar-read.mjs <app.asar> [路径关键字]');
    process.exit(1);
  }
  if (needle === undefined) {
    const { header } = readArchiveHeader(asarPath);
    console.log(Object.keys(header.files).join('\n'));
  } else {
    for (const hit of listArchivePaths(asarPath, needle)) console.log(hit);
  }
}
