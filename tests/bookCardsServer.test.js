const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../src/server');

function request(started, method, pathname, cookie) {
  return new Promise((resolve, reject) => {
    const { get, request: send } = require('node:http');
    const handler = (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = body;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          // The root route returns HTML; only its cookie matters here.
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    };
    const call = method === 'GET'
      ? get(`${started.url}${pathname}`, { headers: cookie ? { cookie } : {} }, handler)
      : send(`${started.url}${pathname}`, { method, headers: cookie ? { cookie } : {} }, handler);
    call.on('error', reject);
    call.end();
  });
}

test('/api/books serves cached cycle cards and re-reads them on refresh', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'books-selection-cards-server-'));
  const oldConfigPath = process.env.BOOKS_SELECTION_CONFIG_PATH;
  process.env.BOOKS_SELECTION_CONFIG_PATH = path.join(dir, 'config.json');

  const libraryRoot = path.join(dir, 'books');
  await fs.mkdir(path.join(libraryRoot, 'Цикл A'), { recursive: true });
  await fs.writeFile(
    path.join(libraryRoot, 'Цикл A', 'a.fb2'),
    '<FictionBook><description><title-info><book-title>Книга A</book-title><annotation><p>Аннотация A.</p></annotation></title-info></description></FictionBook>',
    'utf8',
  );
  const databasePath = path.join(dir, 'search.sqlite');

  const started = await startServer({ port: 0, openBrowser: false, log: false });
  try {
    const home = await request(started, 'GET', '/');
    const cookie = home.headers['set-cookie'][0].split(';', 1)[0];
    const query = `/api/books?root=${encodeURIComponent(libraryRoot)}&db=${encodeURIComponent(databasePath)}`;

    const cold = await request(started, 'GET', query, cookie);
    assert.equal(cold.statusCode, 200);
    assert.equal(cold.body.fromCache, false, 'the first read parses the books');
    assert.equal(cold.body.count, 1);
    assert.equal(cold.body.books[0].title, 'Книга A');

    const warm = await request(started, 'GET', query, cookie);
    assert.equal(warm.statusCode, 200);
    assert.equal(warm.body.fromCache, true, 'the next read comes from the cache');
    assert.equal(warm.body.books[0].annotation, 'Аннотация A.');

    const refreshed = await request(started, 'GET', `${query}&refresh=1`, cookie);
    assert.equal(refreshed.body.fromCache, false, 'refresh re-reads the books');
    assert.equal(refreshed.body.books[0].title, 'Книга A');

    const cache = JSON.parse(await fs.readFile(`${databasePath}.cards.json`, 'utf8'));
    assert.deepEqual(Object.keys(cache.cards), ['Цикл A']);

    // Новый цикл разбирается отдельно, остальные берутся из кеша.
    await fs.mkdir(path.join(libraryRoot, 'Цикл B'), { recursive: true });
    await fs.writeFile(
      path.join(libraryRoot, 'Цикл B', 'b.fb2'),
      '<FictionBook><description><title-info><book-title>Книга B</book-title><annotation><p>Аннотация B.</p></annotation></title-info></description></FictionBook>',
      'utf8',
    );
    const added = await request(started, 'GET', query, cookie);
    assert.equal(added.body.fromCache, false);
    assert.equal(added.body.count, 2);
    assert.deepEqual(added.body.books.map((card) => card.title), ['Книга A', 'Книга B']);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    if (oldConfigPath === undefined) {
      delete process.env.BOOKS_SELECTION_CONFIG_PATH;
    } else {
      process.env.BOOKS_SELECTION_CONFIG_PATH = oldConfigPath;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
