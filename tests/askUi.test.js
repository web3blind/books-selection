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
  test(`guided Ask renders exact first-book coverage for all 22 cycles (${language})`, () => {
    const { context, node } = page(language);
    const cycles = Array.from({ length: 22 }, (_, index) => ({
      cycle: `Cycle ${index + 1}`,
      firstBookId: `book-${index + 1}`,
      firstBookTitle: `First book ${index + 1}`,
      status: 'supported',
      searched: true,
      reviewed: true,
      expanded: false,
    }));
    context.result = {
      status: 'answered', answer: 'Supported answer',
      coverage: { indexReady: true, searchComplete: true, totalCycles: 22, totalBooks: 87, retrievedChunks: 3, representedBooks: 2 },
      research: { searches: [], cycleCoverage: { totalCycles: 22, firstBooksSearched: 22, firstBooksReviewed: 22, noEvidenceCycles: 0, expandedCycles: 0, incompleteCycles: 0, complete: true, cycles } },
      evidence: [], citedEvidence: [], cycleGroups: [],
    };
    vm.runInContext('renderAskResult(result)', context);
    const output = node('aiResults').innerHTML;
    assert.match(output, language === 'ru' ? /В индексе: 22 циклов, 87 книг/ : /Index size: 22 series, 87 books/);
    assert.match(output, language === 'ru' ? /Поиск по первым книгам выполнен: 22 из 22/ : /First books searched: 22 of 22/);
    assert.match(output, language === 'ru' ? /ИИ проверил отрывки первых книг: 22 из 22/ : /First-book excerpts reviewed by AI: 22 of 22/);
    assert.match(output, /Cycle 22/);
    assert.match(output, /First book 22/);
    assert.doesNotMatch(output, language === 'ru' ? /Проверены все циклы/ : /All series were evaluated/);
  });

  test(`guided Ask reports omitted and unreviewed first-book coverage honestly (${language})`, () => {
    const { context, node } = page(language);
    context.result = {
      status: 'evidence_insufficient', answer: '',
      coverage: { indexReady: true, searchComplete: true, totalCycles: 22, totalBooks: 80, retrievedChunks: 1, representedBooks: 1 },
      research: { searches: [], cycleCoverage: {
        totalCycles: 22, firstBooksSearched: 21, firstBooksReviewed: 20, noEvidenceCycles: 0,
        expandedCycles: 0, incompleteCycles: 2, complete: true,
        cycles: [
          { cycle: 'Present cycle', firstBookId: 'present-1', firstBookTitle: 'Present first', status: 'uncertain', searched: true, reviewed: true, expanded: false },
          { cycle: 'Unreviewed cycle', firstBookId: 'waiting-1', firstBookTitle: 'Waiting first', status: 'unreviewed', searched: true, reviewed: false, expanded: false },
        ],
      } },
      evidence: [], citedEvidence: [], cycleGroups: [],
    };
    vm.runInContext('renderAskResult(result)', context);
    const output = node('aiResults').innerHTML;
    assert.match(output, language === 'ru' ? /Поиск по первым книгам выполнен: 21 из 22/ : /First books searched: 21 of 22/);
    assert.match(output, language === 'ru' ? /ИИ проверил отрывки первых книг: 20 из 22/ : /First-book excerpts reviewed by AI: 20 of 22/);
    assert.match(output, language === 'ru' ? /Записей с деталями: 2 из 22/ : /Detailed records: 2 of 22/);
    assert.match(output, language === 'ru' ? /Неопределённо — не отклонено/ : /Uncertain — not rejected/);
    assert.match(output, language === 'ru' ? /Не проверено ИИ/ : /Not reviewed by AI/);
    assert.doesNotMatch(output, language === 'ru' ? /Проверены все циклы/ : /All series were evaluated/);
  });

  test(`guided Ask keeps no-evidence distinct from rejection and reports expansion (${language})`, () => {
    const { context, node } = page(language);
    context.result = {
      status: 'evidence_insufficient', answer: '',
      coverage: { indexReady: true, searchComplete: true, totalCycles: 1, totalBooks: 4, retrievedChunks: 2, representedBooks: 2 },
      research: { searches: [], cycleCoverage: {
        totalCycles: 1, firstBooksSearched: 1, firstBooksReviewed: 1, noEvidenceCycles: 1,
        expandedCycles: 1, incompleteCycles: 0, complete: true,
        cycles: [{ cycle: '<Cycle A>', firstBookId: 'a-1', firstBookTitle: '<First A>', status: 'no_evidence', searched: true, reviewed: true, expanded: true }],
      } },
      evidence: [], citedEvidence: [], cycleGroups: [],
    };
    vm.runInContext('renderAskResult(result)', context);
    const output = node('aiResults').innerHTML;
    assert.match(output, language === 'ru' ? /Расширенный поиск: 1 циклов/ : /Expanded search: 1 series/);
    assert.match(output, language === 'ru' ? /Подтверждения не найдены — не отклонено/ : /No evidence — not rejected/);
    assert.doesNotMatch(output, language === 'ru' ? /Статус: Отклонено/ : /Status: Rejected/);
    assert.ok(output.includes('&lt;Cycle A&gt;'));
    assert.ok(output.includes('&lt;First A&gt;'));
    assert.ok(!output.includes('<Cycle A>'));
  });

  test(`guided Ask preserves legacy research rendering without cycle coverage (${language})`, () => {
    const { context, node } = page(language);
    context.result = {
      status: 'answered', answer: 'Legacy answer',
      coverage: { indexReady: true, searchComplete: true, totalCycles: 3, totalBooks: 6, retrievedChunks: 2, representedBooks: 1 },
      research: { searches: [{ query: 'legacy query' }], chatCalls: 2, persistedFacts: 0 },
      evidence: [], citedEvidence: [], cycleGroups: [{ cycle: 'Legacy candidate', books: [], evidenceCount: 1 }],
    };
    vm.runInContext('renderAskResult(result)', context);
    const output = node('aiResults').innerHTML;
    assert.match(output, language === 'ru' ? /выборочная проверка/ : /selective check/);
    assert.match(output, /legacy query/);
    assert.match(output, /Legacy candidate/);
    assert.doesNotMatch(output, language === 'ru' ? /Охват первых книг по циклам/ : /First-book coverage by series/);
  });

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
    context.result = { status: 'answered', answer: '', coverage: { indexReady: true, searchComplete: false, retrievedChunks: 2, representedBooks: 1 }, research: { searches: [] }, evidence: [], citedEvidence: [], cycleGroups: [] };
    vm.runInContext('renderAskResult(result)', context);
    assert.match(node('aiResults').innerHTML, language === 'ru' ? /Индекс готов.*охват запроса частичный/s : /index is ready.*query coverage is partial/is);
    context.result = { status: 'corpus_not_ready', coverage: { indexReady: false, searchComplete: false, retrievedChunks: 0 } };
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
