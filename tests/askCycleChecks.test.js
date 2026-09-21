const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeSearchDatabase } = require('../src/searchDb');
const { runAskResearch } = require('../src/askResearch');

for (const sameCycle of [true, false]) {
  test(`criteria can join books only within the same cycle (${sameCycle})`, async () => {
    const db = initializeSearchDatabase(':memory:');
    try {
      const rows = ['Ира и Тим любили друг друга.', 'В эпилоге Ира и Тим оба живы.'].map((text, i) => {
        const cycle = sameCycle || i === 0 ? 'Путь' : 'Другой';
        const id = Number(db.prepare(`INSERT INTO books (cycle_name,folder_path,file_path,file_size,mtime_ms,content_hash,title,annotation,index_status) VALUES (?,?,?,1,1,?,?,'','indexed')`).run(cycle, '/tmp/test', `/tmp/test/${i}.fb2`, `b${i}`, `Книга ${i}`).lastInsertRowid);
        const cid = Number(db.prepare('INSERT INTO chunks (book_id,chunk_index,text,content_hash,start_offset,end_offset) VALUES (?,0,?,?,0,?)').run(id,text,`c${i}`,text.length).lastInsertRowid);
        return {book_id:id,chunk_id:cid,cycle_name:cycle,title:`Книга ${i}`,chunk_index:0,text,snippet:text,content_hash:`c${i}`,source:'semantic'};
      });
      const final = {answer:'По отрывкам подходит «Путь».', evidence:['evidence_1','evidence_2'], recommendations:[{bookId:rows[0].book_id,evidence:['evidence_1']}],finalCandidateChecks:[{
        bookId:rows[0].book_id,verdict:'supported', evidence:['evidence_1','evidence_2'],
        // A redundant overall reason may be omitted when each condition has its own reason.
        entities:[{name:'Ира',evidence:['evidence_1','evidence_2']},{name:'Тим',evidence:['evidence_1','evidence_2']}],
        criteria:[{criterion:'любят друг друга',verdict:'supported',reason:'Прямо сказано о любви',evidence:['evidence_1']},{criterion:'оба живы',verdict:'supported',reason:'Прямо сказано в эпилоге',evidence:['evidence_2']}]
      }]};
      // Live nano misclassified an explicit find request as question_answer.
      const replies=[{intentType:'question_answer',queries:[{query:'пара любовь финал'}]}, {}, final, {status:'evidence_insufficient', recommendations:[]}];
      const result=await runAskResearch({db,question:'Найди цикл, где герои любят друг друга и оба живы.',providerName:'mock',provider:{model:'mock'},providerClient:{chatCompletion:async()=>replies.shift()},retrievalFn:async()=>({evidence:rows,semantic:{status:'searched'}})});
      assert.equal(result.status,sameCycle?'answered':'evidence_insufficient');
      assert.equal(result.candidates.length,sameCycle?1:0);
      assert.equal(result.citedEvidence.length,sameCycle?2:0);
    } finally { db.close(); }
  });
}
