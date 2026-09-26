/* ==========================================================================
   LynkLLM CE — 极简 ZIP 读写（零依赖）
   --------------------------------------------------------------------------
   备份包里的主要内容是图片 / 音频（本身就是已压缩格式）与 JSON，再做 deflate
   收益有限，因此写出时只使用 ZIP 的 STORE（method 0，不压缩）方式：
   代码量小、易于审计，且所有解压工具都能识别。

   写出：本地文件头 + 数据 + 中央目录 + EOCD（文件名带 UTF-8 标记，中文名安全）。
   读取：定位 EOCD → 遍历中央目录 → 按偏移取出数据块；
        同时兼容 method 8（deflate），借用浏览器原生的 DecompressionStream，
        这样用系统「压缩为 zip」重打过的包也能导入。

   仅浏览器环境使用（依赖 Blob / TextEncoder / DecompressionStream）。
   ========================================================================== */
(function (global) {
  'use strict';

  /** 单个备份包的体积上限（超出会先提示用户清理，避免把浏览器内存打爆） */
  const MAX_TOTAL = 400 * 1024 * 1024;
  /** ZIP 经典格式单个文件上限 4GiB */
  const MAX_ENTRY = 0xFFFFFFFF;

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;

  /* ---------- CRC32 ----------
     用 4 路查表（slicing-by-4），一次消化 4 字节，比逐字节快 2~3 倍。
     这一步是整个打包里唯一无法拆分的长任务（120MB 备份约需 1.3s），
     所以优化它比「想办法让出主线程」更直接。 */
  const CRC_T0 = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const CRC_T1 = new Uint32Array(256);
  const CRC_T2 = new Uint32Array(256);
  const CRC_T3 = new Uint32Array(256);
  (function () {
    for (let n = 0; n < 256; n++) {
      CRC_T1[n] = (CRC_T0[n] >>> 8) ^ CRC_T0[CRC_T0[n] & 0xFF];
      CRC_T2[n] = (CRC_T1[n] >>> 8) ^ CRC_T0[CRC_T1[n] & 0xFF];
      CRC_T3[n] = (CRC_T2[n] >>> 8) ^ CRC_T0[CRC_T2[n] & 0xFF];
    }
  })();

  function crc32(u8) {
    const n = u8.length;
    let c = 0xFFFFFFFF;
    let i = 0;
    const end = n - (n % 4);
    for (; i < end; i += 4) {
      c ^= u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24);
      c = CRC_T3[c & 0xFF] ^ CRC_T2[(c >>> 8) & 0xFF] ^ CRC_T1[(c >>> 16) & 0xFF] ^ CRC_T0[(c >>> 24) & 0xFF];
    }
    for (; i < n; i++) c = CRC_T0[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- 编码辅助 ---------- */
  function utf8(str) {
    if (global.TextEncoder) return new TextEncoder().encode(str);
    const esc = unescape(encodeURIComponent(str));
    const out = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }

  function utf8Decode(u8) {
    if (global.TextDecoder) return new TextDecoder('utf-8').decode(u8);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  /** dataURL（base64）→ 字节 */
  function dataUrlToBytes(dataUrl) {
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    if (comma < 0) return null;
    const meta = s.slice(0, comma);
    const body = s.slice(comma + 1);
    const mime = (meta.match(/^data:([^;,]+)/) || [])[1] || 'application/octet-stream';
    try {
      let bin;
      if (/;base64/i.test(meta)) bin = atob(body);
      else bin = decodeURIComponent(body);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return { mime, bytes: out };
    } catch (e) {
      return null;
    }
  }

  /** 字节 → dataURL */
  function bytesToDataUrl(u8, mime) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return 'data:' + (mime || 'application/octet-stream') + ';base64,' + btoa(bin);
  }

  /* ---------- 写出 ---------- */
  function dosTime(d) {
    const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date: date & 0xFFFF, time: time & 0xFFFF };
  }

  /**
   * 生成一个 ZIP Blob
   * @param {Array<{name:string, data:Uint8Array|string}>} files
   * @returns {Blob}
   */
  function create(files) {
    const list = (files || []).filter(f => f && f.name);
    let total = 0;
    const prepared = list.map(f => {
      const data = typeof f.data === 'string' ? utf8(f.data) : (f.data || new Uint8Array(0));
      if (data.length > MAX_ENTRY) throw new Error('entry-too-large');
      total += data.length;
      return { name: String(f.name), nameBytes: utf8(String(f.name)), data };
    });
    if (total > MAX_TOTAL) throw new Error('too-large');

    const { date, time } = dosTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;

    prepared.forEach(f => {
      const n = f.nameBytes.length;
      const crc = crc32(f.data);

      const local = new Uint8Array(30 + n);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, SIG_LOCAL, true);
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0x0800, true);      // 文件名使用 UTF-8
      lv.setUint16(8, 0, true);           // 存储方式：不压缩
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, f.data.length, true);
      lv.setUint32(22, f.data.length, true);
      lv.setUint16(26, n, true);
      lv.setUint16(28, 0, true);          // 无 extra
      local.set(f.nameBytes, 30);
      parts.push(local, f.data);

      const cen = new Uint8Array(46 + n);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, SIG_CENTRAL, true);
      cv.setUint16(4, 20, true);          // version made by
      cv.setUint16(6, 20, true);          // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, f.data.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, n, true);
      cv.setUint16(30, 0, true);          // extra
      cv.setUint16(32, 0, true);          // comment
      cv.setUint16(34, 0, true);          // 起始磁盘号
      cv.setUint16(36, 0, true);          // 内部属性
      cv.setUint32(38, 0, true);          // 外部属性
      cv.setUint32(42, offset, true);     // 本地头偏移
      cen.set(f.nameBytes, 46);
      central.push(cen);

      offset += local.length + f.data.length;
    });

    let cdSize = 0;
    central.forEach(c => { cdSize += c.length; });

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, SIG_EOCD, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, prepared.length, true);
    ev.setUint16(10, prepared.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  }

  /* ---------- 读取 ---------- */
  function inflateRaw(u8) {
    if (!global.DecompressionStream) return Promise.reject(new Error('deflate-unsupported'));
    const ds = new global.DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(ab => new Uint8Array(ab));
  }

  /**
   * 解析 ZIP
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<Array<{name:string, data:Uint8Array}>>}
   *   被截断 / 无法解压的条目会被丢弃（调用方据此统计“有多少附件没能还原”），
   *   而结构性损坏一律抛 `bad-archive`。
   */
  function read(arrayBuffer) {
    return Promise.resolve().then(() => {
      const u8 = new Uint8Array(arrayBuffer);
      const dv = new DataView(arrayBuffer);
      const len = u8.length;

      // 带边界检查的读取：包被损坏或下载不完整时，要给用户「不是有效备份包」，
      // 而不是让 DataView 抛出 RangeError 这种看不懂的异常。
      function u16(off) {
        if (off < 0 || off + 2 > len) throw new Error('bad-archive');
        return dv.getUint16(off, true);
      }
      function u32(off) {
        if (off < 0 || off + 4 > len) throw new Error('bad-archive');
        return dv.getUint32(off, true);
      }

      if (len < 22) throw new Error('not-zip');

      // 从末尾向前找 EOCD（注释最长 65535）
      const floor = Math.max(0, len - 22 - 0xFFFF);
      let eocd = -1;
      for (let i = len - 22; i >= floor; i--) {
        if (u32(i) === SIG_EOCD) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('not-zip');

      const count = u16(eocd + 10);
      let p = u32(eocd + 16);
      const entries = [];

      for (let i = 0; i < count; i++) {
        if (u32(p) !== SIG_CENTRAL) throw new Error('bad-archive');
        const method = u16(p + 10);
        const compSize = u32(p + 20);
        const uncompSize = u32(p + 24);
        const nameLen = u16(p + 28);
        const extraLen = u16(p + 30);
        const commentLen = u16(p + 32);
        const localOff = u32(p + 42);
        const name = utf8Decode(u8.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;

        if (u32(localOff) !== SIG_LOCAL) throw new Error('bad-entry');
        const lNameLen = u16(localOff + 26);
        const lExtraLen = u16(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = u8.slice(start, start + compSize);

        entries.push({
          name,
          method,
          uncompSize,
          raw,
          // 声明的大小与实际取到的字节数不一致 → 包体被截断
          truncated: raw.length !== compSize
        });
      }

      // 解压（绝大多数条目是 store，直接可用）
      return entries.reduce((chain, e) => chain.then(list => {
        if (e.truncated) return list;                 // 截断条目丢弃，由调用方统计
        if (e.method === 0) {
          list.push({ name: e.name, data: e.raw });
          return list;
        }
        if (e.method === 8) {
          return inflateRaw(e.raw).then(data => {
            // 解出来的长度与声明不符同样视为损坏
            if (data.length === e.uncompSize) list.push({ name: e.name, data });
            return list;
          }).catch(() => list);                       // 单条解压失败不该让整包失败
        }
        // 其他压缩方式（bzip2 等）不在支持下，跳过而不是整体失败
        return list;
      }), Promise.resolve([]));
    });
  }

  global.Zip = {
    create,
    read,
    crc32,
    dataUrlToBytes,
    bytesToDataUrl,
    MAX_TOTAL
  };
})(window);
