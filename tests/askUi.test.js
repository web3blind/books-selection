const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page(language) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', hidden: false, checked: false, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelectorAll: () => [], focus() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: node, documentElement: {}, querySelectorAll: () => [], addEventListener() {} },
    window: { __booksSelectionLanguage: language, addEventListener() {} },
    location: { search: '', href: 'http://localhost/' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    URL, URLSearchParams, AbortController, console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => new Promise(() => {}),
  });
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  return { context, node };
}

for (const language of ['ru', 'en']) {
  test(`guided Ask renders honest coverage and escaped search details (${language})`, () => {
    const { context, node } = page(language);
    context.result = {
      status: 'answered', answer: 'A selected passage', confidence: 0.9,
      coverage: { searchComplete: true, totalCycles: 3, totalBooks: 6, retrievedChunks: 2, representedBooks: 1 },
      research: { searches: [{ query: '<img src=x onerror=alert(1)>' }], chatCalls: 3, persistedFacts: 1 },
      evidence: [], citedEvidence: [], cycleGroups: [],
    };
    vm.runInContext('renderAskResult(result)', context);
    const output = node('aiResults').innerHTML;
    assert.match(output, language === 'ru' ? /выборочная проверка/ : /selective check/);
    assert.match(output, language === 'ru' ? /Как искали/ : /Search details/);
    assert.ok(output.includes('&lt;img'));
    assert.ok(!output.includes('<img'));
    assert.ok(!output.includes('0.9'));
    context.result = { status: 'corpus_not_ready', coverage: { searchComplete: false, retrievedChunks: 0 } };
    vm.runInContext('renderAskResult(result)', context);
    assert.doesNotMatch(node('aiResults').innerHTML, /Проверен весь индекс|Entire index checked/);
  });

  test(`guided Ask distinguishes an AI evidence-insufficient result (${language})`, () => {
    const { context, node } = page(language);
    context.result = {
      status: 'evidence_insufficient',
      answer: language === 'ru' ? 'Недостаточно подтверждённых данных.' : 'There is not enough supported evidence.',
      uncertainty: language === 'ru' ? 'Неподтверждённый текст модели не показан.' : 'Unsupported model prose was not shown.',
      coverage: { searchComplete: true, totalCycles: 1, totalBooks: 1, retrievedChunks: 1, representedBooks: 1 },
      research: { searches: [], chatCalls: 3, persistedFacts: 0 },
      evidence: [], citedEvidence: [], cycleGroups: [], checked: { books: [] },
    };
    vm.runInContext('renderAskResult(result)', context);
    const output = node('aiResults').innerHTML;
    assert.match(output, language === 'ru' ? /обработать через ИИ: да/i : /Processed through AI: yes/i);
    assert.match(output, language === 'ru' ? /доказательств недостаточно/i : /insufficient evidence/i);
    assert.doesNotMatch(output, language === 'ru' ? /обработать через ИИ: нет/i : /Processed through AI: no/i);
  });
}
