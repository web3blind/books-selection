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

const collator = new Intl.Collator(['ru', 'en'], {
  numeric: true,
  sensitivity: 'base',
});

// Между книгами отдаём событийный цикл: разбор одной книги — синхронная работа,
// без паузы сервер не успевает отвечать на другие запросы и приложение «подвисает».
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function naturalSort(a, b) {
  return collator.compare(a, b);
}

async function listDirectories(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(naturalSort);
}

async function findBookFiles(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(naturalSort);

  return files.filter((name) => /\.fb2(\.zip)?$/i.test(name));
}

async function scanBooks(rootPath, { readInfo = true, allFiles = false } = {}) {
  const folderNames = await listDirectories(rootPath);
  const results = [];

  for (const folderName of folderNames) {
    const folderPath = path.join(rootPath, folderName);
    const fileNames = await findBookFiles(folderPath);

    if (fileNames.length === 0) {
      results.push({
        folderName,
        fileName: null,
        title: BOOK_FILE_NOT_FOUND_TITLE,
        annotation: BOOK_FILE_NOT_FOUND_ANNOTATION,
        status: BOOK_STATUSES.MISSING,
        reason: BOOK_REASONS.BOOK_FILE_NOT_FOUND,
        hasAnnotation: false,
      });
      continue;
    }

    const selectedFileNames = allFiles ? fileNames : fileNames.slice(0, 1);
    for (const fileName of selectedFileNames) {
      const filePath = path.join(folderPath, fileName);

      if (!readInfo) {
        results.push({ folderName, fileName, status: BOOK_STATUSES.OK });
        continue;
      }

      try {
        const info = await readBookInfo(filePath);
        results.push({
          folderName,
          fileName,
          title: info.title,
          annotation: info.annotation,
          status: BOOK_STATUSES.OK,
          reason: info.annotation === ANNOTATION_MISSING_TEXT ? BOOK_REASONS.ANNOTATION_MISSING : BOOK_REASONS.OK,
          hasAnnotation: info.annotation !== ANNOTATION_MISSING_TEXT,
        });
      } catch (error) {
        results.push({
          folderName,
          fileName,
          title: BOOK_READ_ERROR_TITLE,
          annotation: error.message,
          status: BOOK_STATUSES.ERROR,
          reason: BOOK_REASONS.BOOK_READ_ERROR,
          hasAnnotation: false,
        });
      }

      await yieldToEventLoop();
    }
  }

  return results;
}

module.exports = {
  scanBooks,
  yieldToEventLoop,
};
