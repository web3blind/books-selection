const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const { scanBooks } = require('./scan');

const publicDir = path.join(__dirname, '..', 'public');
const defaultRoot = process.argv[2] || '';
const port = Number(process.argv[3] || process.env.PORT || 3210);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload, null, 2));
}

async function sendFile(response, filePath, contentType) {
  const content = await fs.readFile(filePath);
  response.writeHead(200, { 'content-type': `${contentType}; charset=utf-8` });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);

    if (url.pathname === '/api/books') {
      const root = url.searchParams.get('root') || defaultRoot;

      if (!root) {
        return sendJson(response, 400, { error: 'Нужен путь к папке с книгами.' });
      }

      const books = await scanBooks(root);
      return sendJson(response, 200, { root, count: books.length, books });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return sendFile(response, path.join(publicDir, 'index.html'), 'text/html');
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  const rootText = defaultRoot ? `\nПапка книг: ${defaultRoot}` : '';
  console.log(`Books Selection запущен: http://127.0.0.1:${port}${rootText}`);
});
