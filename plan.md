# books-selection plan

## Status

Статус: `v0.4.3` опубликована 2026-09-17 (`https://github.com/web3blind/books-selection/releases/tag/v0.4.3`, коммит `42f6229`): устранено подвисание окна на старте — готовность семантического кеша считается SQL-запросом, а не разбором всех векторов. Опубликованы: `v0.4.2` (кеш карточек циклов), `v0.4.1` (общая проверка незаконченных циклов, отзывчивость при сканировании) и `v0.4.0` (группировка ответов Ask по циклам, избранное с рейтингом, отметки прочитанных циклов, проверка продолжений Author.Today, запоминание языка интерфейса). Hermes provider transport Денис реализует отдельно; до появления транспорта Hermes остаётся внутренним scaffold и не показывается как рабочий выбор в UI.

Основной annotation-browser выполнен. Стратегическое направление: превратить Books Selection в локальный AI/semantic search tool по FB2-библиотеке с SQLite, FTS5, embeddings, графом фактов и несколькими AI provider modes.

## v0.4.1 — проверка всех незаконченных циклов и отзывчивость после запуска

### Что делаем
- Кнопка «Проверить все незаконченные (N)» перед списком незаконченных циклов в разделе «Прочитанное». Проверяются подряд все незаконченные циклы с привязанной страницей Author.Today; остальные пропускаются, рядом пояснение «Проверять можно N из M».
- Проверка последовательная: один запрос на цикл, пауза 1 с между циклами, прогресс «Проверяю 2 из 3: <цикл>…», кнопка «Остановить» (прерывает и текущий запрос, и паузу), в конце сводка: сколько проверено, у кого новые книги, сколько не удалось проверить.
- Одиночная кнопка «Проверить обновления» в карточке остаётся. Автоматических и фоновых проверок по-прежнему нет: единственный источник — нажатие пользователя.

### Почему приложение подвисало после запуска (исправлено)
Наблюдение Дениса: после запуска приложение могло не отвечать некоторое время. Замеры на реальном коде (6 крупных `.fb2.zip` с XML ~6 МБ; библиотека 150 книг, 79 МБ) показали: карточка цикла декодировала и нормализовала всю книгу, включая текст тела, хотя нужны только название и аннотация; в zip дополнительно CRC считался побайтовым циклом на JS. На крупной книге сервер переставал отвечать на 200–255 мс.

Правки:
- `src/fb2.js`: карточка цикла читает только начало документа (`decodeXmlHead`, окно 512 КБ, только если блок `<description>` попал целиком), иначе — прежнее полное чтение; CRC32 — нативный `zlib.crc32`, прежний JS-цикл остался запасным путём; добавлены `readXmlBuffer*` (доступ к буферу до декодирования).
- `src/scan.js`: `yieldToEventLoop()` между книгами; `src/indexer.js` — та же пауза между книгами при индексации.

Замеры (те же фикстуры и тот же метод «опрос сервера во время сканирования», до → после):
- 6 крупных `.fb2.zip`: скан 1587 → 145 мс, максимальная задержка ответа 255 → 18 мс;
- 150 книг, 79 МБ: скан 3216 → 769 мс, максимальная задержка ответа 26 → 8 мс.

### Проверка 0.4.1
- `npm test` — 236/236 (добавлены три теста окна разбора fb2 и контракты кнопки в `tests/uiStatic.test.js`).
- Живой прогон: 3 цикла, два привязаны к реальным страницам Author.Today (59866, 47167):
  - кнопка «Проверить все незаконченные (2)» и пояснение «Проверять можно 2 из 3…»;
  - прогресс «Проверяю 1 из 2: Барьер…» → «Проверяю 2 из 2: Первый суд…» → «Проверено 2 из 2. Новых книг нет.»;
  - «Остановить» на середине → «Проверка остановлена: проверено 1 из 2.», без ложной ошибки;
  - имитация новой книги (снимок «Первый суд» уменьшен до одной книги) → «Проверено 2 из 2. Новые книги: Первый суд (2).» и записи в «Есть продолжение»;
  - одиночная проверка в карточке после рефакторинга — «Новых книг нет: Барьер.»;
  - индексация после правок fb2 отработала, аннотации циклов на главной корректны.

## v0.4.3 — подвисание окна на старте: разбор всех эмбеддингов

### Что нашли
- На старте страница запрашивает `/api/embedding-status`, а обработчик разбирал JSON каждого сохранённого вектора (`JSON.parse` + проверка всех чисел), чтобы посчитать готовность семантического кеша.
- Встроенный сервер работает в том же процессе, что и окно Electron, поэтому эта работа блокировала окно: на базе с 20 000 эмбеддингов запрос занимал **6021 мс**, и окно всё это время было пустым с подписью «Не отвечает». Остальные стартовые запросы: `/api/config` 5 мс, избранное 7–15 мс, отметки 5 мс, привязки 5 мс, `/api/books` 23–32 мс.
- Кеш карточек из 0.4.2 закрывал другое место (чтение книг при построении списка), поэтому подвисание сохранялось.

### Что сделали
- Готовность считается SQL-запросом без разбора векторов; размерность проверяется только там, где она известна (путь Ask), фильтром `json_array_length`.
- Дополнительно проверяются 20 записей на корректность JSON: если среди них есть битая, готовность считается точным запросом с `json_valid`, чтобы значение не завышалось.

### Замеры (база 363 МБ: 23 526 чанков, 20 000 эмбеддингов размерности 1536)
- `/api/embedding-status`: 6021 мс → **62 мс**;
- сумма всех стартовых запросов: **149 мс**;
- внутри замеров: подсчёт записей 23 мс, выборка 20 векторов без соединений и сортировки 1 мс (с соединениями и сортировкой было 120 мс).

## v0.4.2 — быстрый старт: кеш карточек циклов

