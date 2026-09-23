// GBK 编解码（基于 gbk-data.js 的 GBK_CHAR_TO_INT 表）。
//
// 设备槽位备注以 GBK 原始字节存取（与 Flutter 端 remark_codec 一致）。
// - gbkEncode(str) → Uint8Array：ASCII(<0x80) 1 字节，其余查表 2 字节，查不到抛错
// - gbkDecode(bytes) → str：自动去除尾部 0xFF 填充（设备补齐到 64 字节）
//   GBK lead 字节范围 0x81–0xFE，故 0xFF 不可能是合法 lead，去除无歧义。
(function () {
  const charToInt = window.GBK_CHAR_TO_INT || {};
  // 反向表：GBK 整数 → 字符
  const intToChar = {};
  for (const ch in charToInt) {
    intToChar[charToInt[ch]] = ch;
  }

  function gbkEncode(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const code = str.charCodeAt(i);
      if (code < 0x80) {
        out.push(code); // ASCII 单字节，与 GBK 一致
        continue;
      }
      // 代理对高位（emoji 等）：表里不会有，落到下面抛错
      const gbk = charToInt[ch];
      if (gbk == null) {
        throw new Error('包含设备无法 GBK 编码的字符: ' + ch);
      }
      out.push((gbk >> 8) & 0xFF, gbk & 0xFF);
    }
    return new Uint8Array(out);
  }

  function gbkDecode(bytes) {
    // 去尾部 0xFF 填充
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0xFF) end--;
    let s = '';
    for (let i = 0; i < end; i++) {
      const b = bytes[i];
      if (b < 0x80) {
        s += String.fromCharCode(b);
      } else {
        if (i + 1 >= end) break;
        const gbk = (b << 8) | bytes[i + 1];
        const ch = intToChar[gbk];
        s += ch != null ? ch : '?';
        i++;
      }
    }
    return s;
  }

  function gbkByteLength(str) {
    try {
      return gbkEncode(str).length;
    } catch (_) {
      return -1;
    }
  }

  window.GBK = { encode: gbkEncode, decode: gbkDecode, byteLength: gbkByteLength };
})();
