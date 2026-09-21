const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeSearchDatabase } = require('../src/searchDb');
const { runAskResearch } = require('../src/askResearch');

function addBook(db, cycle, fileName, title, text) {
  const bookId = Number(db.prepare(`INSERT INTO books
    (cycle_name,folder_path,file_path,file_size,mtime_ms,content_hash,title,annotation,index_status)
    VALUES (?,?,?,1,1,?,?,'','indexed')`).run(cycle, `/library/${cycle}`, `/library/${cycle}/${fileName}`, `h-${cycle}-${fileName}`, title).lastInsertRowid);
  const chunkId = Number(db.prepare(`INSERT INTO chunks
    (book_id,chunk_index,text,content_hash,start_offset,end_offset) VALUES (?,0,?,?,0,?)`)
    .run(bookId, text, `c-${bookId}`, text.length).lastInsertRowid);
  return { bookId, chunkId, cycle, title, text, hash: `c-${bookId}` };
}

function evidenceRow(book) {
  return { chunk_id: book.chunkId, book_id: book.bookId, cycle_name: book.cycle, title: book.title,
    chunk_index: 0, snippet: book.text, content_hash: book.hash, source: 'semantic' };
}

function refsByBook(prompt) {
  const result = new Map();
  const re = /<untrusted_book_text id="([^"]+)" book_id="(\d+)"/g;
  for (let match; (match = re.exec(prompt));) result.set(Number(match[2]), match[1]);
  return result;
}

function finalCheck(bookId, evidenceId) {
  return { bookId, verdict: 'supported', evidence: [evidenceId], reason: 'Direct passage.',
    entities: [{ name: 'hero', evidence: [evidenceId] }],
    criteria: [{ criterion: 'requested topic', verdict: 'supported', reason: 'Direct passage.', evidence: [evidenceId] }] };
}

test('recommendation screens every first book across 23 cycles, uses natural file order, and can expand a no-evidence cycle', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const books = [];
    for (let index = 1; index <= 22; index += 1) {
      books.push(addBook(db, `Cycle ${String(index).padStart(2, '0')}`, '01.fb2', `First ${index}`, `topic passage ${index}`));
    }
    const natural10 = addBook(db, 'Natural', '10.fb2', 'Ten', 'wrong ten');
    const natural2 = addBook(db, 'Natural', '2.fb2', 'Two', 'wrong two');
    const natural01 = addBook(db, 'Natural', '01.fb2', 'One', 'first natural topic');
    const later = addBook(db, 'Natural', '20.fb2', 'Late Match', 'late volume directly proves topic');
    const byId = new Map([...books, natural10, natural2, natural01, later].map((book) => [book.bookId, book]));
    const retrievalScopes = [];
    let screenCalls = 0;
    const result = await runAskResearch({
      db,
      question: 'Найди цикл про нужную тему',
      providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async ({ messages }) => {
        const phase = messages[0].content;
        const prompt = messages[1].content;
        if (phase.includes('plan phase')) return { intentType: 'recommendation', queries: [] };
        if (phase.includes('screening a small batch')) {
          screenCalls += 1;
          const refs = refsByBook(prompt);
          return { candidateChecks: [...refs].map(([bookId, evidenceId]) => ({ bookId, verdict: 'uncertain', evidence: [evidenceId], reason: 'Needs later volumes.' })) };
        }
        const refs = refsByBook(prompt);
        const evidenceId = refs.get(later.bookId);
        return { status: 'answered', answer: 'Подходит Natural.', confidence: 'medium', uncertainty: 'Проверены отрывки.',
          evidence: [evidenceId], recommendations: [{ bookId: later.bookId, evidence: [evidenceId] }],
          finalCandidateChecks: [finalCheck(later.bookId, evidenceId)] };
      } },
      retrievalFn: async ({ scope, queryEmbeddingCache }) => {
        assert.ok(queryEmbeddingCache instanceof Map);
        retrievalScopes.push([...scope.bookIds]);
        const selected = scope.bookIds.map((id) => byId.get(id)).filter(Boolean);
        // The natural first book deliberately has no first-book match. Its later volume does.
        const rows = selected.filter((book) => book.bookId !== natural01.bookId && (book.bookId === later.bookId || !['Ten', 'Two'].includes(book.title))).map(evidenceRow);
        // Include a foreign row to prove the orchestrator enforces requested source IDs.
        if (scope.bookIds.length === 1 && scope.bookIds[0] !== books[0].bookId) rows.unshift(evidenceRow(books[0]));
        return { evidence: rows, semantic: { status: 'searched' } };
      },
    });

    const coverage = result.research.cycleCoverage;
    assert.equal(coverage.totalCycles, 23);
    assert.equal(coverage.firstBooksSearched, 23);
    assert.equal(coverage.firstBooksReviewed, 22);
    assert.equal(coverage.incompleteCycles, 0);
    assert.equal(coverage.complete, true);
    assert.equal(screenCalls, 6);
    assert.equal(result.research.embeddingQueries, 1);
    assert.equal(coverage.cycles.at(-1).cycle, 'Natural');
    assert.equal(coverage.cycles.at(-1).firstBookId, natural01.bookId);
    assert.equal(coverage.cycles.at(-1).firstBookTitle, 'One');
    assert.equal(coverage.cycles.at(-1).searched, true);
    assert.equal(coverage.cycles.at(-1).reviewed, false);
    assert.equal(coverage.cycles.at(-1).expanded, true);
    assert.equal(coverage.cycles.at(-1).status, 'supported');
    assert.ok(retrievalScopes.some((ids) => ids.includes(later.bookId)));
    assert.equal(result.candidates[0].bookId, later.bookId);
    assert.ok(result.evidence.some((item) => item.bookId === books.at(-1).bookId), 'late cycles retain evidence');
  } finally { db.close(); }
});