### Что делаем
- Кеш карточек рядом с базой (`<db>.cards.json`). Ключ кеша — состав папки книг: список подпапок циклов и имя файла книги в каждой. Пока состав не изменился, при запуске не читается ни одна книга.
- Если состав изменился (цикл добавлен, удалён, в папке появился файл с другим именем), разбираются только новые или изменившиеся папки, остальные карточки берутся из кеша.
- Кнопка «Обновить» осознанно перечитывает все книги и перезаписывает кеш: это выход из кеша, если файл заменили под тем же именем.
- Кеш — производные данные: его можно удалить в любой момент, он соберётся заново; битый или чужой кеш игнорируется, ошибка чтения книги не запоминается и книга читается снова в следующий раз.
- Без пути к базе кеша нет, список собирается как раньше (браузерный режим без SQLite сохраняется).

### Замеры (фикстур: 400 циклов, 541 МБ — 200 обычных .fb2 и 200 .fb2.zip)
- readdir (папки и имена файлов): 20 мс; stat на книгу: 9 мс; живое сканирование (как было): 4928 мс.
- Холодный старт через сервер: 5312 мс → повторный запрос 27 мс из кеша.
- Запуск приложения с готовым кешем: 33 мс на список из 400 циклов, максимальная задержка других ответов 7 мс.
- Добавление цикла: 28 мс (разобран только новый), удаление цикла: 23 мс.
- Кнопка «Обновить»: 4305 мс (полное перечитывание по явному действию).

## Active audit remediation

## Planned — Избранное и рейтинг циклов по запросам

### Scope and non-goals

- Добавлять цикл в избранное вручную одной кнопкой с карточки результатов или со страницы «Избранное».
- Рейтинг считается только для циклов, которые уже добавлены в избранное; остальные результаты на рейтинг не влияют.
- Источник рейтинга — ответ Ask («Вопрос по циклам», кнопка «Найти ответ») и его список «Найденные варианты». Обычный поиск по циклу и аннотации в рейтинге не участвует.
- В расчёт входит только попадание в топ-5 списка найденных вариантов; позиции ниже пятой баллов не начисляют.
- Повторный запуск того же запроса не считается новым событием и не начисляет баллы дважды.
- Запросы, выполненные до добавления цикла в избранное, не учитываются: история начинается с момента добавления. Обратного пересчёта нет.
- Не менять существующее локальное ранжирование поиска, не отправлять запросы и историю в сеть, не добавлять AI-анализ поверх рейтинга.
- Не менять порядок основной выдачи: рейтинг избранного влияет только на страницу «Избранное».

### Scoring algorithm (предложение, требует подтверждения)

1. После ответа Ask сервер берёт порядок циклов в списке «Найденные варианты» — тот порядок, который пользователь реально видит. Кандидаты сгруппированы по книге внутри цикла, поэтому позиция цикла определяется его первым кандидатом; остальные книги того же цикла позицию не дублируют и баллов не добавляют.
2. Запрос нормализуется — trim, нижний регистр, схлопывание пробелов. Ключ события: (cycle_key, нормализованный запрос).
2а. Учитывается только ответ с непустым списком найденных вариантов: `answered` и локальный fallback без настроенного ключа. `no_evidence` и `corpus_not_ready` баллов не начисляют.
3. Для избранного цикла в позициях 1–5 начисляются баллы: 1-е место — 5, 2-е — 4, 3-е — 3, 4-е — 2, 5-е — 1.
4. Для пары (цикл, запрос) хранится лучшая достигнутая позиция `best_position`; повтор того же запроса обновляет позицию и счётчик запусков, но баллы не добавляет.
5. Рейтинг цикла = сумма баллов по всем его уникальным запросам. Дополнительно хранится число запросов, где цикл был первым (`leader_count`), и общее число уникальных запросов (`query_count`).
6. Начальный порядок «Избранного» строится по рейтингу по убыванию, затем по `leader_count`, затем по имени цикла. Дальше порядок можно менять вручную кнопками «Вверх на 1» / «Вниз на 1».
7. Агрегированный балл не хранится: он вычисляется из hits-таблицы, чтобы значение не расходилось с историей.

Отклонённые варианты: reciprocal rank (`1/r`) как основная шкала — менее понятен пользователю при отображении; накопление без дедупликации — один повторяемый запрос начинал бы управлять рейтингом; аддитивный ручной «boost» к баллам — кнопка «Вверх на 1» могла бы не сдвигать карточку при большом разрыве в рейтинге.

### Ручной порядок

- Порядок избранного хранится явно (`sort_position`), начальное значение — порядок по рейтингу.
- «Вверх на 1» / «Вниз на 1» меняет карточку местами с соседней и сохраняет новый порядок. Это ровно один шаг по списку и не зависит от разрыва в баллах.
- Кнопка «Сортировать по рейтингу» пересобирает порядок из актуального рейтинга; она отменяет ручной порядок, поэтому требует подтверждения.
- Новое избранное добавляется в конец списка; порядок по рейтингу восстанавливается кнопкой «Сортировать по рейтингу». Отдельного отображения по имени или автору в этой версии нет.

### Стало (выполнено)

- `src/favorites.js` хранит избранное и историю запросов в таблицах `cycle_favorites` и `cycle_query_hits`; `SCHEMA_VERSION` поднят до 3, база `v0.3.12` получает резервную копию и совместимую миграцию.
- Рейтинг считается из истории: баллы за позиции 1–5 заданы один раз в `POSITION_POINTS` и подставляются в SQL; повтор одного запроса увеличивает только `times_seen`, баллы не дублируются; позиции ниже пятой не учитываются.
- `/api/ask` начисляет баллы избранным циклам по порядку блоков; ошибка записи не ломает ответ (история — удобство, а не часть ответа).
- API: `GET /api/favorites`, `POST /api/cycle-favorite`, `POST /api/favorites/reorder` (`cycle` + `direction` либо `action: rating`), `POST /api/favorites/clear-history` (цикл или всё).
- UI: раздел «Избранное» в навигации, кнопки «В избранное»/«Убрать из избранного» на карточке цикла в ответе Ask и в списке на главной, карточка избранного с рейтингом, числом лидерств и запросов, кнопками «Вверх на 1», «Вниз на 1», снятием отметки и очисткой истории, раскрываемый список запросов с местами.
- Проверено: 203/203 тестов, `git diff --check`, `npm audit --omit=dev` (0 уязвимостей), browser smoke (два запроса дали рейтинг 10 при двух уникальных запросах и не удвоили его при повторе; ручной сдвиг на одну позицию; очистка истории цикла; снятие и повторное добавление сохранило рейтинг) и Electron smoke.

