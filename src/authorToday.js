const SERIES_HOSTS = new Set(['author.today', 'www.author.today']);
const SERIES_PATH_PATTERN = /^\/work\/series\/(\d+)\/?$/;
const MAX_SERIES_PAGE_BYTES = 2 * 1024 * 1024;
const SERIES_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; BooksSelection/0.4)';

function normalizeSeriesUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) throw new Error('Нужна ссылка на страницу цикла Author.Today.');

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Ссылка должна выглядеть как https://author.today/work/series/47167.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Ссылка должна начинаться с https://author.today/work/series/.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Ссылка не должна содержать логин или пароль.');
  }
  if (!SERIES_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Поддерживаются только публичные страницы цикла на author.today.');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('Ссылка должна вести на стандартный порт author.today.');
  }

  const match = SERIES_PATH_PATTERN.exec(parsed.pathname);
  if (!match) {
    throw new Error('Ссылка должна вести на страницу цикла: https://author.today/work/series/<номер>.');
  }

  const seriesId = Number(match[1]);
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    throw new Error('Номер цикла Author.Today должен быть положительным числом.');
  }

  return { seriesId, canonicalUrl: `https://author.today/work/series/${seriesId}` };
}

function decodeEntities(value) {
  return String(value || '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&laquo;', '«')
    .replaceAll('&raquo;', '»')
    .replaceAll('&mdash;', '—')
    .replaceAll('&ndash;', '–')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll('&amp;', '&');
}

function stripTags(value) {
  return decodeEntities(String(value || '').replaceAll(/<[^>]*>/g, ' ')).replaceAll(/\s+/g, ' ').trim();
}

function parseSeriesTitle(html) {
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  if (!match) return null;
  const text = stripTags(match[1]).replace(/^Цикл\s*/i, '').trim();
  const cleaned = text.replace(/^[«"']|[»"']$/g, '').trim();
  return cleaned || null;
}

function parseSeriesCompletion(html) {
  const match = /book-status-icon"[^>]*><\/i>\s*([^<]+)/.exec(html);
  if (!match) return null;
  const label = stripTags(match[1]).toLowerCase();
  if (label.includes('не завершен') || label.includes('не завершён')) return false;
  if (label.includes('завершен') || label.includes('завершён')) return true;
  return null;
}

function parseSeriesWorks(html) {
  const works = [];
  const seen = new Set();
  const blocks = html.matchAll(/<div class="book-title">([\s\S]*?)<\/div>/g);

  for (const block of blocks) {
    const link = /<a[^>]*href="\/work\/(\d+)"[^>]*>([\s\S]*?)<\/a>/.exec(block[1]);
    if (!link) continue;
    const workId = Number(link[1]);
    if (!Number.isSafeInteger(workId) || workId <= 0 || seen.has(workId)) continue;
    seen.add(workId);
    const indexMatch = /label-row-index">(\d+)</.exec(block[1]);
    works.push({
      workId,
      title: stripTags(link[2]) || `Книга ${workId}`,
      index: indexMatch ? Number(indexMatch[1]) : works.length + 1,
    });
  }

  return works.sort((left, right) => left.index - right.index);
}

function parseSeriesPage(html) {
  const text = String(html || '');
  const works = parseSeriesWorks(text);
  if (works.length === 0) {
    throw new Error('Не удалось найти книги на странице цикла Author.Today.');
  }
  return {
    seriesTitle: parseSeriesTitle(text),
    isComplete: parseSeriesCompletion(text),
    works,
  };
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Страница цикла Author.Today слишком большая.');
    return text;
  }

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Страница цикла Author.Today слишком большая.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchSeriesHtml(url, { fetchImpl = fetch, timeoutMs = SERIES_FETCH_TIMEOUT_MS, maxBytes = MAX_SERIES_PAGE_BYTES } = {}) {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(target, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ru,en' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Author.Today вернул перенаправление без адреса.');
      const next = normalizeSeriesUrl(new URL(location, target).toString());
      target = next.canonicalUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Author.Today вернул ошибку ${response.status}.`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html')) {
      throw new Error('Author.Today вернул не HTML-страницу.');
    }
    return readLimitedBody(response, maxBytes);
  }

  throw new Error('Слишком много перенаправлений на author.today.');
}

async function loadSeriesSnapshot(rawUrl, options = {}) {
  const { seriesId, canonicalUrl } = normalizeSeriesUrl(rawUrl);
  const html = await fetchSeriesHtml(canonicalUrl, options);
  const page = parseSeriesPage(html);
  return { seriesId, canonicalUrl, ...page };
}

module.exports = {
  MAX_SERIES_PAGE_BYTES,
  SERIES_FETCH_TIMEOUT_MS,
  fetchSeriesHtml,
  loadSeriesSnapshot,
  normalizeSeriesUrl,
  parseSeriesPage,
};