test('omitted cycle review stays unreviewed and makes coverage incomplete, never rejected', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const first = addBook(db, 'A', '1.fb2', 'A1', 'topic A');
    const second = addBook(db, 'B', '1.fb2', 'B1', 'topic B');
    const result = await runAskResearch({
      db, question: 'Найди цикл про topic', providerName: 'mock', provider: { model: 'mock' },
      providerClient: { chatCompletion: async ({ messages }) => {
        const phase = messages[0].content;
        if (phase.includes('plan phase')) return { intentType: 'recommendation', queries: [] };
        if (phase.includes('screening a small batch')) {
          const ref = refsByBook(messages[1].content).get(first.bookId);
          return { candidateChecks: [{ bookId: first.bookId, verdict: 'uncertain', evidence: [ref], reason: 'Partial.' }] };
        }
        return { status: 'evidence_insufficient', recommendations: [] };
      } },
      retrievalFn: async ({ scope }) => ({ evidence: scope.bookIds.map((id) => evidenceRow(id === first.bookId ? first : second)), semantic: { status: 'searched' } }),
    });
    const coverage = result.research.cycleCoverage;
    assert.equal(coverage.complete, false);
    assert.equal(coverage.firstBooksReviewed, 1);
    assert.equal(coverage.incompleteCycles, 1);
    assert.equal(coverage.cycles.find((item) => item.cycle === 'B').status, 'unreviewed');
    assert.deepEqual(result.research.rejectedCycles, []);
  } finally { db.close(); }
});


test('synthesis retains every cycle beyond old global cap and refinement does not renumber evidence', async () => {
  const db = initializeSearchDatabase(':memory:');
  try {
    const books = Array.from({length: 26}, (_, i) => addBook(db, `Cycle ${String(i).padStart(2, '0')}`, '01.fb2', `Book ${i}`, 'direct topic '.repeat(330)));
    const ids = new Map(books.map(b => [b.bookId, b]));
    const seenRefs = new Map();
    let requestedRefine = false;
    const result = await runAskResearch({db, question:'Найди цикл по теме', providerName:'mock',provider:{model:'mock'},
      providerClient:{chatCompletion:async({messages})=>{
        const phase = messages[0].content, prompt = messages[1].content;
        if (phase.includes('plan phase')) return {intentType:'recommendation',queries:[]};
        const refs=refsByBook(prompt);
        if (phase.includes('screening a small batch')) {
          for (const [book,id] of refs) seenRefs.set(book,id);
          const additionalQueries = requestedRefine ? [] : [{query:'дополнительная тема'}];
          requestedRefine=true;
          return {candidateChecks:[...refs].map(([bookId,id])=>({bookId,verdict:'supported',evidence:[id],reason:'Direct text.'})),additionalQueries};
        }
        assert.equal(refs.size,26,'every screened cycle must retain a synthesis slot');
        for (const [book,id] of refs) assert.equal(id,seenRefs.get(book));
        return {status:'evidence_insufficient',recommendations:[]};
      }},
      retrievalFn:async({scope})=>({evidence:(scope.bookIds.length?scope.bookIds.map(id=>ids.get(id)):[books[0]]).map(evidenceRow),semantic:{status:'searched'}})
    });
    assert.equal(result.research.cycleCoverage.firstBooksReviewed,26);
    assert.ok(result.research.chatCalls<=result.research.limits.maxChatCalls);
  } finally {db.close();}
});

test('cancellation during cycle screening stops before later batches or synthesis', async () => {
  const db=initializeSearchDatabase(':memory:');const controller=new AbortController();let screens=0;
  try {
    const books=Array.from({length:9},(_,i)=>addBook(db,`Cycle ${i}`,'01.fb2',`Book ${i}`,'topic passage'));
    await assert.rejects(runAskResearch({db,question:'Найди цикл по теме',providerName:'mock',provider:{model:'mock'},signal:controller.signal,
      providerClient:{chatCompletion:async({messages})=>{
        if(messages[0].content.includes('plan phase'))return{intentType:'recommendation',queries:[]};
        screens++;controller.abort();return{candidateChecks:[]};
      }},retrievalFn:async({scope})=>({evidence:books.filter(b=>scope.bookIds.includes(b.bookId)).map(evidenceRow),semantic:{status:'searched'}})
    }), /abort|cancel|отмен/i);
    assert.equal(screens,1);
  } finally {db.close();}
});