### Data model

- `cycle_favorites`: `cycle_key`, `added_at`, `sort_position`.
- `cycle_query_hits`: `cycle_key`, `query_normalized`, `query_display`, `best_position`, `times_seen`, `first_seen_at`, `last_seen_at`.
- Удаление из избранного останавливает начисление, но историю не стирает; повторное добавление возвращает прежний рейтинг. Отдельная кнопка «Очистить историю» удаляет hits цикла, отдельная — всю историю запросов.
- Миграция совместима с базой `v0.3.12`; существующие таблицы книг, chunks, FTS, embeddings и derived facts не меняются.

### API

- `POST /api/cycle-favorite` — добавить или убрать цикл из избранного; валидация `cycle_key`, сохранение loopback/token/origin protections.
- `GET /api/favorites` — избранное с рейтингом, `leader_count` и списком запросов (запрос и лучшая позиция).
- `POST /api/favorites/reorder` — «Вверх на 1» / «Вниз на 1» и пересборка порядка по актуальному рейтингу.
- `POST /api/favorites/clear-history` — очистка истории по циклу или целиком.
- Начисление выполняется внутри существующего поискового обработчика; ошибка записи не должна ломать выдачу поиска.

### UI and accessibility

- Кнопки «В избранное» / «Убрать из избранного» на карточке цикла в списке «Найденные варианты» ответа Ask и в списке циклов на главной, с понятным доступным названием и состоянием.
- Отдельная страница «Избранное»: имя цикла, автор, рейтинг, «лидер в N запросах», раскрываемый список запросов с позициями.
- Кнопки «Вверх на 1» / «Вниз на 1» в карточке цикла, кнопка пересборки порядка по рейтингу, переключатели отображения, кнопки очистки истории и пустое состояние с объяснением, как считается рейтинг.
- RU/EN синхронно, обычные кнопки и списки, умеренные `aria-live` объявления.

### Tests

- scoring: позиции 1–5 начисляют баллы, позиция 6 — нет; повторный запрос не начисляет; `best_position` обновляется при улучшении.
- избранное-only: неотмеченный цикл баллов не получает.
- миграция и повторный запуск; сохранность существующих книг, chunks, FTS и embeddings.
- API: валидация, добавление/удаление, очистка истории, поиск продолжает работать при ошибке записи.
- ranking: позиция цикла берётся по его первому кандидату; несколько книг одного цикла не поднимают его выше и не начисляют баллы дважды.
- UI static-проверки и browser smoke: отметить цикл, задать вопрос в Ask, увидеть рост рейтинга и список запросов; консоль без ошибок.
- `npm test`, `git diff --check`, `npm audit --omit=dev`.

### Decisions

- Локальный fallback без настроенного AI-ключа начисляет баллы так же, как полноценный ответ: пользователь видит тот же список найденных вариантов, и порядок для него одинаковый.
- Открытых вопросов по алгоритму нет.

## Planned — Группировка найденных вариантов по циклам

### Было (до изменения)

- «Найденные варианты» в ответе Ask — плоский список: один пункт = одна книга, название цикла указано под книгой (`renderCandidates`, `public/index.html`). Если у цикла нашлось несколько книг, цикл повторяется столько раз, сколько книг попало в выдачу.
- Основной список на главной показывает цикл однократно: `src/scan.js` отдаёт одну представительную книгу на цикл. Повторов там нет.
- `renderFtsResults()` в `public/index.html` не вызывается ни из одного места — мёртвый код. Удаление — отдельная мелкая уборка, вне этого слайса.

### Стало (выполнено)

- `groupCandidatesByCycle()` в `src/ask.js` собирает блоки по циклу: порядок групп — по первой книге, внутри группы книги сохраняют исходный порядок; считаются `bookCount`, суммарный `evidenceCount` и объединённые `sources`. Соседние кандидаты одного цикла больше не дублируют цикл.
- Ответ `/api/ask` получил аддитивное поле `cycleGroups`; `candidates` не изменился.
- `renderCycleGroups()` в `public/index.html` рисует нумерованный список циклов: заголовок цикла, «Найдено книг: N, фрагментов: M», источники, затем книги под `details`/`summary` с названием и числом фрагментов; сами фрагменты — внутри спойлера. RU/EN синхронно.
- Проверено: 189/189 тестов, `git diff --check`, `npm audit --omit=dev` (0 уязвимостей), browser smoke с циклом из двух книг (один блок «Dragon Cycle», две книги под спойлерами; второй цикл — отдельный блок) и Electron smoke.

### Целевое поведение

- Один блок на цикл; внутри блока — найденные книги и их фрагменты.
- Заголовок блока: название цикла, автор, «найдено N книг, M фрагментов».
- Порядок блоков — по позиции лучшей книги цикла; книги внутри блока — в порядке своей позиции.
- Состав кандидатов, их порядок в API и раскрываемый список «Все найденные фрагменты» не меняются.
- Кнопка «В избранное» ставится на блок цикла, а не на книгу.

### Non-goals

- Не менять локальное ранжирование, набор кандидатов и основной список циклов на главной.
- Не скрывать найденные фрагменты.

### Why before favorites

- Позиция цикла для рейтинга избранного определяется первой книгой цикла; группировка делает это видимым и понятным.
- Блок цикла — естественное место для кнопки «В избранное».

### Tests

- unit: группировка кандидатов по циклу сохраняет порядок, счётчики и фрагменты; каждый цикл встречается один раз.
- UI static и browser smoke: несколько книг одного цикла дают один блок с вложенным списком; книги внутри — под `details`/`summary`.
- `npm test`, `git diff --check`.

### Decision

- Книги внутри блока цикла показываются под раскрываемым `details`/`summary`, по умолчанию свёрнуто. В заголовке `summary` — название книги и число найденных фрагментов.
- Раскрытие доступно с клавиатуры и экранным диктором; фрагменты остаются в DOM, ничего не подгружается по клику.

## Planned v0.4.0 — прочитанные циклы и продолжения

