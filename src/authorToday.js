const SERIES_HOSTS = new Set(['author.today', 'www.author.today']);
const SERIES_PATH_PATTERN = /^\/work\/series\/(\d+)\/?$/;
const MAX_SERIES_PAGE_BYTES = 2 * 1024 * 1024;
const SERIES_FETCH_TIMEOUT_MS = 15_000;
const SERIES_HEADER_WINDOW = 4000;
const SERIES_TIMEOUT_MESSAGE = 'Превышено время ожидания ответа Author.Today. Попробуйте позже.';
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
  // Метка статуса цикла стоит в шапке страницы; у книг в списке тот же класс-маркер,
  // поэтому ищем только между заголовком и началом списка произведений.
  const headerStart = html.indexOf('</h1>');
  const listStart = headerStart === -1 ? -1 : html.indexOf('<div class="book-title">', headerStart);
  const from = headerStart === -1 ? 0 : headerStart;
  const to = listStart > from ? listStart : Math.min(html.length, from + SERIES_HEADER_WINDOW);
  const match = /book-status-icon"[^>]*><\/i>\s*([^<]+)/.exec(html.slice(from, to));
  if (!match) return null;
  const label = stripTags(match[1]).toLowerCase();
  if (label.includes('не завершен') || label.includes('не завершён')) return false;
  if (label.includes('завершен') || label.includes('завершён')) return true;
  return null;
}

function parseSeriesWorks(html) {
  const entries = [];
  const seen = new Set();
  const blocks = html.matchAll(/<div class="book-title">([\s\S]*?)<\/div>/g);

  for (const block of blocks) {
    const link = /<a[^>]*href="\/work\/(\d+)"[^>]*>([\s\S]*?)<\/a>/.exec(block[1]);
    if (!link) continue;
    const workId = Number(link[1]);
    if (!Number.isSafeInteger(workId) || workId <= 0 || seen.has(workId)) continue;
    seen.add(workId);
    const indexMatch = /label-row-index">(\d+)</.exec(block[1]);
    entries.push({
      workId,
      title: stripTags(link[2]) || `Книга ${workId}`,
      index: indexMatch ? Number(indexMatch[1]) : null,
    });
  }

  // Страница нумерует книги самого цикла; карточки без номера — посторонние блоки (рекомендации и т.п.).
  const numbered = entries.filter((entry) => Number.isInteger(entry.index) && entry.index > 0);
  const selected = numbered.length > 0 ? numbered : entries;

  return selected
    .map((entry, position) => ({ workId: entry.workId, title: entry.title, index: entry.index || position + 1 }))
    .sort((left, right) => left.index - right.index);
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

async function readLimitedBody(response, maxBytes, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Страница цикла Author.Today слишком большая.');
    return text;
  }

  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  const aborted = signal
    ? new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error(SERIES_TIMEOUT_MESSAGE));
      else signal.addEventListener('abort', () => reject(new Error(SERIES_TIMEOUT_MESSAGE)), { once: true });
    })
    : null;

  try {
    for (;;) {
      const { done, value } = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Страница цикла Author.Today слишком большая.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Соединение уже закрыто — отмена не обязательна.
    }
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchSeriesHtml(url, {
  fetchImpl = fetch,
  timeoutMs = SERIES_FETCH_TIMEOUT_MS,
  maxBytes = MAX_SERIES_PAGE_BYTES,
  signal,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response;
      try {
        response = await fetchImpl(target, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ru,en' },
        });
      } catch (error) {
        if (timedOut) throw new Error(SERIES_TIMEOUT_MESSAGE);
        throw error;
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

      try {
        return await readLimitedBody(response, maxBytes, controller.signal);
      } catch (error) {
        if (timedOut) throw new Error(SERIES_TIMEOUT_MESSAGE);
        throw error;
      }
    }

    throw new Error('Слишком много перенаправлений на author.today.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
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
