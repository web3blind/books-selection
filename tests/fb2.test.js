const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  chunkText,
  decodeXmlBuffer,
  extractBookInfoFromXml,
  extractBookContextFromXml,
  extractBodyTextFromXml,
  readBookDocument,
  readBookInfo,
} = require('../src/fb2');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
  localHeader.writeUInt32LE(crc32(dataBuffer), 14);
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
  centralHeader.writeUInt32LE(crc32(dataBuffer), 16);
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

test('extracts normalized full body text from fb2 sections without annotation text', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>Тело книги</book-title>
        <annotation><p>Это аннотация, не текст книги.</p></annotation>
      </title-info>
    </description>
    <body>
      <section>
        <title><p>Глава 1</p></title>
        <p>Первый абзац &amp; знак.</p>
        <p>Второй абзац.</p>
      </section>
      <section>
        <title><p>Глава 2</p></title>
        <p>Финальный абзац.</p>
      </section>
    </body>
  </FictionBook>`;

  const result = extractBodyTextFromXml(xml);

  assert.equal(result, 'Глава 1\n\nПервый абзац & знак.\n\nВторой абзац.\n\nГлава 2\n\nФинальный абзац.');
  assert.doesNotMatch(result, /аннотация/i);
});

test('extracts ordered nested headings, non-paragraph text, notes, and negative statements without changing legacy body text', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <body>
      <section>
        <title><p>Часть первая</p></title>
        <p>Герой не погиб и не покинул спутницу.</p>
        <section>
          <title>Глава без p</title>
          <subtitle>Три года спустя</subtitle>
          <poem><stanza><v>Они вернулись вместе.</v></stanza></poem>
        </section>
      </section>
    </body>
    <body name="notes">
      <section><title><p>Примечание 1</p></title><p>Он выжил после финала.</p></section>
    </body>
  </FictionBook>`;

  const bodyText = extractBodyTextFromXml(xml);
  const blocks = extractBookContextFromXml(xml);

  assert.equal(bodyText, 'Часть первая\n\nГерой не погиб и не покинул спутницу.');
  assert.deepEqual(
    blocks.map((block) => ({
      body: block.bodyIndex,
      kind: block.kind,
      represented: block.representedInBodyText,
      path: block.sectionPath,
      text: block.text,
    })),
    [
      { body: 0, kind: 'title', represented: true, path: ['Часть первая'], text: 'Часть первая' },
      { body: 0, kind: 'paragraph', represented: true, path: ['Часть первая'], text: 'Герой не погиб и не покинул спутницу.' },
      { body: 0, kind: 'title', represented: false, path: ['Часть первая', 'Глава без p'], text: 'Глава без p' },
      { body: 0, kind: 'subtitle', represented: false, path: ['Часть первая', 'Глава без p'], text: 'Три года спустя' },
      { body: 0, kind: 'verse', represented: false, path: ['Часть первая', 'Глава без p'], text: 'Они вернулись вместе.' },
      { body: 1, kind: 'title', represented: false, path: ['Примечание 1'], text: 'Примечание 1' },
      { body: 1, kind: 'paragraph', represented: false, path: ['Примечание 1'], text: 'Он выжил после финала.' },
    ],
  );
  assert.equal(bodyText.slice(blocks[1].startOffset, blocks[1].endOffset), blocks[1].text);
});

test('readBookDocument exposes the same rich context for plain and zipped FB2 sources', async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><FictionBook>
    <description><title-info><book-title>Контекст</book-title></title-info></description>
    <body><section><title><p>Глава</p></title><p>Она не умерла.</p><subtitle>После битвы</subtitle></section></body>
    <body name="notes"><section><p>Сноска о спасении.</p></section></body>
  </FictionBook>`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-context-'));
  const plainPath = path.join(root, 'plain.fb2');
  const zipPath = path.join(root, 'archive.fb2.zip');
  await fs.writeFile(plainPath, xml);
  await fs.writeFile(zipPath, createZipBuffer('nested/book.fb2', xml));

  try {
    const plain = await readBookDocument(plainPath);
    const zipped = await readBookDocument(zipPath);
    assert.deepEqual(zipped, plain);
    assert.match(plain.bodyText, /не умерла/);
    assert.ok(plain.contextBlocks.some((block) => block.text === 'После битвы' && !block.representedInBodyText));
    assert.ok(plain.contextBlocks.some((block) => block.bodyName === 'notes' && block.text === 'Сноска о спасении.'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('chunkText creates stable bounded chunks with offsets and hashes', () => {
  const text = 'Альфа бета гамма. Дельта эпсилон дзета. Эта тета йота.';

  const chunks = chunkText(text, { maxChars: 26 });

  assert.deepEqual(chunks.map((chunk) => chunk.index), [0, 1, 2]);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['Альфа бета гамма.', 'Дельта эпсилон дзета.', 'Эта тета йота.']);
  assert.deepEqual(chunks.map((chunk) => text.slice(chunk.startOffset, chunk.endOffset)), chunks.map((chunk) => chunk.text));
  assert.ok(chunks.every((chunk) => /^[a-f0-9]{64}$/.test(chunk.contentHash)));
});

test('chunkText enforces maxChars for long sentences and preserves normalized offsets', () => {
  const text = `${'а'.repeat(130)}\n\nВторой абзац без потери смещений.`;
  const normalized = text.trim();
  const chunks = chunkText(text, { maxChars: 40 });

  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 40));
  assert.ok(chunks.every((chunk) => chunk.startOffset >= 0));
  assert.deepEqual(
    chunks.map((chunk) => normalized.slice(chunk.startOffset, chunk.endOffset)),
    chunks.map((chunk) => chunk.text),
  );
});

test('rejects a plain FB2 file larger than the safety limit before reading it', async () => {
  const tempFile = path.join(os.tmpdir(), `books-selection-plain-limit-${Date.now()}.fb2`);
  const handle = await fs.open(tempFile, 'w');
  await handle.truncate((64 * 1024 * 1024) + 1);
  await handle.close();

  try {
    await assert.rejects(readBookInfo(tempFile), /FB2.*safety limit/i);
  } finally {
    await fs.unlink(tempFile);
  }
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

test('readBookInfo matches a full parse when the book body is much larger than the head window', async () => {
  const paragraph = `<p>${'дракон пещера артефакт '.repeat(200)}</p>`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>Великая книга</book-title>
        <annotation><p>Короткая аннотация в начале.</p></annotation>
      </title-info>
    </description>
    <body><section>${paragraph.repeat(400)}</section></body>
  </FictionBook>`;

  assert.ok(xml.length > 1024 * 1024, 'fixture must be larger than the head window');
  const tempFile = path.join(os.tmpdir(), `books-selection-head-${Date.now()}.fb2`);
  await fs.writeFile(tempFile, xml, 'utf8');

  try {
    const info = await readBookInfo(tempFile);
    assert.deepEqual(info, extractBookInfoFromXml(xml));
    assert.equal(info.title, 'Великая книга');
    assert.equal(info.annotation, 'Короткая аннотация в начале.');
  } finally {
    await fs.unlink(tempFile);
  }
});