### Scope and non-goals

- Учитывать только циклы, не отдельные книги.
- Для цикла хранить две независимые отметки: `прочитано` и `цикл не закончен`. Это позволяет отметить, что все доступные книги прочитаны, но автор продолжает цикл.
- Не хранить даты, оценки, заметки и прогресс по отдельным книгам; пользователь не должен заполнять формы после чтения каждой книги.
- Не подключаться к аккаунту Author.Today, не автоматизировать вход и не запускать фоновую проверку по расписанию.

### Completion contract

- `outcome`: пользователь одной кнопкой отмечает цикл прочитанным, при необходимости ставит отметку «Цикл не закончен», находит прочитанное по названию цикла и вручную проверяет привязанные циклы на появление продолжений.
- `verification`: отметки переживают повторное индексирование и перезапуск; прочитанные можно скрыть из основного поиска; раздел «Прочитанное» фильтруется по названию цикла и отдельно показывает незаконченные циклы; добавленный на Author.Today `work_id` и смена статуса цикла обнаруживаются без ложного срабатывания на перестановку книг и на неполную страницу.
- `constraints`: локальная SQLite остаётся источником истины; существующие книги, chunks, FTS, embeddings и пользовательские настройки не теряются; проверка Author.Today выполняется только по явно добавленной пользователем ссылке и не отправляет содержимое FB2.
- `boundaries`: `src/searchSchema.js`, совместимая миграция SQLite, indexer/server API, новый узкий модуль Author.Today, `public/index.html`, focused tests и документация. AI/provider workflow не меняется.
- `stop_when`: публичная страница Author.Today требует авторизацию, правила сайта запрещают такую проверку, разметка не позволяет надёжно выделить ID книг/статус, либо требуется автоматическое сопоставление циклов без подтверждения пользователя.

### Data model

- Добавить локальную запись состояния цикла: стабильный ключ цикла, отображаемое имя, `is_read`, `is_unfinished` и необязательную привязку Author.Today.
- Извлекать авторов из FB2 и агрегировать уникальных авторов на уровне цикла для локального поиска; не показывать отдельные книги как основной объект UI.
- Для привязки Author.Today хранить только нормализованный `series_id`, канонический URL, последний подтверждённый набор `work_id`, последний публичный статус и признак найденного обновления.
- Повторная индексация не должна удалять пользовательские отметки. Удаление/переименование папки не должно молча переносить отметку на другой цикл.

### Стало (выполнено: отметки циклов)

- `src/readingState.js` и таблица `cycle_reading_state` хранят две независимые отметки на цикл: `is_read` и `is_unfinished`; `SCHEMA_VERSION` поднят до 4, новая таблица добавлена в список известных, иначе повторное открытие базы отвергалось (дефект найден тестом и исправлен).
- API: `GET /api/reading`, `POST /api/cycle-reading` (`read` и/или `unfinished`, валидация названия цикла, требование хотя бы одного флага).
- UI: раздел «Прочитанное» в навигации с поиском по названию цикла, подраздел «Незаконченные циклы» и список прочитанных; кнопки «Отметить прочитанным» / «Снять отметку» и «Цикл не закончен» на карточке цикла на главной и в ответе Ask; фильтр «Скрывать прочитанные циклы» включён по умолчанию.
- Проверено: 209/209 тестов, browser smoke (отметка убрала цикл из главной, «Показано 2 из 3, скрыто 1»; подраздел незаконченных; поиск по прочитанным; отключение фильтра вернуло цикл; снятие отметки вернуло цикл в главную) и Electron smoke.

### Осталось

- Ничего из согласованного объёма `v0.4.0`: собрать и опубликовать релиз.

### Стало (выполнено: проверка продолжений Author.Today)

- `src/authorToday.js`: строгая валидация ссылки (только `https://author.today/work/series/<номер>`, без порта, логина и чужих хостов), загрузка с таймаутом 15 с, ограничением 2 МБ, запретом ухода на другой хост при редиректе и проверкой `Content-Type: text/html`; разбор названия цикла, списка книг и признака «завершён/не завершён».
- `src/seriesWatch.js` и таблица `cycle_series` (`SCHEMA_VERSION` 5): привязка цикла к странице Author.Today, снимок списка книг, ручная проверка, признаки `new_works` и `now_complete`, сохранение снимка при ошибке сети.
- API: `GET /api/cycle-series`, `POST /api/cycle-series` (привязка и отвязка), `POST /api/cycle-series/check` (проверка одного цикла).
- UI: в разделе «Прочитанное» на карточке цикла поле для ссылки и «Привязать страницу»; после привязки — название цикла, число книг, признак завершённости, время проверки, «Проверить обновления» и «Отвязать»; отдельный подраздел «Есть продолжение» со списком новых книг и ссылками.
- Ничего не запрашивается само: сеть только по нажатию кнопки, ровно один запрос к `author.today` за нажатие.
- Проверено на живых страницах: 59866 «Барьер» — 1 книга, не завершён; 47167 «Первый суд» — 3 книги, завершён; повторная проверка без изменений; имитация новой книги дала «Есть продолжение» с ссылкой на книгу; отвязка; отказ на чужой ссылке; сохранение снимка при сбое (наблюдался реальный 504 от Author.Today — ошибка показана, данные не испорчены). Тесты: 223/223, Electron smoke.

### Вне объёма

- Извлечение авторов из FB2 и поиск по автору — Денис поиск по автору не планирует.
- Отдельный экспорт отметок — не нужен: `data/books-selection.sqlite` лежит рядом с приложением, поэтому перенос папки переносит и индекс, и отметки. Миграция схемы дополнительно создаёт `<db>.backup-<timestamp>` до изменения.

### Functional slices (TDD)

1. **Schema and migration**
   - Добавить таблицы/поля пользовательского состояния циклов и Author.Today snapshot.
   - Проверить миграцию существующей базы `v0.3.12`, повторный запуск миграции и сохранность всех текущих данных.

2. **Authors and stable cycle identity — отменено, вне объёма**
   - Извлечение авторов из FB2 не реализуется: Денис поиск по автору не планирует (см. «Вне объёма»).

