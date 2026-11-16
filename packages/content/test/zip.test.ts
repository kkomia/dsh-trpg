import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  ZIP_LIMITS,
  ZipError,
  crc32,
  normalizeEntryPath,
  readZip,
  writeZip,
} from '../src/zip.ts';
import {
  canonicalJsonBytes,
  contentHashOfPack,
  decodePackZip,
  encodePackZip,
  packHashOfBytes,
  packToTrpgpack,
  trpgpackFileName,
  trpgpackToPack,
} from '../src/pack-zip.ts';
import { CORE_GUIMUYA_PACK, PackValidationError, type ContentPack } from '../src/index.ts';

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

function clonePack(): ContentPack {
  return JSON.parse(JSON.stringify(CORE_GUIMUYA_PACK)) as ContentPack;
}

function findSignature(bytes: Uint8Array, signature: readonly number[], from = 0): number {
  outer: for (let index = from; index <= bytes.length - signature.length; index += 1) {
    for (let offset = 0; offset < signature.length; offset += 1) {
      if (bytes[index + offset] !== signature[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

interface RawZipEntry {
  name: string;
  data?: Uint8Array;
  method?: number;
  flags?: number;
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
}

/** 手写一个「只为读取侧测试服务」的 zip（可故意造非法字段）。 */
function buildRawZip(entries: readonly RawZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const compressedSize = entry.compressedSize ?? data.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const crc = entry.crc ?? crc32(data);
    const flags = entry.flags ?? 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, Buffer.from(data));
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralDirectory, eocd]));
}

function zipErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ZipError && error.code === code;
}

test('zip: writeZip/readZip roundtrip，stored 与 deflate 都保留原字节与 CRC', () => {
  const hello = bytesOf('hello zip');
  const binary = new Uint8Array([0, 1, 2, 255, 254, 128]);
  const zipBytes = writeZip([
    { name: 'pack.json', data: hello, method: 'deflate' },
    { name: 'assets/stored.bin', data: binary, method: 'stored' },
    { name: 'assets/deflated.txt', data: hello, method: 'deflate' },
  ]);
  const { entries, warnings } = readZip(zipBytes);
  assert.equal(entries.size, 3);
  assert.deepEqual(warnings, []);
  assert.deepEqual([...entries.get('pack.json')!.data], [...hello]);
  assert.equal(entries.get('assets/stored.bin')?.method, 0);
  assert.deepEqual([...entries.get('assets/stored.bin')!.data], [...binary]);
  assert.equal(entries.get('assets/deflated.txt')?.method, 8);
  assert.deepEqual([...entries.get('assets/deflated.txt')!.data], [...hello]);
  assert.equal(entries.get('pack.json')?.crc32, crc32(hello));
});

test('zip: 手写 stored / deflate 两种 zip 读取都支持', () => {
  const raw = bytesOf('手写 deflate 条目。'.repeat(20));
  const deflated = new Uint8Array(deflateRawSync(Buffer.from(raw)));
  const storedZip = buildRawZip([{ name: 'pack.json', data: bytesOf('{"schemaVersion":"trpg.pack/1"}') }]);
  assert.deepEqual(
    [...readZip(storedZip).entries.get('pack.json')!.data],
    [...bytesOf('{"schemaVersion":"trpg.pack/1"}')],
  );
  const deflateZip = buildRawZip([
    { name: 'assets/text.txt', data: deflated, method: 8, uncompressedSize: raw.length, crc: crc32(raw) },
  ]);
  const entry = readZip(deflateZip).entries.get('assets/text.txt');
  assert.ok(entry);
  assert.deepEqual([...entry.data], [...raw]);
  assert.equal(entry.uncompressedSize, raw.length);
});

test('zip: 导出时间戳/UTF-8 标志/顺序固定，同一 pack 字节可复现', () => {
  const first = packToTrpgpack(CORE_GUIMUYA_PACK);
  const second = packToTrpgpack(CORE_GUIMUYA_PACK);
  assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0, '同一 pack 两次导出必须字节一致');

  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800, '必须带 UTF-8 文件名标志');
  assert.equal(view.getUint16(10, true), 0, 'DOS 时间固定 00:00:00');
  assert.equal(view.getUint16(12, true), 33, 'DOS 日期固定 1980-01-01');
  assert.equal(view.getUint16(28, true), 0, '不写 extra field');
  const firstNameLength = view.getUint16(26, true);
  assert.equal(Buffer.from(first.subarray(30, 30 + firstNameLength)).toString('utf8'), 'pack.json');
  assert.equal(trpgpackFileName(CORE_GUIMUYA_PACK), 'core-guimuya-1.0.0.trpgpack');
});

