// lib/md5.mjs
//
// B 站 WBI 签名需要 MD5，而模组的 client 入口运行在渲染进程：
//   - 不能用 crypto.subtle：WebCrypto 只提供 SHA-1/256/384/512，没有 MD5；
//   - 不能 import 裸模块名（规范第 5 节），装不了 npm 包。
// 所以内联一份纯 JS MD5。
//
// 已用 RFC 1321 全部标准测试向量校验（含 80 字符长串与 UTF-8 多字节）。

/** RFC 1321 定义的每轮左移位数。 */
const SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32)，即 RFC 1321 的 T 表。 */
const K = [];
for (let i = 0; i < 64; i += 1) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

/** UTF-8 编码。不用 TextEncoder，方便在没有宿主 API 的环境里做单元测试。 */
export const utf8Bytes = (str) => {
    const out = [];
    for (let i = 0; i < str.length; i += 1) {
        let code = str.charCodeAt(i);
        if (code < 0x80) {
            out.push(code);
        } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            const low = str.charCodeAt((i += 1));
            code = 0x10000 + ((code & 0x3ff) << 10) + (low & 0x3ff);
            out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        } else {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        }
    }
    return out;
};

/** 小写十六进制 MD5。 */
export const md5 = (input) => {
    const bytes = utf8Bytes(String(input));
    const bitLen = bytes.length * 8;
    // 末尾补 0x80、补零到 56 mod 64，再写 64 位小端长度
    const buffer = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
    buffer.set(bytes);
    buffer[bytes.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(buffer.length - 8, bitLen >>> 0, true);
    view.setUint32(buffer.length - 4, Math.floor(bitLen / 4294967296), true);

    let a = 0x67452301;
    let b = 0xefcdab89;
    let c = 0x98badcfe;
    let d = 0x10325476;
    const words = new Int32Array(16);

    for (let offset = 0; offset < buffer.length; offset += 64) {
        for (let i = 0; i < 16; i += 1) words[i] = view.getInt32(offset + i * 4, true);
        let [aa, bb, cc, dd] = [a, b, c, d];
        for (let i = 0; i < 64; i += 1) {
            let f;
            let g;
            if (i < 16) {
                f = (bb & cc) | (~bb & dd);
                g = i;
            } else if (i < 32) {
                f = (dd & bb) | (~dd & cc);
                g = (5 * i + 1) & 15;
            } else if (i < 48) {
                f = bb ^ cc ^ dd;
                g = (3 * i + 5) & 15;
            } else {
                f = cc ^ (bb | ~dd);
                g = (7 * i) & 15;
            }
            f = (f + aa + K[i] + words[g]) | 0;
            aa = dd;
            dd = cc;
            cc = bb;
            bb = (bb + ((f << SHIFTS[i]) | (f >>> (32 - SHIFTS[i])))) | 0;
        }
        a = (a + aa) | 0;
        b = (b + bb) | 0;
        c = (c + cc) | 0;
        d = (d + dd) | 0;
    }

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setInt32(0, a, true);
    outView.setInt32(4, b, true);
    outView.setInt32(8, c, true);
    outView.setInt32(12, d, true);
    return Array.from(out, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