3. **Cycle reading-state API**
   - Добавить чтение и переключение `прочитано`/`цикл не закончен`, снятие отметок и список прочитанных циклов.
   - Валидировать входные данные и сохранить loopback token/origin protections.

4. **Accessible cycle-only UI**
   - На карточке цикла добавить кнопки «Отметить прочитанным»/«Снять отметку» и «Цикл не закончен» без раскрытия списка отдельных книг.
   - Добавить раздел «Прочитанное», поиск по названию цикла, подраздел «Незаконченные циклы», список привязанных циклов и переключатель «Скрывать прочитанные» в основном поиске.
   - Сохранить RU/EN, клавиатурную навигацию, понятные состояния кнопок и умеренные `aria-live` объявления.

5. **Explicit Author.Today binding**
   - Принимать только URL `https://author.today/work/series/{series_id}`; отклонять другие схемы, хосты, credentials, query-based redirects и произвольные URL, чтобы не создать SSRF.
   - Пользователь вручную привязывает страницу к конкретному циклу; автоматический поиск по похожему названию не выполняется.

6. **Manual continuation check**
   - Кнопка «Проверить обновления» загружает ограниченный по размеру публичный HTML с timeout и безопасными redirect rules.
   - Извлекать `work_id`, порядок и публичный статус цикла; новый ID означает продолжение, смена порядка — нет.
   - Показывать раздел «Есть продолжение» и отдельно изменение статуса на «завершён»; при сетевой ошибке сохранять предыдущий snapshot и давать понятный повтор.

7. **Backup and restore — отменено, вне объёма**
   - Отдельный экспорт отметок не нужен: вся пользовательская база лежит в `data/books-selection.sqlite` рядом с приложением и переносится вместе с папкой; миграция схемы создаёт `<db>.backup-<timestamp>`.

8. **Integration and release gate**
   - Проверить полный сценарий на временной библиотеке: отметить цикл, переиндексировать, перезапустить, найти в «Прочитанном», скрыть на главной, привязать fixture страницы Author.Today и обнаружить новый `work_id`.
   - Запустить `npm test`, `git diff --check`, `npm audit --omit=dev`, loopback API/browser smoke и Electron smoke без реального AI provider и без изменения пользовательской SQLite/config.
   - Перед публикацией проверить миграцию на копии существующей базы и все desktop artifacts.

## Visible embedding progress and one-click consent continuity

- `outcome`: во время долгой подготовки пользователь видит живой прогресс, прошедшее время и ожидание текущего provider-пакета; первое нажатие не требует повторного согласия, если после локальной индексации объём не вырос; крупные запуски автоматически делают короткие паузы и отдают управление UI, чтобы desktop-приложение не подвисало.
- `verification`: API сообщает активное состояние и пакетный прогресс без повторного сканирования SQLite; UI опрашивает его во время операции, показывает доступный progress/status и сохраняет отмену; увеличение объёма по-прежнему требует нового согласия; indexer pacing не меняет число отправленных фрагментов и отключён для малых запусков.
- `constraints`: не отправлять больше подтверждённого верхнего лимита; не ослаблять provider/destination checks; не обращаться к реальному OpenRouter; не менять пользовательскую SQLite/config.
- `boundaries`: `src/embeddingIndexer.js`, `src/server.js`, `public/index.html`, focused tests and plan; релиз и version bump отдельно только по явному запросу.
- `stop_when`: исправление потребует фонового persistent job, возобновления после перезапуска приложения или изменения provider API.

## One-click complete embedding preparation

- `outcome`: одно подтверждение и одно нажатие подготавливают embeddings для всех оставшихся фрагментов; повторные пакеты по 1000 и повторные подтверждения не требуются.
- `verification`: indexer обрабатывает весь remaining corpus внутренними provider-batches, UI отправляет `allRemaining`, показывает понятный полный объём и сохраняет отмену/возобновление.
- `constraints`: OpenRouter всё ещё требует явного согласия; provider requests остаются bounded batch-ами; успешные batches сохраняются, поэтому повтор после отмены/ошибки продолжает с остатка.
- `boundaries`: embedding indexer/API/UI, focused tests, version/release artifacts; не менять модели, стоимость provider или пользовательский corpus.
- `stop_when`: provider запрещает batch/объём либо публикация требует замены существующего релиза.

## Release v0.3.11

- `outcome`: опубликовать one-click complete embedding preparation с четырьмя стабильными desktop-артефактами и прямой Windows-ссылкой.
- `verification`: полная desktop-сборка, Electron smoke, проверка архивов и SHA-256, read-back GitHub Release и HTTP range-проверка каждого файла.
- `constraints`: не обращаться к реальному provider при тестировании и не изменять пользовательскую SQLite/config; не заменять артефакты прошлых релизов.

## Cycle-only annotation browser regression

- `outcome`: главная страница показывает одну карточку на цикл: название папки цикла и аннотацию первого файла по natural sort, без названия и имени отдельной книги.
- `verification`: два цикла отображаются двумя карточками, три книги индексируются тремя записями; UI не выводит book title/file; RU/EN подписи описывают циклы.
- `constraints`: все `.fb2`/`.fb2.zip` внутри цикла остаются в полном SQLite/FTS/embedding индексе и доступны Ask-поиску.
- `boundaries`: `src/scan.js`, вызов индексатора, annotation UI, focused tests, package version, release artifacts.
- `stop_when`: выбор аннотации цикла требует новой продуктовой логики вместо исторического правила «первый файл по natural sort».

## Release v0.3.10

- `outcome`: опубликовать исправление cycle-only главной страницы с теми же четырьмя desktop-артефактами и прямой Windows-ссылкой.
- `verification`: полная desktop-сборка, проверка архивов и SHA-256, read-back GitHub Release и HTTP range-проверка каждого опубликованного файла.
- `constraints`: не менять AI/index contracts и пользовательские данные; не заменять уже опубликованные артефакты `v0.3.9`.

## Release v0.3.9