test('pack-zip: 解码 → 重导出字节一致，contentHash/packHash 稳定', () => {
  const bytes = packToTrpgpack(CORE_GUIMUYA_PACK);
  const decoded = trpgpackToPack(bytes);
  assert.equal(decoded.ok, true, decoded.errors.join('\n'));
  assert.equal(decoded.contentHash, contentHashOfPack(CORE_GUIMUYA_PACK));
  assert.equal(decoded.packHash, packHashOfBytes(bytes));
  assert.ok(decoded.pack);
  const reencoded = packToTrpgpack(decoded.pack, { assets: decoded.assets });
  assert.equal(Buffer.compare(Buffer.from(reencoded), Buffer.from(bytes)), 0);
  assert.equal(decodePackZip(bytes).ok, true);
  assert.equal(encodePackZip(CORE_GUIMUYA_PACK).length, bytes.length);
});

test('zip: CRC 损坏被拒（错误信息带 CRC 与条目号）', () => {
  const bytes = packToTrpgpack(CORE_GUIMUYA_PACK);
  const centralOffset = findSignature(bytes, [0x50, 0x4b, 0x01, 0x02]);
  assert.ok(centralOffset >= 0, '应能定位中央目录');
  bytes[centralOffset + 16] = ((bytes[centralOffset + 16] as number) ^ 0xff) & 0xff;
  assert.throws(() => readZip(bytes), zipErrorCode('crc'));
  const decoded = trpgpackToPack(bytes);
  assert.equal(decoded.ok, false);
  assert.match(decoded.errors.join('\n'), /CRC 校验失败/);
});

test('zip: 路径穿越 / 绝对路径 / 盘符 / 控制字符被拒', () => {
  for (const name of ['../evil.txt', 'assets/../../evil.png', '/etc/passwd', 'C:/evil.txt', 'assets/\u0000evil']) {
    const zipBytes = buildRawZip([{ name, data: bytesOf('x') }]);
    assert.throws(() => readZip(zipBytes), zipErrorCode('path'), `应拒绝：${name}`);
  }
  assert.throws(() => writeZip([{ name: '../evil.txt', data: bytesOf('x') }]), zipErrorCode('path'));
  assert.throws(() => writeZip([{ name: '/abs.txt', data: bytesOf('x') }]), zipErrorCode('path'));
  const backslash = buildRawZip([{ name: 'assets\\ok.txt', data: bytesOf('x') }]);
  const result = readZip(backslash);
  assert.ok(result.entries.has('assets/ok.txt'), '反斜杠应规范化为 /');
  assert.match(result.warnings.join('\n'), /反斜杠/);
  assert.equal(normalizeEntryPath('assets/a/b.txt').path, 'assets/a/b.txt');
});

test('zip: 重复条目名（大小写不敏感）被拒', () => {
  assert.throws(
    () => writeZip([
      { name: 'assets/a.txt', data: bytesOf('1') },
      { name: 'ASSETS/A.TXT', data: bytesOf('2') },
    ]),
    zipErrorCode('duplicate'),
  );
  const zipBytes = buildRawZip([
    { name: 'assets/a.txt', data: bytesOf('1') },
    { name: 'ASSETS/A.TXT', data: bytesOf('2') },
  ]);
  assert.throws(() => readZip(zipBytes), zipErrorCode('duplicate'));
});

test('zip: 上线限制（条目数 / 单条目声明大小 / 整包大小 / pack.json 大小）', () => {
  const tooMany = Array.from({ length: ZIP_LIMITS.maxEntries + 1 }, (_, index) => ({
    name: `assets/f${index}.txt`,
    data: new Uint8Array([index & 0xff]),
  }));
  assert.throws(() => readZip(buildRawZip(tooMany)), zipErrorCode('limit'));

  const oversizedEntry = buildRawZip([
    { name: 'assets/big.bin', data: new Uint8Array([1]), uncompressedSize: ZIP_LIMITS.maxEntryBytes + 1 },
  ]);
  assert.throws(() => readZip(oversizedEntry), zipErrorCode('limit'));

  const hugeArchive = new Uint8Array(ZIP_LIMITS.maxArchiveBytes + 1);
  assert.throws(() => readZip(hugeArchive), zipErrorCode('limit'));
  const decodedHuge = trpgpackToPack(hugeArchive);
  assert.equal(decodedHuge.ok, false);
  assert.match(decodedHuge.errors.join('\n'), /包过大/);

  const oversizedPackJson = buildRawZip([
    { name: 'pack.json', data: new Uint8Array(ZIP_LIMITS.maxPackJsonBytes + 1) },
  ]);
  assert.equal(readZip(oversizedPackJson).entries.size, 1, 'zip 层允许 4 MiB+ 的 pack.json，限制在 pack-zip 层');
  const decodedPackJson = trpgpackToPack(oversizedPackJson);
  assert.equal(decodedPackJson.ok, false);
  assert.match(decodedPackJson.errors.join('\n'), /pack\.json 解压后/);
});

