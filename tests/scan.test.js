const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { BOOK_REASONS, BOOK_STATUSES } = require('../src/constants');
const { scanBooks } = require('../src/scan');

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-scan-'));
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

test('scanBooks marks folder without fb2 files as missing', async () => {
  const root = await createTempRoot();
  await fs.mkdir(path.join(root, 'Series 1'));

  const result = await scanBooks(root);

  await fs.rm(root, { recursive: true, force: true });

  assert.equal(result.length, 1);
  assert.equal(result[0].folderName, 'Series 1');
  assert.equal(result[0].status, BOOK_STATUSES.MISSING);
  assert.equal(result[0].reason, BOOK_REASONS.BOOK_FILE_NOT_FOUND);
});

test('scanBooks picks the first supported file by natural sort', async () => {
  const root = await createTempRoot();
  const folder = path.join(root, 'Cycle');
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <FictionBook>
    <description>
      <title-info>
        <book-title>Alpha</book-title>
        <annotation><p>First file wins.</p></annotation>
      </title-info>
    </description>
  </FictionBook>`;

  await writeFile(path.join(folder, '10.fb2'), xml.replace('Alpha', 'Ten'));
  await writeFile(path.join(folder, '2.fb2'), xml);

  const result = await scanBooks(root);

  await fs.rm(root, { recursive: true, force: true });

  assert.equal(result.length, 1);
  assert.equal(result[0].fileName, '2.fb2');
  assert.equal(result[0].title, 'Alpha');
  assert.equal(result[0].status, BOOK_STATUSES.OK);
});

test('scanBooks marks broken fb2.zip as error', async () => {
  const root = await createTempRoot();
  const folder = path.join(root, 'Broken Zip');

  await writeFile(path.join(folder, 'book.fb2.zip'), 'not a real zip');

  const result = await scanBooks(root);

  await fs.rm(root, { recursive: true, force: true });

  assert.equal(result.length, 1);
  assert.equal(result[0].fileName, 'book.fb2.zip');
  assert.equal(result[0].status, BOOK_STATUSES.ERROR);
  assert.equal(result[0].reason, BOOK_REASONS.BOOK_READ_ERROR);
  assert.match(result[0].annotation, /ZIP central directory not found/i);
});
