// Controlled provider for connected tests and local browser QA; never calls a network.
function createAskProvider({ onRequest = () => {} } = {}) {
  return async (url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    onRequest(String(url), body);
    let payload;
    if (String(url).endsWith('/credits')) {
      payload = { data: { total_credits: 10, total_usage: 0 } };
    } else if (String(url).endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      payload = { data: inputs.map((_, index) => ({ index, embedding: [1, 0] })) };
    } else if (String(url).endsWith('/chat/completions')) {
      const system = body.messages[0].content;
      const prompt = body.messages.at(-1).content;
      let result;
      if (system.includes('plan phase')) {
        result = { intent: 'Совместный путь двух центральных персонажей, а не совпадение слов', queries: [{ query: 'Лира Марк обучение путешествие' }, { query: 'Герой вместе' }] };
      } else {
        const passages = [...prompt.matchAll(/<untrusted_book_text id="([^"]+)" book_id="(\d+)"[^>]*>\s*([^\n]+)\s*<\/untrusted_book_text>/g)]
          .map((match) => ({ id: match[1], bookId: Number(match[2]), ...JSON.parse(match[3]) }));
        const good = passages.find((item) => item.cycle === 'Путь двоих' && item.excerpt.includes('Лира'));
        const bad = passages.find((item) => item.cycle === 'Ложный след');
        if (!good) throw new Error('Connected test did not retrieve the expected source passage');
        if (system.includes('check phase')) {
          result = {
            candidateChecks: [
              { bookId: good.bookId, verdict: 'supported', evidence: [good.id], reason: 'Оба учатся и путешествуют.' },
              ...(bad ? [{ bookId: bad.bookId, verdict: 'rejected', evidence: [bad.id], reason: 'Герой здесь титул.' }] : []),
            ],
            rejectedCycles: ['Ложный след'],
            additionalQueries: [{ query: 'Марк Лира разлука', cycleNames: ['Путь двоих'] }],
          };
        } else {
          result = {
            status: 'answered',
            answer: 'Похоже, подходит «Путь двоих»: Лира и Марк учатся и путешествуют вместе. Весь цикл не проверен.',
            confidence: 'medium', uncertainty: 'Вывод ограничен прочитанными отрывками.', evidence: [good.id],
            recommendations: [{ bookId: good.bookId, evidence: [good.id] }], rejectedCycles: ['Ложный след'],
            finalCandidateChecks: [{
              bookId: good.bookId, verdict: 'supported', evidence: [good.id], reason: 'Лира и Марк названы и совместно путешествуют.',
              entities: [{ name: 'Лира и Марк', evidence: [good.id] }],
              criteria: [{ criterion: 'действуют вместе', verdict: 'supported', reason: 'Они путешествуют и помогают друг другу.', evidence: [good.id] }],
            }],
            observations: [{ bookId: good.bookId, factKey: 'pair.journey', factType: 'plot_trait', factValue: 'Лира и Марк путешествуют вместе в этом эпизоде.', confidence: 0.6, evidence: [good.id] }],
          };
        }
      }
      payload = { choices: [{ message: { content: JSON.stringify(result) } }] };
    } else {
      throw new Error(`Unexpected external request in controlled provider: ${url}`);
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

async function writeAskBooks(root) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  for (const [cycle, text] of [
    ['Путь двоих', 'Лира училась лечить, а Марк осваивал защиту. Они путешествовали вдвоём и помогали друг другу. Разлука была недолгой.'],
    ['Ложный след', 'Герой поднял меч. Мы вместе победим, кричали солдаты. Герой здесь титул предводителя, а не рассказ о паре.'],
  ]) {
    await fs.mkdir(path.join(root, cycle), { recursive: true });
    await fs.writeFile(path.join(root, cycle, 'book.fb2'), `<?xml version="1.0"?><FictionBook><description><title-info><book-title>${cycle}</book-title><annotation><p>${text}</p></annotation></title-info></description><body><section><title><p>Начало пути</p></title><p>${text}</p><subtitle>Год спустя</subtitle><p>Путешествие продолжается.</p></section></body><body name="notes"><section><title><p>Примечания</p></title><p>Персонажи в примечании не погибли.</p></section></body></FictionBook>`);
  }
}
module.exports = { createAskProvider, writeAskBooks };