- `outcome`: опубликовать проверенный `main` как GitHub Release `v0.3.9` и дать прямую ссылку для скачивания Windows-версии.
- `verification`: повторный `npm test`, полная desktop-сборка, проверка архивов и SHA-256, затем read-back релиза и HTTP-проверка опубликованных файлов.
- `constraints`: без реальных AI-provider вызовов; без изменений пользовательских библиотек, конфигурации и SQLite; без заявлений о подписи или notarization.
- `boundaries`: `plan.md`, release commit/tag и сгенерированные `dist-desktop/` артефакты; код исправлений не меняется.
- `stop_when`: тесты или сборка не проходят, тег/релиз `v0.3.9` уже существует либо загрузка любого обязательного артефакта не подтверждается.

## Published release v0.3.6

- `outcome`: publish current verified `main` as GitHub Release `v0.3.6` with stable Linux, Windows portable EXE/ZIP, and macOS ZIP assets.
- `verification`: full tests, Electron smoke, `npm run build:desktop`, archive listing, SHA-256 checksums, GitHub asset read-back, and HTTP range checks for published downloads.
- `constraints`: no real provider calls, no user data/config/database changes, no signing/notarization claims, and no modification of release contents after verification except replacing a failed upload before publication.
- `boundaries`: package version/lockfile, `plan.md`, generated ignored `dist-desktop/`, Git tag, and GitHub Release only.
- `stop_when`: build cannot produce a required platform asset, tests fail, GitHub authentication fails, or publishing would overwrite an existing `v0.3.6` tag/release.

## Windows OpenRouter network fix

- `outcome`: Electron provider calls use Chromium networking; failures identify their stage and write a sanitized local log.
- `release`: publish the verified fix as `v0.3.7` with the same four stable cross-platform asset names.
- `verification`: TDD, full tests, Electron smoke, release build, artifact checks, and published-download checks.
- `constraints`: never log keys, authorization headers, prompts, excerpts, paths to books, or response bodies.
- `boundaries`: server fetch injection, Electron main process, diagnostics, tests, package version, and release artifacts.

### Scope and non-goals

- Защитить loopback API от cross-origin/DNS-rebinding запросов, не возвращать сохранённые ключи и валидировать provider configuration.
- Исправить удаление устаревших книг, фактов и embeddings; сохранить совместимость существующих SQLite баз.
- Проверять model-generated evidence и не сохранять неподтверждённые ссылки.
- Исправить нулевой бюджет, конкурентные Ask-запросы, `bookId`, chunk/ZIP limits, permissions и prompt-injection boundary.
- Исправить RU/EN UI, доступные статусы, folder picker, uncertainty, Electron navigation/lifecycle и release metadata.
- Обновить уязвимые build dependencies в пределах совместимых major versions, если lockfile позволяет устранить audit findings без смены архитектуры.
- Не реализовывать Hermes adapter в этой задаче, не публиковать release и не обращаться к реальным AI providers.

### Files and boundaries

- In scope: `src/`, `desktop/`, `public/index.html`, focused tests, package metadata/lockfile, `.gitignore`, `README.md`, `AGENTS.md`, `plan.md`.
- Out of scope: user libraries/config/databases, live API keys, GitHub release publication, Hermes transport implementation, production deployment.

### Functional slices

1. Loopback API and provider configuration security with API-level regression tests.
2. SQLite/index/fact/embedding consistency with migration-safe database tests.
3. FB2 chunking and bounded ZIP parsing tests/fixes.
4. AI evidence validation, budget correctness and request deduplication tests/fixes.
5. UI localization/accessibility/folder/uncertainty behavior.
6. Electron navigation/lifecycle hardening and release/dependency hygiene.
7. Full integration, browser/Electron smoke, security review and documentation alignment.

### Verification

- RED/GREEN focused tests for every behavior change.
- `npm test` and `git diff --check`.
- `npm audit --json` with remaining findings classified.
- Real loopback API smoke using temporary config/library/database only.
- Electron smoke under Xvfb with temporary config/database.
- Browser-visible flow and console check where practical without real provider calls.

### Completion contract

- `outcome`: all audit findings are fixed or explicitly proven non-actionable; existing annotation, indexing, Ask fallback and desktop startup remain working.
- `verification`: focused regression tests plus full suite, syntax, API and Electron/browser smoke evidence.
- `constraints`: no real provider calls, no user data/config mutation, no Hermes adapter, no release publication, no widening beyond audited defects.
- `boundaries`: only this repository and temporary test data may change; external accounts/services remain untouched.
- `stop_when`: a fix requires real credentials, live spending, release publication, incompatible dependency major upgrade, or a product decision that changes the Hermes adapter contract.

## Product Goal

Пользователь должен уметь не только читать аннотации, но и задавать смысловые вопросы по книгам и циклам, например:

- найти цикл с парой, которая любит друг друга, действует вместе и оба живы в финале;
- найти книги по атмосфере, типу героя, развитию персонажа, жанровым условиям;
- получить ответ с объяснением, уверенностью и доказательными фрагментами.

## Existing Delivered Baseline

- Локальный Node.js tool без внешних npm-зависимостей.
- Сканирование корневой папки с подпапками книг.
- Поиск первого `.fb2` или `.fb2.zip` в каждой подпапке.
- Извлечение `book-title` и `annotation` из FB2.
- Чтение `.fb2.zip` через встроенный ZIP parser на Node.js, без `python3`.
- Локальный HTTP server с `GET /api/books`.
- Простой доступный web UI с поиском, reload, выбором языка RU/EN и fallback на ручной ввод пути.
- Базовые тесты на FB2 parsing и scan behavior.

