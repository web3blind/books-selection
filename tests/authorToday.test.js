const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadSeriesSnapshot,
  normalizeSeriesUrl,
  parseSeriesPage,
} = require('../src/authorToday');

const fixturesDir = path.join(__dirname, 'fixtures');
const unfinishedHtml = fs.readFileSync(path.join(fixturesDir, 'author-today-series-59866.html'), 'utf8');
const finishedHtml = fs.readFileSync(path.join(fixturesDir, 'author-today-series-47167.html'), 'utf8');

function htmlResponse(body, url = 'https://author.today/work/series/47167') {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: new Response(body).body,
    text: async () => body,
  };
}

test('normalizeSeriesUrl accepts public series links and rejects everything else', () => {
  assert.deepEqual(normalizeSeriesUrl('https://author.today/work/series/47167'), {
    seriesId: 47167,
    canonicalUrl: 'https://author.today/work/series/47167',
  });
  assert.deepEqual(normalizeSeriesUrl('  https://www.author.today/work/series/59866/?utm=x#top  '), {
    seriesId: 59866,
    canonicalUrl: 'https://author.today/work/series/59866',
  });

  const rejected = [
    '',
    'не ссылка',
    'http://author.today/work/series/47167',
    'https://evil.example/work/series/47167',
    'https://author.today.evil.example/work/series/47167',
    'https://author.today/work/47167',
    'https://author.today/work/series/abc',
    'https://user:pass@author.today/work/series/47167',
    'https://author.today:8443/work/series/47167',
  ];
  for (const value of rejected) {
    assert.throws(() => normalizeSeriesUrl(value), undefined, `должна быть отклонена: ${value}`);
  }
});

test('parseSeriesPage reads an unfinished series page', () => {
  const page = parseSeriesPage(unfinishedHtml);
  assert.equal(page.seriesTitle, 'Барьер');
  assert.equal(page.isComplete, false);
  assert.deepEqual(page.works.map((work) => work.workId), [650341]);
  assert.equal(page.works[0].title, 'Ассимиляция');
});

test('parseSeriesPage reads a finished series page in order without duplicates', () => {
  const page = parseSeriesPage(finishedHtml);
  assert.equal(page.seriesTitle, 'Первый суд');
  assert.equal(page.isComplete, true);
  assert.deepEqual(page.works.map((work) => work.workId), [458421, 496928, 531220]);
  assert.deepEqual(page.works.map((work) => work.index), [1, 2, 3]);
  assert.deepEqual(page.works.map((work) => work.title), ['Безымянный мир', 'Церковь Света', 'Вердикт']);
});

test('parseSeriesPage fails loudly when the page has no book list', () => {
  assert.throws(() => parseSeriesPage('<html><body><h1>Цикл «Пусто»</h1></body></html>'), /книги/);
});

test('parseSeriesPage tolerates CRLF markup from the live server', () => {
  const crlfHtml = [
    '<html>',
    '<body>',
    '<h1>Цикл «Проверка»</h1>',
    '<span class="label label-primary"><i class="icon-pencil book-status-icon"></i> не завершен</span>',
    '<div class="book-title"><a href="/work/42">Книга с переносом</a></div>',
    '</body>',
    '</html>',
  ].join('\r\n');

  const page = parseSeriesPage(crlfHtml);
  assert.equal(page.seriesTitle, 'Проверка');
  assert.equal(page.isComplete, false);
  assert.deepEqual(page.works.map((work) => work.workId), [42]);
  assert.equal(page.works[0].title, 'Книга с переносом');
});

