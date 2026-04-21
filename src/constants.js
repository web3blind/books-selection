const BOOK_STATUSES = {
  OK: 'ok',
  MISSING: 'missing',
  ERROR: 'error',
};

const BOOK_REASONS = {
  OK: 'ok',
  ANNOTATION_MISSING: 'annotation_missing',
  BOOK_FILE_NOT_FOUND: 'book_file_not_found',
  BOOK_READ_ERROR: 'book_read_error',
};

const ANNOTATION_MISSING_TEXT = 'Аннотация не найдена.';
const BOOK_FILE_NOT_FOUND_TITLE = 'Файл книги не найден';
const BOOK_FILE_NOT_FOUND_ANNOTATION = 'В этой папке не найдено ни одного файла .fb2 или .fb2.zip.';
const BOOK_READ_ERROR_TITLE = 'Ошибка чтения книги';

module.exports = {
  BOOK_STATUSES,
  BOOK_REASONS,
  ANNOTATION_MISSING_TEXT,
  BOOK_FILE_NOT_FOUND_TITLE,
  BOOK_FILE_NOT_FOUND_ANNOTATION,
  BOOK_READ_ERROR_TITLE,
};
