const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

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

function findEndOfCentralDirectory(buffer) {
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
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory header');
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    entries.push({
      fileName,
      compressionMethod,
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
  if (buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error('Invalid ZIP local file header');
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const compressedData = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressedData;
  }

  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(compressedData);
  }

  throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
}

async function readFb2File(filePath) {
  const buffer = await fs.readFile(filePath);
  return decodeXmlBuffer(buffer);
}

async function readFb2FromZip(filePath) {
  const buffer = await fs.readFile(filePath);
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

async function readBookInfo(filePath) {
  const lower = filePath.toLowerCase();
  const xml = lower.endsWith('.fb2.zip') ? await readFb2FromZip(filePath) : await readFb2File(filePath);
  return extractBookInfoFromXml(xml);
}

module.exports = {
  decodeXmlBuffer,
  extractBookInfoFromXml,
  readBookInfo,
};
