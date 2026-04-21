const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { extractBookInfoFromXml, decodeXmlBuffer, readBookInfo } = require('../src/fb2');

function createZipBuffer(fileName, content) {
  const nameBuffer = Buffer.from(fileName, 'utf8');
  const dataBuffer = Buffer.from(content, 'utf8');
  const compressed = zlib.deflateRawSync(dataBuffer);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(dataBuffer.length, 22);
  localHeader.writeUInt16LE(nameBuffer.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(compressed.length, 20);
  centralHeader.writeUInt32LE(dataBuffer.length, 24);
  centralHeader.writeUInt16LE(nameBuffer.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralHeader.length + nameBuffer.length, 12);
  endRecord.writeUInt32LE(localHeader.length + nameBuffer.length + compressed.length, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, nameBuffer, compressed, centralHeader, nameBuffer, endRecord]);
}

test('extracts title and annotation from fb2 xml', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>Первый пользователь</book-title>
        <annotation>
          <p>Проснулся в новом мире.</p>
          <p>Теперь ему нужно выжить.</p>
        </annotation>
      </title-info>
    </description>
  </FictionBook>`;

  const result = extractBookInfoFromXml(xml);

  assert.equal(result.title, 'Первый пользователь');
  assert.equal(result.annotation, 'Проснулся в новом мире.\n\nТеперь ему нужно выжить.');
});

test('falls back when annotation is missing', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>Книга без аннотации</book-title>
      </title-info>
    </description>
  </FictionBook>`;

  const result = extractBookInfoFromXml(xml);

  assert.equal(result.title, 'Книга без аннотации');
  assert.equal(result.annotation, 'Аннотация не найдена.');
});

test('decodes windows-1251 buffers using xml declaration', () => {
  const source = '<?xml version="1.0" encoding="windows-1251"?><FictionBook><description><title-info><book-title>Тест</book-title></title-info></description></FictionBook>';
  const bytes = Buffer.from(source, 'binary');

  const result = decodeXmlBuffer(bytes);

  assert.match(result, /encoding="windows-1251"/i);
});

test('reads fb2 from zip without python', async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>Леший</book-title>
        <annotation><p>Аннотация внутри zip.</p></annotation>
      </title-info>
    </description>
  </FictionBook>`;

  const zipBuffer = createZipBuffer('book.fb2', xml);
  const tempFile = path.join(os.tmpdir(), `books-selection-${Date.now()}.fb2.zip`);

  await fs.writeFile(tempFile, zipBuffer);
  const result = await readBookInfo(tempFile);
  await fs.unlink(tempFile);

  assert.equal(result.title, 'Леший');
  assert.equal(result.annotation, 'Аннотация внутри zip.');
});
