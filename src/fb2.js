const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_FB2_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 1000;
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function detectXmlEncoding(buffer) {
  const header = buffer.subarray(0, Math.min(buffer.length, 512)).toString('ascii');
  const match = header.match(/encoding\s*=\s*["']([^"']+)["']/i);
  return match ? match[1].toLowerCase() : 'utf-8';
}

function decodeXmlBuffer(buffer) {
  const encoding = detectXmlEncoding(buffer);

  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(text) {
  return decodeEntities(text.replace(/<[^>]+>/g, ' '));
}

function normalizeWhitespace(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTagContent(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1] : '';
}

function extractParagraphs(xmlFragment) {
  const paragraphs = [...xmlFragment.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => normalizeWhitespace(stripTags(match[1])))
    .filter(Boolean);

  if (paragraphs.length > 0) {
    return paragraphs.join('\n\n');
  }

  return normalizeWhitespace(stripTags(xmlFragment));
}

function extractBookInfoFromXml(xml) {
  const title = normalizeWhitespace(stripTags(extractTagContent(xml, 'book-title'))) || 'Без названия';
  const annotationRaw = extractTagContent(xml, 'annotation');
  const annotation = annotationRaw
    ? extractParagraphs(annotationRaw)
    : 'Аннотация не найдена.';

  return { title, annotation };
}

function extractBodyTextFromXml(xml) {
  const bodyRaw = extractTagContent(xml, 'body');
  return bodyRaw ? extractParagraphs(bodyRaw) : '';
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function chunkText(text, options = {}) {
  const maxChars = options.maxChars || 4000;
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error('maxChars must be a positive integer.');
  }
  const normalized = normalizeWhitespace(text);
  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    while (cursor < normalized.length && /\s/u.test(normalized[cursor])) cursor += 1;
    if (cursor >= normalized.length) break;

    const hardEnd = Math.min(cursor + maxChars, normalized.length);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const window = normalized.slice(cursor, hardEnd);
      let sentenceEnd = -1;
      for (const match of window.matchAll(/[.!?。！？](?=\s|$)/gu)) {
        sentenceEnd = match.index + match[0].length;
      }
      if (sentenceEnd > 0) {
        end = cursor + sentenceEnd;
      } else {
        const whitespace = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'), window.lastIndexOf('\t'));
        if (whitespace > 0) end = cursor + whitespace;
      }
    }

    while (end > cursor && /\s/u.test(normalized[end - 1])) end -= 1;
    if (end <= cursor) end = hardEnd;
    const chunk = normalized.slice(cursor, end);
    chunks.push({
      index: chunks.length,
      text: chunk,
      contentHash: hashText(chunk),
      startOffset: cursor,
      endOffset: end,
    });
    cursor = end;
  }

  return chunks;
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) throw new Error('ZIP central directory not found');
  const signature = 0x06054b50;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  throw new Error('ZIP central directory not found');
}

function readZipEntries(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const entriesCount = buffer.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = [];

  let offset = centralDirectoryOffset;
  for (let index = 0; index < entriesCount; index += 1) {
    if (offset < 0 || offset + 46 > buffer.length) {
      throw new Error('Invalid ZIP central directory bounds');
    }
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory header');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const expectedCrc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > buffer.length) throw new Error('Invalid ZIP central directory entry bounds');
    if ([compressedSize, uncompressedSize, localHeaderOffset].includes(0xffffffff)) {
      throw new Error('ZIP64 entries are not supported');
    }
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    entries.push({
      fileName,
      flags,
      compressionMethod,
      expectedCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function extractZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (offset < 0 || offset + 30 > buffer.length) {
    throw new Error('Invalid ZIP local file header bounds');
  }
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error('Invalid ZIP local file header');
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if ((entry.flags & 1) !== 0 || (buffer.readUInt16LE(offset + 6) & 1) !== 0) {
    throw new Error('Encrypted ZIP entries are not supported');
  }
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
    throw new Error('ZIP entry exceeds the uncompressed safety limit');
  }
  if (entry.compressedSize > MAX_ZIP_FILE_BYTES || dataOffset < 0 || dataEnd > buffer.length) {
    throw new Error('ZIP entry exceeds compressed data bounds');
  }
  if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
    throw new Error('ZIP entry has an invalid compression ratio');
  }
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_ZIP_COMPRESSION_RATIO) {
    throw new Error('ZIP entry exceeds the compression-ratio safety limit');
  }
  const compressedData = buffer.subarray(dataOffset, dataEnd);

  let extracted;
  if (entry.compressionMethod === 0) {
    extracted = compressedData;
  } else if (entry.compressionMethod === 8) {
    extracted = zlib.inflateRawSync(compressedData, { maxOutputLength: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES });
  } else {
    throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
  }

  if (crc32(extracted) !== entry.expectedCrc32) {
    throw new Error('ZIP entry CRC32 verification failed');
  }
  return extracted;
}

function assertBookSourceSize(filePath, size) {
  const isZip = filePath.toLowerCase().endsWith('.fb2.zip');
  const limit = isZip ? MAX_ZIP_FILE_BYTES : MAX_FB2_FILE_BYTES;
  if (size > limit) {
    throw new Error(`${isZip ? 'ZIP archive' : 'FB2 source'} exceeds the ${limit}-byte safety limit.`);
  }
}

async function readFb2File(filePath, source = {}) {
  const stat = source.stat || await fs.stat(filePath);
  assertBookSourceSize(filePath, stat.size);
  const buffer = source.buffer || await fs.readFile(filePath);
  return decodeXmlBuffer(buffer);
}

async function readFb2FromZip(filePath, source = {}) {
  const stat = source.stat || await fs.stat(filePath);
  assertBookSourceSize(filePath, stat.size);
  const buffer = source.buffer || await fs.readFile(filePath);
  const entries = readZipEntries(buffer);
  const entry = entries.find((item) => item.fileName.toLowerCase().endsWith('.fb2'));

  if (!entry) {
    throw new Error(`Не удалось прочитать zip: ${path.basename(filePath)} .fb2 file not found inside archive`);
  }

  const xmlBuffer = extractZipEntry(buffer, entry);

  if (entry.uncompressedSize && xmlBuffer.length !== entry.uncompressedSize) {
    throw new Error(`Не удалось прочитать zip: ${path.basename(filePath)} invalid uncompressed size`);
  }

  return decodeXmlBuffer(xmlBuffer);
}

async function readBookDocument(filePath, source = {}) {
  const lower = filePath.toLowerCase();
  const xml = lower.endsWith('.fb2.zip')
    ? await readFb2FromZip(filePath, source)
    : await readFb2File(filePath, source);
  return {
    ...extractBookInfoFromXml(xml),
    bodyText: extractBodyTextFromXml(xml),
  };
}

async function readBookInfo(filePath) {
  const { title, annotation } = await readBookDocument(filePath);
  return { title, annotation };
}

module.exports = {
  assertBookSourceSize,
  chunkText,
  decodeXmlBuffer,
  extractBookInfoFromXml,
  extractBodyTextFromXml,
  readBookDocument,
  readBookInfo,
};