test('loadSeriesSnapshot fetches the canonical page and returns a snapshot', async () => {
  const seen = [];
  const snapshot = await loadSeriesSnapshot('https://www.author.today/work/series/47167?utm=1', {
    fetchImpl: async (url, options) => {
      seen.push({ url, redirect: options.redirect });
      return htmlResponse(finishedHtml, url);
    },
  });

  assert.deepEqual(seen, [{ url: 'https://author.today/work/series/47167', redirect: 'manual' }]);
  assert.equal(snapshot.seriesId, 47167);
  assert.equal(snapshot.canonicalUrl, 'https://author.today/work/series/47167');
  assert.equal(snapshot.isComplete, true);
  assert.equal(snapshot.works.length, 3);
});

test('loadSeriesSnapshot refuses redirects that leave author.today and non-HTML answers', async () => {
  await assert.rejects(
    loadSeriesSnapshot('https://author.today/work/series/47167', {
      fetchImpl: async () => ({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://evil.example/work/series/47167' }),
        text: async () => '',
      }),
    }),
    /author\.today/i,
  );

  await assert.rejects(
    loadSeriesSnapshot('https://author.today/work/series/47167', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{}',
      }),
    }),
    /HTML/,
  );
});

test('loadSeriesSnapshot reports oversized and failed pages without keeping partial data', async () => {
  const big = 'x'.repeat(4096);
  await assert.rejects(
    loadSeriesSnapshot('https://author.today/work/series/47167', {
      fetchImpl: async () => htmlResponse(big),
      maxBytes: 1024,
    }),
    /слишком большая/,
  );

  await assert.rejects(
    loadSeriesSnapshot('https://author.today/work/series/47167', {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => 'service unavailable',
      }),
    }),
    /503/,
  );
});

test('loadSeriesSnapshot keeps its timeout while the response body is still streaming', async () => {
  let abortedDuringBody = false;
  const stallingFetch = async (target, options = {}) => new Response(new ReadableStream({
    start(streamController) {
      options.signal?.addEventListener('abort', () => {
        abortedDuringBody = true;
        streamController.error(new Error('aborted while streaming'));
      }, { once: true });
    },
  }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const started = Date.now();
  await assert.rejects(
    loadSeriesSnapshot('https://author.today/work/series/47167', { fetchImpl: stallingFetch, timeoutMs: 150 }),
    /врем|timeout/i,
  );
  assert.equal(abortedDuringBody, true, 'the timeout must abort the request while the body is being read');
  assert.ok(Date.now() - started < 3000, 'a stalled body must not hang the request forever');
});

test('parseSeriesPage reads the completion label from the series header, not from a book row', () => {
  const html = [
    '<html><body>',
    '<div class="book-row"><span class="label label-success"><i class="icon-check book-status-icon"></i> завершен</span></div>',
    '<h1>Цикл «Проверка»</h1>',
    '<div class="mb"><span class="label label-primary"><i class="icon-pencil book-status-icon"></i> не завершен</span></div>',
    '<div class="panel-body collection-work-list">',
    '<div class="book-title"><span class="label label-default label-row-index">1</span> <a href="/work/7">Книга</a></div>',
    '</div>',
    '</body></html>',
  ].join('');

  const page = parseSeriesPage(html);
  assert.equal(page.isComplete, false, 'the series label wins over a book row label');
  assert.deepEqual(page.works.map((work) => work.workId), [7]);
});

test('parseSeriesPage ignores book cards that are not part of the numbered series list', () => {
  const html = [
    '<html><body>',
    '<h1>Цикл «Проверка»</h1>',
    '<div class="panel-body collection-work-list">',
    '<div class="book-title"><span class="label label-default label-row-index">1</span> <a href="/work/1">Своя</a></div>',
    '<div class="book-title"><span class="label label-default label-row-index">2</span> <a href="/work/2">Тоже своя</a></div>',
    '</div>',
    '<div class="recommendations"><div class="book-title"><a href="/work/99">Чужая из рекомендаций</a></div></div>',
    '</body></html>',
  ].join('');

  const works = parseSeriesPage(html).works;
  assert.deepEqual(works.map((work) => work.workId), [1, 2]);
  assert.deepEqual(works.map((work) => work.index), [1, 2]);
});