- SQLite schema, indexer and FTS endpoints delivered in commit `73ec214`.
- Current TDD increment delivered Ask MVP over local FTS evidence: evidence-only prompt construction, no-key fallback status, mockable OpenAI-compatible provider client scaffold, and `POST /api/ask`.
- Embeddings cache / semantic scaffold increment delivered: durable `chunk_embeddings` table, embedding model config defaults, mockable OpenAI-compatible `/embeddings` client, local cosine ranking over cached vectors, no-key semantic setup fallback, and `POST /api/semantic-search` status endpoint.
- Chunk embedding indexing increment delivered: `src/embeddingIndexer.js` selects chunks missing the current embeddings provider/model/content hash, returns `needs_embedding_provider_key` without network when the key is absent, writes mocked-provider vectors into `chunk_embeddings`, supports changed chunk re-embedding and bounded `limit`/`batchSize` runs, and exposes `POST /api/embed-index?db=...&limit=...&batchSize=...`.
- Generic fact graph helper increment delivered: `src/facts.js` storage helpers for book-scoped entities, chunk-linked evidence, evidence-linked relations/events, derived fact upsert/query by book/cycle/type, plus an evidence-only fact-extraction prompt scaffold.
- Generic model-backed fact extraction increment delivered: `src/factExtractor.js` builds generic prompts from supplied excerpts/snippets, returns `needs_provider_key` without network when no key is configured, uses injectable/mockable provider clients, upserts arbitrary `factKey`/`factType` results into `derived_facts`, and exposes a small `POST /api/extract-fact` setup/cache endpoint.
- Minimal accessible UI controls increment delivered: `public/index.html` now exposes separate browser-persisted SQLite DB path input, a single prepare-index button that builds/updates SQLite FTS and attempts semantic cache setup, a multi-line question field, a single Find answer action, provider/setup live status, and list-based results/evidence rendering without a frontend framework.
- Hybrid Ask retrieval increment delivered: `src/retrieval.js` combines local FTS snippets, optional cached semantic-vector hits, and cached derived facts with `fts`/`semantic`/`fact` source labels, dedupe/caps, graceful no-key semantic fallback, and evidence rows compatible with `answerLibraryQuestion`.
- OpenRouter budget guard delivered: provider calls check OpenRouter `/credits` before chat and embeddings requests, default to a `$1` process-session spend cap, support `BOOKS_SELECTION_OPENROUTER_MAX_SESSION_USAGE_USD` and optional baseline env override, and block the provider request when the cap is reached.
- Settings/config UI increment delivered: `src/appConfig.js` manages `~/.books-selection/config.json` (or `BOOKS_SELECTION_CONFIG_PATH`), supports direct local API keys, defaults SQLite to project-local `data/books-selection.sqlite`, `GET/POST /api/config` read/write normalized settings, first launch opens Settings when `booksRoot`/`dbPath` are missing, the main page hides path inputs and uses saved root/db by default, and the index/ask/embedding APIs use saved provider overrides. Local config and generated SQLite DB files are gitignored.
- Electron desktop increment delivered: `npm start` still starts `src/server.js` and opens the normal browser, while packaged desktop builds start the same backend inside Electron main process with no backend child process and load the UI in `BrowserWindow`. Desktop exposes a narrow preload API (`booksSelectionDesktop.pickDirectory()`) for native folder selection; browser mode keeps the existing fallback behavior. `electron-builder` creates Linux tar.gz, Windows portable exe + folder zip, and macOS zip assets with stable `releases/latest/download/...` names.

## Current Architecture

- `src/fb2.js`: parsing FB2/XML, decoding encoding, чтение `.fb2.zip`.
- `src/scan.js`: обход каталога, natural sort, формирование записей со `status`, `reason`, `hasAnnotation`.
- `src/server.js`: локальный HTTP server и раздача `public/index.html`.
- `public/index.html`: single-file UI без framework.
- `tests/fb2.test.js`: тесты парсинга FB2 и zip.
- `tests/scan.test.js`: тесты scanning logic и edge cases.

## New Scope: AI Library Search

### Stage 1 — SQLite library index foundation

Implement a durable local SQLite database for extracted library data.

Expected behavior:

- Store cycles/folders, books, file path, file size, mtime, content hash, title, annotation and indexing status.
- Extract full text from `.fb2` / `.fb2.zip` without sending it to any model.
- Split text into stable chunks, preferably chapter-aware when possible and fixed-size fallback when chapter detection is weak.
- Add SQLite FTS5 over chunks for cheap local text search.
- Re-index only changed files by hash/mtime.
- Keep the annotation UI working.

### Stage 2 — Semantic search / embeddings

Status: cache/schema/search scaffold and bounded chunk embedding cache population are implemented. Semantic search can rank cached vectors; `/api/embed-index` fills missing cache rows when an embeddings provider key is configured and returns setup status without network otherwise.

Add vector/semantic search over chunks.

Provider requirements:

- Default embeddings provider should be configurable.
- Prefer a local/default cheap path where possible.
- Do not require OpenRouter for plain annotation browsing or FTS search.
- Cache embeddings by chunk hash.

Implementation options:

- SQLite stores embeddings as JSON/BLOB initially.
- If native sqlite vector extension is unavailable, implement a small cosine-similarity search in Node over cached vectors as MVP.
- Later upgrade path can use sqlite-vec/sqlite-vss, but not as a hard MVP dependency unless it is proven portable.

### Stage 3 — Ask mode over retrieved evidence

Add `Ask library` / `Ask cycles` mode.

Expected pipeline:

1. Parse the user's question into retrieval hints where possible.
2. Use FTS5 + vector search + existing extracted metadata to collect candidate chunks.
3. Group candidates by book and cycle.
4. Send only relevant snippets/evidence to the answer model.
5. Return answer with:
   - matching cycles/books;
   - why they match;
   - confidence;
   - checked books/chunks;
   - evidence excerpts;
   - uncertainty / “needs more indexing” notes.

### Stage 4 — Fact graph inside SQLite

Add gradually enriched fact extraction, not fixed “love cards”.

Graph model should be generic:

- `entities`: characters, places, organizations, races/species, artifacts, concepts.
- `relations`: loves, allies_with, enemy_of, travels_with, saves, kills, related_to, teaches, betrays, etc.
- `events`: death, resurrection, marriage, separation, final_state, major battle, journey, transformation.
- `evidence`: links every extracted fact to book/chapter/chunk text.
- `derived_facts`: user-question-specific traits, e.g. `acts_together_through_main_plot`, cached with confidence and evidence.

Important: do not prebuild only romance-specific cards. Romance is one query type; the graph must support arbitrary future questions.

### Stage 5 — On-demand enrichment and cache

When the database lacks facts for a new question:

- retrieve relevant chunks;
- ask the configured model to extract the missing trait/fact type;
- save extracted facts and evidence to SQLite;
- use saved facts in future answers;
- allow re-analysis if model/provider/settings change.

