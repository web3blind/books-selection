const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenAiCompatibleClient } = require('../src/providerClient');
const { initializeSearchDatabase } = require('../src/searchDb');
const { expandEvidenceContext } = require('../src/retrieval');

test('research output requests reach provider without the old implicit 1024-token ceiling', async () => {
  for (const [requested, configured, expected] of [[2800, undefined, 2800], [50000, undefined, 4096], [undefined, undefined, 1024], [2800, 600, 600], [undefined, 600, 600]]) {
    let sent;
    const client = createOpenAiCompatibleClient({
      provider: { baseUrl: 'http://localhost:12345/v1', model: 'fixture', maxOutputTokens: configured }, apiKey: 'fixture', budgetGuard: null,
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }] }), { status: 200 });
      },
    });
    await client.chatCompletion({ messages: [{ role: 'user', content: 'test' }], maxTokens: requested });
    assert.equal(sent.max_tokens, expected);
  }
});

test('context expansion reserves slots for all ranked hits before their neighbors', () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const targets = [];
    for (let book = 1; book <= 2; book++) {
      db.prepare('INSERT INTO books (id, cycle_name,folder_path,file_path,file_size,mtime_ms,content_hash,title,annotation,index_status) VALUES (?,?,?,?,?,?,?,?,?,?)').run(book, `Cycle ${book}`, '/tmp', `/tmp/book${book}.fb2`, 1, 2, `book${book}`, `Book ${book}`, '', 'indexed');
      for (let index = 0; index < 3; index++) {
        const text = index === 1 ? 'The evidence that actually matches the question.' : 'Surrounding context unrelated to the requested condition.';
        const id = Number(db.prepare('INSERT INTO chunks (book_id,chunk_index,text,content_hash,start_offset,end_offset) VALUES (?,?,?,?,?,?)').run(book,index,text,`${book}-${index}`,0,text.length).lastInsertRowid);
        if (index === 1) targets.push({chunk_id:id,book_id:book,source:book === 1 ? 'fts' : 'semantic'});
      }
    }
    const limited = expandEvidenceContext(db, targets, {neighborRadius:1,limit:2});
    assert.deepEqual(limited.map(row=>row.chunk_id), targets.map(row=>row.chunk_id));
    assert.deepEqual(limited.map(row=>row.source), ['fts','semantic']);
    const extended = expandEvidenceContext(db, targets, {neighborRadius:1,limit:6});
    assert.deepEqual(extended.slice(0,2).map(row=>row.chunk_id),targets.map(row=>row.chunk_id));
    assert.ok(extended.slice(2).every(row=>row.source==='neighbor'));
    assert.equal(new Set(extended.map(row=>row.chunk_id)).size,6);
  } finally { db.close(); }
});
