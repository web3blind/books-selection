const test = require('node:test');
const assert = require('node:assert/strict');

const { extractBookInfoFromXml, decodeXmlBuffer } = require('../src/fb2');

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