test('zip: 加密 / 非常规压缩方式 / zip64 被拒', () => {
  assert.throws(
    () => readZip(buildRawZip([{ name: 'pack.json', data: bytesOf('x'), flags: 0x0801 }])),
    zipErrorCode('encrypted'),
  );
  assert.throws(
    () => readZip(buildRawZip([{ name: 'pack.json', data: bytesOf('x'), method: 9 }])),
    zipErrorCode('unsupported-method'),
  );
  assert.throws(
    () => readZip(buildRawZip([{ name: 'pack.json', data: bytesOf('x'), compressedSize: 0xffffffff }])),
    zipErrorCode('zip64'),
  );
});

test('pack-zip: 非 zip 字节 / 缺 pack.json / 嵌套包目录被拒', () => {
  const plain = trpgpackToPack(bytesOf('this is not a zip'));
  assert.equal(plain.ok, false);
  assert.match(plain.errors.join('\n'), /ZIP 魔数/);
  assert.throws(() => readZip(bytesOf('short')), zipErrorCode('not-zip'));
  assert.throws(() => readZip(new Uint8Array(200)), zipErrorCode('not-zip'));

  const noPackJson = trpgpackToPack(writeZip([{ name: 'assets/a.txt', data: bytesOf('x') }]));
  assert.equal(noPackJson.ok, false);
  assert.match(noPackJson.errors.join('\n'), /缺少 pack\.json/);

  const nested = trpgpackToPack(writeZip([{ name: 'core-guimuya/pack.json', data: bytesOf('{}') }]));
  assert.equal(nested.ok, false);
  assert.match(nested.errors.join('\n'), /必须在 zip 根目录/);
});

test('pack-zip: 未识别条目 warning 后忽略（__MACOSX 等），不影响解码', () => {
  const zipBytes = writeZip([
    { name: 'pack.json', data: canonicalJsonBytes(CORE_GUIMUYA_PACK) },
    { name: '__MACOSX/._pack.json', data: bytesOf('macos resource fork') },
    { name: '.DS_Store', data: bytesOf('junk') },
  ]);
  const decoded = trpgpackToPack(zipBytes);
  assert.equal(decoded.ok, true, decoded.errors.join('\n'));
  assert.match(decoded.warnings.join('\n'), /忽略未识别的 zip 条目/);
  assert.equal(decoded.contentHash, contentHashOfPack(CORE_GUIMUYA_PACK));
});

test('pack-zip: pack.json 带 UTF-8 BOM 也能解析（Windows 编辑器常见）', () => {
  const body = canonicalJsonBytes(CORE_GUIMUYA_PACK);
  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf], 0);
  withBom.set(body, 3);
  const decoded = trpgpackToPack(writeZip([{ name: 'pack.json', data: withBom }]));
  assert.equal(decoded.ok, true, decoded.errors.join('\n'));
  assert.equal(decoded.pack?.packId, 'core-guimuya');
  assert.equal(decoded.contentHash, contentHashOfPack(CORE_GUIMUYA_PACK));
});

test('pack-zip: 素材 roundtrip（icon 引用 + assets 拷贝），缺失素材导出即报错', () => {
  const withIcon = clonePack();
  withIcon.icon = 'assets/cover.svg';
  const svg = bytesOf('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const bytes = packToTrpgpack(withIcon, { assets: new Map([['assets/cover.svg', svg]]) });
  const decoded = trpgpackToPack(bytes);
  assert.equal(decoded.ok, true, decoded.errors.join('\n'));
  assert.equal(decoded.pack?.icon, 'assets/cover.svg');
  const decodedSvg = decoded.assets.get('assets/cover.svg');
  assert.ok(decodedSvg);
  assert.deepEqual([...decodedSvg], [...svg]);
  assert.deepEqual(decoded.warnings, [], '唯一素材被 icon 引用，不应有孤立素材告警');

  assert.throws(
    () => packToTrpgpack(withIcon),
    (error: unknown) =>
      error instanceof PackValidationError && error.errors.some((message) => message.includes('素材不存在')),
  );
  assert.throws(
    () => packToTrpgpack(CORE_GUIMUYA_PACK, { assets: { 'cover.svg': bytesOf('x') } }),
    (error: unknown) =>
      error instanceof PackValidationError && error.errors.some((message) => message.includes('assets/')),
  );
});