### Stage 6 — Provider configuration

Add config-backed AI provider support.

Default:

- OpenRouter with a normal but cheap model, configured in app config, not hardcoded in random call sites.
- The concrete default model should be easy to change in a config file or UI field.
- API keys must come from environment variables or user-local config ignored by git; never commit secrets.

Also support:

- local model provider, e.g. Ollama / llama.cpp-compatible OpenAI API / LM Studio;
- Hermes Desktop / Hermes Agent integration mode if Denis later installs Hermes locally.

Provider abstraction should cover at least:

- answer/chat completion;
- optional structured fact extraction;
- embeddings, if provider supports it.

Hermes integration assumption:

- Do not depend on Hermes being installed for normal app startup.
- If Hermes is available, provide a provider mode that can call Hermes through a local CLI/API/MCP-compatible adapter, with config fields documented.
- Keep Hermes mode optional and failure-tolerant: show clear setup/check messages rather than breaking local search.

### Stage 7 — Accessible UI

Add accessible controls:

- build/update index;
- show indexing progress;
- choose provider mode: OpenRouter / Local model / Hermes;
- configure model names without exposing stored secrets;
- ask a question;
- show answer, confidence, evidence, and checked books;
- show whether result came from cached facts, retrieved chunks, or new model analysis.

Keep the UI screen-reader friendly: normal buttons, labels, status regions, no visual-only controls.

## Non-goals

- Do not send full library contents to OpenRouter on every question.
- Do not require a cloud account for annotation browsing or local FTS search.
- Do not build a separate heavy frontend framework unless the existing single-file UI becomes unmaintainable.
- Do not promise perfect literary truth. Model answers must carry confidence and evidence.
- Do not implement unattended cloud sync or multi-user backend in this project unless explicitly requested later.

## Completion Contract

### Outcome

Books Selection has a local, incremental semantic search foundation that can evolve into AI plot search without repeatedly paying to re-read the whole library.

### Verification

Required local checks:

- `npm test`
- API smoke for existing `/api/books`
- new tests for DB schema/indexing/chunking/provider config
- no committed secrets or local API keys

Future manual checks once UI is added:

- Start with `BOOKS_SELECTION_NO_OPEN=1 npm start -- /path/to/Books 3210`.
- Build index for a small sample library.
- Ask a question and verify answer contains evidence and uncertainty.
- Verify no model call is made for plain annotation scan / FTS-only search.

### Constraints

- Preserve existing `/api/books` contract fields unless plan explicitly updates consumers and tests.
- Keep config-backed provider selection.
- Default to OpenRouter cheap model for AI answering, but support local/Hermes modes.
- Secrets stay out of git.
- Local search/indexing must work without OpenRouter.

### Boundaries

In scope:

- `src/` local Node implementation;
- `public/index.html` accessible UI;
- SQLite database/index files under user-local ignored paths;
- README/AGENTS/plan docs if architecture changes.

Out of scope unless explicitly requested:

- deploying a hosted service;
- uploading user's book texts to a remote database;
- DRM handling;
- piracy/source acquisition features;
- changing Hermes global config.

### Stop When

Ask Denis before:

- adding a paid provider as the only working path;
- storing API keys anywhere other than env/user-local ignored config;
- adding a heavy native dependency that is hard to install on Windows/Linux;
- changing project from local tool to hosted backend.

## Implementation Milestones

1. **RED/GREEN: full text extraction and chunking**
   - tests for FB2 body extraction and stable chunk boundaries;
   - implementation in `src/fb2.js` or dedicated module.

2. **RED/GREEN: SQLite adapter and schema**
   - tests create temp DB;
   - migrations initialize tables for books/chunks/FTS/provider cache/facts;
   - no external secrets.

3. **RED/GREEN: indexing service**
   - scans existing folders;
   - extracts text;
   - writes books/chunks;
   - skips unchanged files.

4. **RED/GREEN: FTS query API**
   - `GET /api/search?q=...` or `POST /api/search`;
   - returns grouped book/cycle hits with snippets.

5. **RED/GREEN: provider config abstraction**
   - config loader with defaults;
   - OpenRouter default model fields;
   - local OpenAI-compatible endpoint fields;
   - Hermes optional mode fields;
   - tests verify config defaults and env-key lookup without printing secrets.

6. **RED/GREEN: answer pipeline MVP**
   - retrieve evidence locally;
   - if AI provider configured, answer from evidence only;
   - if not configured, return candidate evidence with setup guidance.

7. **RED/GREEN: generic graph tables and fact cache**
   - add schema and helpers;
   - store entities/relations/events/derived facts with evidence links;
   - do not overfit to romance.
   - Status: delivered as storage/prompt scaffold plus generic model-backed extraction/cache service; tests use mocked provider clients only and no real network calls.

8. **UI integration**
   - accessible controls for index/search/ask/provider status;
   - preserve existing annotation workflow.
   - Status: minimal accessible controls delivered for local FTS index/search, Ask setup/evidence, and optional semantic embedding setup; graph/fact UI remains intentionally out of scope.

9. **Documentation**
   - README explains indexing, privacy, OpenRouter/local/Hermes provider modes, and costs.
   - AGENTS.md updated with architecture and validation commands.

## Risks And Assumptions

- SQLite package choice matters: Node has no built-in SQLite in current project baseline. Prefer a portable dependency only after confirming install behavior; otherwise use a small CLI bridge to `sqlite3` only if available. This is an implementation decision to verify.
- Local models may be slower and less accurate for Russian fiction; UI should communicate uncertainty.
- Vector search without native extension can be acceptable for MVP-sized libraries but may become slow for huge chunk counts.
- Hermes Desktop integration details may depend on the installed Hermes version; keep adapter optional and documented.

## Validation

- `npm test`
- `git diff --check`
- manual API smoke for old `/api/books`
- new sample-library indexing/search smoke after implementation

## Notes

- UI больше не должен опираться на точные fallback-строки backend, а должен использовать machine-readable поля `status`, `reason`, `hasAnnotation`.
- Архитектура больше не остаётся полностью без БД: AI search требует локального durable index. БД должна быть локальной и переносимой.