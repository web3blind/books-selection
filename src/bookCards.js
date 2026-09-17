const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  BOOK_STATUSES,
  BOOK_REASONS,
  ANNOTATION_MISSING_TEXT,
  BOOK_FILE_NOT_FOUND_TITLE,
  BOOK_FILE_NOT_FOUND_ANNOTATION,
  BOOK_READ_ERROR_TITLE,
} = require('./constants');
const { readBookInfo } = require('./fb2');
const { listDirectories, findBookFiles } = require('./scan');

// Кеш карточек циклов. Ключ кеша — список подпапок цикла и имён книг в них:
// пока состав папки с книгами не изменился, на старте не читается ни одна книга.
// Если состав изменился, разбираются только новые или изменившиеся папки.
const CARD_CACHE_VERSION = 1;

function cardsCachePath(databasePath) {
  return databasePath ? `${databasePath}.cards.json` : '';
}

function listingKey(listing) {
  const text = listing
    .map((item) => `${item.folderName}\u0000${item.fileName || ''}`)
    .join('\u0001');
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function listCycleListing(rootPath) {
  const folderNames = await listDirectories(rootPath);
  const listing = [];
  for (const folderName of folderNames) {
    const folderPath = path.join(rootPath, folderName);
    const fileNames = await findBookFiles(folderPath);
    listing.push({ folderName, folderPath, fileName: fileNames[0] || null, fileNames });
  }
  return listing;
}

function missingCard(folderName) {
  return {
    folderName,
    fileName: null,
    title: BOOK_FILE_NOT_FOUND_TITLE,
    annotation: BOOK_FILE_NOT_FOUND_ANNOTATION,
    status: BOOK_STATUSES.MISSING,
    reason: BOOK_REASONS.BOOK_FILE_NOT_FOUND,
    hasAnnotation: false,
  };
}

function cardFromInfo(folderName, fileName, info) {
  return {
    folderName,
    fileName,
    title: info.title,
    annotation: info.annotation,
    status: BOOK_STATUSES.OK,
    reason: info.annotation === ANNOTATION_MISSING_TEXT ? BOOK_REASONS.ANNOTATION_MISSING : BOOK_REASONS.OK,
    hasAnnotation: info.annotation !== ANNOTATION_MISSING_TEXT,
  };
}

function readErrorCard(folderName, fileName, message) {
  return {
    folderName,
    fileName,
    title: BOOK_READ_ERROR_TITLE,
    annotation: message,
    status: BOOK_STATUSES.ERROR,
    reason: BOOK_REASONS.BOOK_READ_ERROR,
    hasAnnotation: false,
  };
}

function reusableCard(cachedCards, item) {
  if (!cachedCards) return null;
  const cached = cachedCards[item.folderName];
  if (!cached || cached.fileName !== item.fileName) return null;
  // Ошибку чтения не запоминаем: при следующем запуске книгу прочитаем снова.
  if (cached.status === BOOK_STATUSES.ERROR) return null;
  return cached;
}

async function readCardCache(cachePath, rootPath) {
  if (!cachePath) return null;
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CARD_CACHE_VERSION) return null;
    if (parsed.root !== rootPath) return null;
    if (!parsed.cards || typeof parsed.cards !== 'object') return null;
    return { key: parsed.key, cards: parsed.cards };
  } catch {
    return null;
  }
}

async function writeCardCache(cachePath, rootPath, key, cards) {
  if (!cachePath) return;
  const payload = JSON.stringify({ version: CARD_CACHE_VERSION, root: rootPath, key, cards });
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const temporaryPath = `${cachePath}.tmp`;
    await fs.writeFile(temporaryPath, payload, 'utf8');
    await fs.rename(temporaryPath, cachePath);
  } catch {
    // Кеш — вспомогательные данные: если записать не удалось, работа продолжается.
  }
}

// Обходит папки циклов, переиспользует карточки из кеша и разбирает только новые
// или изменившиеся книги. readInfo внедряется в тестах, чтобы считать разборы.
async function loadCycleCards(rootPath, options = {}) {
  const {
    cachePath = '',
    refresh = false,
    readInfo = readBookInfo,
  } = options;

  const listing = await listCycleListing(rootPath);
  const key = listingKey(listing);
  const cached = refresh ? null : await readCardCache(cachePath, rootPath);
  const compositionMatches = Boolean(cached) && cached.key === key;

  const cards = {};
  let parsed = 0;

  for (const item of listing) {
    if (!item.fileName) {
      cards[item.folderName] = missingCard(item.folderName);
      continue;
    }

    const reusable = reusableCard(cached ? cached.cards : null, item);
    if (reusable) {
      cards[item.folderName] = reusable;
      continue;
    }

    const filePath = path.join(item.folderPath, item.fileName);
    try {
      const info = await readInfo(filePath);
      cards[item.folderName] = cardFromInfo(item.folderName, item.fileName, info);
    } catch (error) {
      cards[item.folderName] = readErrorCard(item.folderName, item.fileName, error.message);
    }
    parsed += 1;
  }

  const books = listing.map((item) => cards[item.folderName]);
  if (!compositionMatches || parsed > 0) {
    await writeCardCache(cachePath, rootPath, key, cards);
  }

  return { books, fromCache: compositionMatches && parsed === 0, parsed };
}

module.exports = {
  cardsCachePath,
  listCycleListing,
  listingKey,
  loadCycleCards,
  readCardCache,
  writeCardCache,
};