test('readBookInfo falls back to a full decode when the description lies beyond the head window', async () => {
  const filler = `<p>${'шум '.repeat(1000)}</p>`;
  const xml = `<?xml version="1.0" encoding="utf-8"?><FictionBook>${filler.repeat(200)}<description><title-info><book-title>Позднее описание</book-title><annotation><p>Аннотация после пролога.</p></annotation></title-info></description></FictionBook>`;

  assert.ok(xml.length > 512 * 1024, 'fixture must push the description past the head window');
  const tempFile = path.join(os.tmpdir(), `books-selection-late-${Date.now()}.fb2`);
  await fs.writeFile(tempFile, xml, 'utf8');

  try {
    const info = await readBookInfo(tempFile);
    assert.equal(info.title, 'Позднее описание');
    assert.equal(info.annotation, 'Аннотация после пролога.');
  } finally {
    await fs.unlink(tempFile);
  }
});

test('readBookInfo reads a large zipped book through the head window', async () => {
  const paragraph = `<p>${'море корабль шторм '.repeat(200)}</p>`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>Большой архив</book-title>
        <annotation><p>Аннотация из архива.</p></annotation>
      </title-info>
    </description>
    <body><section>${paragraph.repeat(300)}</section></body>
  </FictionBook>`;

  const zipBuffer = createZipBuffer('big.fb2', xml);
  const tempFile = path.join(os.tmpdir(), `books-selection-bigzip-${Date.now()}.fb2.zip`);
  await fs.writeFile(tempFile, zipBuffer);

  try {
    const info = await readBookInfo(tempFile);
    assert.deepEqual(info, extractBookInfoFromXml(xml));
  } finally {
    await fs.unlink(tempFile);
  }
});

test('rejects a ZIP entry whose extracted FB2 does not match the declared CRC32', async () => {
  const zipBuffer = createZipBuffer('book.fb2', '<FictionBook/>');
  const centralOffset = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zipBuffer.writeUInt32LE(0x12345678, centralOffset + 16);
  const tempFile = path.join(os.tmpdir(), `books-selection-crc-${Date.now()}.fb2.zip`);

  await fs.writeFile(tempFile, zipBuffer);
  try {
    await assert.rejects(readBookInfo(tempFile), /CRC32/i);
  } finally {
    await fs.unlink(tempFile);
  }
});

test('rejects a zip entry whose declared uncompressed size exceeds the safety limit before inflation', async () => {
  const zipBuffer = createZipBuffer('book.fb2', '<FictionBook/>');
  const centralOffset = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zipBuffer.writeUInt32LE(300 * 1024 * 1024, centralOffset + 24);
  const tempFile = path.join(os.tmpdir(), `books-selection-limit-${Date.now()}.fb2.zip`);

  await fs.writeFile(tempFile, zipBuffer);
  try {
    await assert.rejects(readBookInfo(tempFile), /safety limit/i);
  } finally {
    await fs.unlink(tempFile);
  }
});

test('rejects encrypted zip entries', async () => {
  const zipBuffer = createZipBuffer('book.fb2', '<FictionBook/>');
  const centralOffset = zipBuffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zipBuffer.writeUInt16LE(1, 6);
  zipBuffer.writeUInt16LE(1, centralOffset + 8);
  const tempFile = path.join(os.tmpdir(), `books-selection-encrypted-${Date.now()}.fb2.zip`);

  await fs.writeFile(tempFile, zipBuffer);
  try {
    await assert.rejects(readBookInfo(tempFile), /encrypted/i);
  } finally {
    await fs.unlink(tempFile);
  }
});
