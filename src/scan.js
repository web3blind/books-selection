const fs = require('node:fs/promises');
const path = require('node:path');

const { readBookInfo } = require('./fb2');

async function listDirectories(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, 'ru'));
}

async function findBookFile(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'ru'));

  return files.find((name) => /\.fb2(\.zip)?$/i.test(name)) || null;
}

async function scanBooks(rootPath) {
  const folderNames = await listDirectories(rootPath);
  const results = [];

  for (const folderName of folderNames) {
    const folderPath = path.join(rootPath, folderName);
    const fileName = await findBookFile(folderPath);

    if (!fileName) {
      results.push({
        folderName,
        fileName: null,
        title: 'Файл книги не найден',
        annotation: 'В этой папке не найдено ни одного файла .fb2 или .fb2.zip.',
        status: 'missing',
      });
      continue;
    }

    const filePath = path.join(folderPath, fileName);

    try {
      const info = await readBookInfo(filePath);
      results.push({
        folderName,
        fileName,
        title: info.title,
        annotation: info.annotation,
        status: 'ok',
      });
    } catch (error) {
      results.push({
        folderName,
        fileName,
        title: 'Ошибка чтения книги',
        annotation: error.message,
        status: 'error',
      });
    }
  }

  return results;
}

module.exports = {
  scanBooks,
};
