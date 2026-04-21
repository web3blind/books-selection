const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

async function readFb2File(filePath) {
  const buffer = await fs.readFile(filePath);
  return decodeXmlBuffer(buffer);
}

async function readFb2FromZip(filePath) {
  const script = [
    'import sys, zipfile',
    'path = sys.argv[1]',
    'with zipfile.ZipFile(path) as zf:',
    '    names = [n for n in zf.namelist() if n.lower().endswith(".fb2")]',
    '    if not names:',
    '        raise SystemExit(2)',
    '    data = zf.read(names[0])',
    '    sys.stdout.buffer.write(data)',
  ].join('\n');

  const result = spawnSync('python3', ['-c', script, filePath], {
    encoding: null,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf-8', 0, 500) : '';
    throw new Error(`Не удалось прочитать zip: ${path.basename(filePath)} ${stderr}`.trim());
  }

  return decodeXmlBuffer(result.stdout);
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
