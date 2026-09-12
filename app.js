'use strict';

/* ==========================================================================
   Constants
   ========================================================================== */
const STORAGE_KEY = 'kermoTrainerV1';
const TEST_LEN = 10;
const PASS_THRESHOLD = 7;
const MASTER_STREAK = 3;                 // correct answers in a row -> question leaves the review pool
const REVIEW_INTERVAL_DAYS = [1, 3, 7];  // spacing after 1st / 2nd / 3rd correct repeat
const HISTORY_LIMIT = 30;
const LETTERS = ['А', 'Б', 'В', 'Г', 'Д'];

const TOPIC_ORDER = [
  'Лоція',
  'Дії у випадках аварійних подій',
  'Техніка безпеки',
  'Рятувальне обладнання',
  'Навігація',
  'Погодні умови',
  'Маневрування',
  'Управління',
  'Правила плавання',
  'Будова судна',
  'Вітрильне судно',
  'Водний мотоцикл'
];

/* ==========================================================================
   State
   ========================================================================== */
let QUESTIONS = [];
let BY_ID = new Map();
let BY_TOPIC = new Map();   // topic -> [ids] in natural (document) order
let TOPICS_PRESENT = [];

let store = null;
let session = null;         // active quiz session, see beginSession()
let currentShuffle = null;  // { order:[srcIdx...], texts:[...], correctIndex }
let answered = false;

/* ==========================================================================
   Storage
   ========================================================================== */
function defaultStore() {
  return {
    version: 1,
    perQuestion: {},                       // id -> record
    history: [],                           // recent sessions
    resume: { all: null, byTopic: {} }     // resumable sequential runs
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return defaultStore();
    parsed.perQuestion = parsed.perQuestion || {};
    parsed.history = parsed.history || [];
    parsed.resume = parsed.resume || { all: null, byTopic: {} };
    parsed.resume.byTopic = parsed.resume.byTopic || {};
    return parsed;
  } catch (e) {
    console.warn('Kermo: could not read saved progress, starting fresh.', e);
    return defaultStore();
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn('Kermo: could not save progress (storage unavailable or full).', e);
  }
}

function getRecord(id) {
  if (!store.perQuestion[id]) {
    store.perQuestion[id] = { seen: 0, correct: 0, wrong: 0, streak: 0, wrongEver: false, needsReview: false, dueAt: 0 };
  }
  return store.perQuestion[id];
}

function recordAnswer(id, isCorrect) {
  const rec = getRecord(id);
  const now = Date.now();
  rec.seen++;
  if (isCorrect) {
    rec.correct++;
    rec.streak++;
    if (rec.wrongEver) {
      if (rec.streak >= MASTER_STREAK) {
        rec.needsReview = false;
      } else {
        const days = REVIEW_INTERVAL_DAYS[rec.streak - 1] || REVIEW_INTERVAL_DAYS[REVIEW_INTERVAL_DAYS.length - 1];
        rec.dueAt = now + days * 24 * 60 * 60 * 1000;
        rec.needsReview = true;
      }
    }
  } else {
    rec.wrong++;
    rec.streak = 0;
    rec.wrongEver = true;
    rec.needsReview = true;
    rec.dueAt = now;
  }
  saveStore();
}

function getDueReviewIds() {
  const now = Date.now();
  return Object.keys(store.perQuestion)
    .filter(id => store.perQuestion[id].needsReview && store.perQuestion[id].dueAt <= now)
    .map(Number)
    .sort((a, b) => store.perQuestion[a].dueAt - store.perQuestion[b].dueAt);
}

function getPendingReviewIds() {
  return Object.keys(store.perQuestion)
    .filter(id => store.perQuestion[id].needsReview)
    .map(Number);
}

/* ==========================================================================
   Bootstrap
   ========================================================================== */
init();

function init() {
  store = loadStore();
  try {
    if (!window.KERMO_DATA || !Array.isArray(window.KERMO_DATA.questions)) {
      throw new Error('window.KERMO_DATA is missing or malformed');
    }
    QUESTIONS = window.KERMO_DATA.questions.slice().sort((a, b) => a.id - b.id);
  } catch (e) {
    document.getElementById('screen-home').innerHTML =
      '<div class="panel"><h2>Не вдалось завантажити питання</h2>' +
      '<p class="muted">Файл questions.js має лежати поруч із index.html і підключатись до нього ' +
      '(&lt;script src="questions.js"&gt;) раніше за app.js.</p></div>';
    console.error(e);
    return;
  }

  QUESTIONS.forEach(q => {
    BY_ID.set(q.id, q);
    if (!BY_TOPIC.has(q.topic)) BY_TOPIC.set(q.topic, []);
    BY_TOPIC.get(q.topic).push(q.id);
  });
  TOPICS_PRESENT = TOPIC_ORDER.filter(t => BY_TOPIC.has(t));
  // in case new topics ever appear that aren't in TOPIC_ORDER
  BY_TOPIC.forEach((_, t) => { if (!TOPICS_PRESENT.includes(t)) TOPICS_PRESENT.push(t); });

  wireStaticEvents();
  renderHome();
}

/* ==========================================================================
   Screen switching
   ========================================================================== */
function switchScreen(name) {
  ['home', 'quiz', 'summary'].forEach(s => {
    document.getElementById('screen-' + s).hidden = (s !== name);
  });
  document.getElementById('navHome').hidden = (name === 'home');
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ==========================================================================
   Home screen
   ========================================================================== */
function wireStaticEvents() {
  document.getElementById('navHome').addEventListener('click', () => { renderHome(); switchScreen('home'); });

  document.getElementById('startAll').addEventListener('click', startAllSequential);
  document.getElementById('jumpToNumber').addEventListener('click', () => {
    jumpToQuestionNumber(document.getElementById('jumpNumber').value);
  });
  document.getElementById('jumpNumber').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') jumpToQuestionNumber(document.getElementById('jumpNumber').value);
  });
  document.getElementById('startTopic').addEventListener('click', () => {
    const sel = document.getElementById('topicSequential');
    if (sel.value) startTopicSequential(sel.value);
  });
  document.getElementById('startTest10').addEventListener('click', () => {
    const chosen = Array.from(document.querySelectorAll('#topicChecklist input[data-topic]:checked')).map(el => el.dataset.topic);
    if (chosen.length) startTest10(chosen);
  });
  document.getElementById('startReview').addEventListener('click', startReview);
  document.getElementById('resetData').addEventListener('click', () => {
    if (confirm('Весь прогрес, статистика та історія тестів будуть видалені з цього браузера. Продовжити?')) {
      store = defaultStore();
      saveStore();
      renderHome();
    }
  });

  document.getElementById('quitQuiz').addEventListener('click', onQuitQuiz);
  document.getElementById('nextBtn').addEventListener('click', onNext);

  document.getElementById('summaryHome').addEventListener('click', () => { renderHome(); switchScreen('home'); });
  document.getElementById('summaryRetryWrong').addEventListener('click', () => {
    const wrongIds = session.answers.filter(a => !a.isCorrect).map(a => a.id);
    beginSession({ mode: 'retry', topics: session.topics, order: shuffle(wrongIds), resumeKey: null });
  });
}

function renderHome() {
  renderResumeBanner();
  renderTopicSelect();
  renderTopicChecklist();
  renderReviewPanel();
  renderStats();
}

function renderResumeBanner() {
  const banner = document.getElementById('resumeBanner');
  const list = document.getElementById('resumeList');
  list.innerHTML = '';
  const items = [];

  if (store.resume.all && store.resume.all.index < store.resume.all.order.length) {
    items.push({ label: `Усі питання — ${store.resume.all.index} / ${store.resume.all.order.length}`, action: startAllSequential });
  }
  Object.keys(store.resume.byTopic).forEach(topic => {
    const r = store.resume.byTopic[topic];
    if (r && r.index < r.order.length) {
      items.push({ label: `${topic} — ${r.index} / ${r.order.length}`, action: () => startTopicSequential(topic) });
    }
  });

  if (!items.length) { banner.hidden = true; return; }
  banner.hidden = false;
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'resume-item';
    const span = document.createElement('span');
    span.textContent = item.label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Продовжити';
    btn.addEventListener('click', item.action);
    row.appendChild(span);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function renderTopicSelect() {
  const sel = document.getElementById('topicSequential');
  sel.innerHTML = '';
  TOPICS_PRESENT.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = `${t} (${BY_TOPIC.get(t).length})`;
    sel.appendChild(opt);
  });
}

function renderTopicChecklist() {
  const wrap = document.getElementById('topicChecklist');
  wrap.innerHTML = '';

  const allRow = document.createElement('label');
  allRow.className = 'topic-check all-row';
  allRow.innerHTML = `<input type="checkbox" id="topicAll"><span>Усі теми</span><span class="count">${QUESTIONS.length}</span>`;
  wrap.appendChild(allRow);

  const boxes = [];
  TOPICS_PRESENT.forEach(t => {
    const row = document.createElement('label');
    row.className = 'topic-check';
    row.innerHTML = `<input type="checkbox" data-topic="${escapeHtml(t)}"><span>${escapeHtml(t)}</span><span class="count">${BY_TOPIC.get(t).length}</span>`;
    wrap.appendChild(row);
    boxes.push(row.querySelector('input'));
  });

  const allBox = document.getElementById('topicAll');
  allBox.addEventListener('change', () => {
    boxes.forEach(b => { b.checked = allBox.checked; });
    updateStartTest10State();
  });
  boxes.forEach(b => b.addEventListener('change', () => {
    if (!b.checked) allBox.checked = false;
    else if (boxes.every(x => x.checked)) allBox.checked = true;
    updateStartTest10State();
  }));
  updateStartTest10State();
}

function updateStartTest10State() {
  const any = document.querySelectorAll('#topicChecklist input[data-topic]:checked').length > 0;
  document.getElementById('startTest10').disabled = !any;
}

function renderReviewPanel() {
  const due = getDueReviewIds();
  const pending = getPendingReviewIds();
  const text = document.getElementById('reviewText');
  const btn = document.getElementById('startReview');

  if (due.length > 0) {
    text.textContent = `Готово до повторення: ${due.length} питань${pending.length > due.length ? ` (ще ${pending.length - due.length} заплановано на пізніше)` : ''}.`;
    btn.disabled = false;
  } else if (pending.length > 0) {
    text.textContent = `Немає питань, готових саме зараз — ${pending.length} заплановано на найближчі дні. Можна повторити достроково.`;
    btn.disabled = false;
  } else {
    text.textContent = 'Питань для повторення немає. Вони з’являться тут після неправильних відповідей.';
    btn.disabled = true;
  }
}

function renderStats() {
  let seenQ = 0, sumCorrect = 0, sumWrong = 0;
  Object.values(store.perQuestion).forEach(r => {
    if (r.seen > 0) seenQ++;
    sumCorrect += r.correct;
    sumWrong += r.wrong;
  });
  const totalAnswers = sumCorrect + sumWrong;
  const acc = totalAnswers ? Math.round((sumCorrect / totalAnswers) * 100) : 0;

  document.getElementById('statsOverall').innerHTML = `
    <div class="stat"><span class="num">${seenQ} / ${QUESTIONS.length}</span><span class="label">унікальних питань пройдено</span></div>
    <div class="stat"><span class="num">${acc}%</span><span class="label">точність відповідей загалом</span></div>
  `;

  const topicsWrap = document.getElementById('statsTopics');
  if (!seenQ) {
    topicsWrap.innerHTML = '<p class="empty-note">Статистика по темах з’явиться після першої спроби.</p>';
  } else {
    topicsWrap.innerHTML = '';
    TOPICS_PRESENT.forEach(t => {
      const ids = BY_TOPIC.get(t);
      let c = 0, w = 0, s = 0;
      ids.forEach(id => {
        const r = store.perQuestion[id];
        if (r && r.seen) { s++; c += r.correct; w += r.wrong; }
      });
      if (!s) return;
      const pct = (c + w) ? Math.round((c / (c + w)) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'topic-stat-row';
      row.innerHTML = `
        <span class="name">${escapeHtml(t)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="pct">${pct}%</span>
      `;
      topicsWrap.appendChild(row);
    });
  }

  const histWrap = document.getElementById('statsHistory');
  if (!store.history.length) {
    histWrap.innerHTML = '<p class="empty-note">Тестів ще не було.</p>';
  } else {
    histWrap.innerHTML = '';
    store.history.slice(0, 8).forEach(h => {
      const row = document.createElement('div');
      row.className = 'history-row';
      const date = new Date(h.date);
      const dateStr = date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
      let pill;
      if (h.mode === 'test10') {
        pill = `<span class="pill ${h.passed ? 'pass' : 'fail'}">${h.passed ? 'ЗАРАХОВАНО' : 'НЕ ЗАРАХОВАНО'}</span>`;
      } else {
        pill = `<span class="pill done">пройдено</span>`;
      }
      row.innerHTML = `
        <span class="date">${dateStr}</span>
        <span class="topics">${escapeHtml(h.topics.join(', '))}</span>
        <span class="score">${h.correct}/${h.total}</span>
        ${pill}
      `;
      histWrap.appendChild(row);
    });
  }
}

/* ==========================================================================
   Session builders
   ========================================================================== */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startAllSequential() {
  let r = store.resume.all;
  if (!r || !r.order || r.index >= r.order.length) {
    r = { order: QUESTIONS.map(q => q.id), index: 0 };
    store.resume.all = r;
    saveStore();
  }
  beginSession({ mode: 'all', topics: ['Усі теми'], order: r.order, startIndex: r.index, resumeKey: 'all' });
}

function jumpToQuestionNumber(rawValue) {
  const errEl = document.getElementById('jumpError');
  const n = parseInt(rawValue, 10);
  const q = QUESTIONS.find(x => x.number === n);
  if (!rawValue || Number.isNaN(n) || !q) {
    errEl.textContent = 'Немає питання з таким номером.';
    errEl.hidden = false;
    return;
  }
  errEl.hidden = true;
  const order = QUESTIONS.map(x => x.id);
  const startIndex = order.indexOf(q.id);
  beginSession({ mode: 'all', topics: ['Усі теми'], order, startIndex, resumeKey: null });
}

function startTopicSequential(topic) {
  let r = store.resume.byTopic[topic];
  if (!r || !r.order || r.index >= r.order.length) {
    r = { order: BY_TOPIC.get(topic).slice(), index: 0 };
    store.resume.byTopic[topic] = r;
    saveStore();
  }
  beginSession({ mode: 'topic', topics: [topic], order: r.order, startIndex: r.index, resumeKey: topic });
}

function startTest10(topics) {
  let pool = [];
  topics.forEach(t => { if (BY_TOPIC.has(t)) pool.push(...BY_TOPIC.get(t)); });
  pool = Array.from(new Set(pool));
  const order = shuffle(pool).slice(0, Math.min(TEST_LEN, pool.length));
  beginSession({ mode: 'test10', topics, order, startIndex: 0, resumeKey: null });
}

function startReview() {
  let ids = getDueReviewIds();
  if (!ids.length) ids = getPendingReviewIds();
  ids = shuffle(ids);
  beginSession({ mode: 'review', topics: ['Повторення помилок'], order: ids, startIndex: 0, resumeKey: null });
}

function beginSession(cfg) {
  session = {
    mode: cfg.mode,
    topics: cfg.topics,
    order: cfg.order,
    index: cfg.startIndex || 0,
    resumeKey: cfg.resumeKey || null,
    correctCount: 0,
    answers: []
  };
  switchScreen('quiz');
  renderQuestion();
}

/* ==========================================================================
   Quiz screen
   ========================================================================== */
function shuffleOptions(q) {
  const order = shuffle([0, 1, 2].slice(0, q.options.length));
  const correctSrcIdx = q.options.indexOf(q.correct_answer);
  return {
    order,
    texts: order.map(i => q.options[i]),
    correctIndex: order.indexOf(correctSrcIdx)
  };
}

function renderQuestion() {
  const id = session.order[session.index];
  const q = BY_ID.get(id);
  currentShuffle = shuffleOptions(q);
  answered = false;

  document.getElementById('quizTopicBadge').textContent = q.topic;
  document.getElementById('quizProgress').textContent = `${session.index + 1} / ${session.order.length}`;
  document.getElementById('progressFill').style.width = `${(session.index / session.order.length) * 100}%`;

  document.getElementById('qNumber').textContent = `Питання № ${q.number}`;
  document.getElementById('qText').textContent = q.question;

  const imgWrap = document.getElementById('qImageWrap');
  const img = document.getElementById('qImage');
  if (q.images && q.images.length) {
    imgWrap.hidden = false;
    img.src = q.images[0];
  } else {
    imgWrap.hidden = true;
    img.removeAttribute('src');
  }

  document.getElementById('qUnverified').hidden = (q.answer_status !== 'неперевірено');

  const list = document.getElementById('optionsList');
  list.innerHTML = '';
  currentShuffle.texts.forEach((text, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'option';
    btn.innerHTML = `<span class="option-letter">${LETTERS[idx] || (idx + 1)}</span><span class="option-text"></span>`;
    btn.querySelector('.option-text').textContent = text;
    btn.addEventListener('click', () => selectOption(idx));
    list.appendChild(btn);
  });

  document.getElementById('nextBtn').disabled = true;
  document.getElementById('nextBtn').textContent =
    (session.index === session.order.length - 1) ? 'Завершити' : 'Далі';
}

function selectOption(idx) {
  if (answered) return;
  answered = true;

  const id = session.order[session.index];
  const q = BY_ID.get(id);
  const isCorrect = idx === currentShuffle.correctIndex;

  const buttons = document.querySelectorAll('#optionsList .option');
  buttons.forEach((b, i) => {
    b.disabled = true;
    if (i === currentShuffle.correctIndex) b.classList.add('is-correct');
    if (i === idx && !isCorrect) b.classList.add('is-wrong');
  });

  session.answers.push({
    id,
    topic: q.topic,
    number: q.number,
    question: q.question,
    chosen: currentShuffle.texts[idx],
    correct: q.correct_answer,
    isCorrect
  });
  if (isCorrect) session.correctCount++;

  recordAnswer(id, isCorrect);

  // persist resume pointer immediately so leaving mid-session never loses this answer
  if (session.resumeKey === 'all') {
    store.resume.all.index = session.index + 1;
    saveStore();
  } else if (session.resumeKey) {
    store.resume.byTopic[session.resumeKey].index = session.index + 1;
    saveStore();
  }

  document.getElementById('nextBtn').disabled = false;
  document.getElementById('nextBtn').focus();
}

function onNext() {
  session.index++;
  if (session.index >= session.order.length) {
    finishSession();
  } else {
    renderQuestion();
  }
}

function onQuitQuiz() {
  const resumable = session.mode === 'all' || session.mode === 'topic';
  if (!resumable && answered === false && session.answers.length === 0) {
    renderHome(); switchScreen('home'); return;
  }
  if (!resumable) {
    if (!confirm('Цей тест не зберігається — прогрес по ньому буде втрачено. Вийти?')) return;
  }
  renderHome();
  switchScreen('home');
}

/* ==========================================================================
   Summary screen
   ========================================================================== */
function finishSession() {
  const total = session.order.length;
  const correct = session.correctCount;

  if (session.mode === 'test10') {
    pushHistory({ mode: 'test10', topics: session.topics, total, correct, passed: correct >= PASS_THRESHOLD });
  } else if (session.mode === 'all' || session.mode === 'topic') {
    pushHistory({ mode: session.mode, topics: session.topics, total, correct, passed: total ? (correct / total) >= 0.7 : false });
  } else if (session.mode === 'review' || session.mode === 'retry') {
    pushHistory({ mode: session.mode, topics: session.topics, total, correct, passed: total ? (correct / total) >= 0.7 : false });
  }

  renderSummary();
  switchScreen('summary');
}

function pushHistory(entry) {
  entry.date = new Date().toISOString();
  store.history.unshift(entry);
  store.history = store.history.slice(0, HISTORY_LIMIT);
  saveStore();
}

function renderSummary() {
  const total = session.order.length;
  const correct = session.correctCount;
  const banner = document.getElementById('summaryBanner');
  const scoreEl = document.getElementById('summaryScoreBig');
  const statusEl = document.getElementById('summaryStatus');

  scoreEl.textContent = `${correct} / ${total}`;
  banner.classList.remove('pass', 'fail');

  if (session.mode === 'test10') {
    const passed = correct >= PASS_THRESHOLD;
    banner.classList.add(passed ? 'pass' : 'fail');
    statusEl.textContent = passed
      ? `Зараховано — потрібно було щонайменше ${PASS_THRESHOLD} з ${TEST_LEN}.`
      : `Не зараховано — потрібно щонайменше ${PASS_THRESHOLD} з ${TEST_LEN}. Спробуйте ще раз.`;
  } else if (session.mode === 'all' || session.mode === 'topic') {
    statusEl.textContent = `Пройдено: ${session.topics.join(', ')}. Правильних відповідей: ${total ? Math.round((correct / total) * 100) : 0}%.`;
  } else if (session.mode === 'review') {
    statusEl.textContent = `Повторення помилок. Правильно розв’язано ${correct} з ${total} — вони більше не з’являться найближчим часом.`;
  } else if (session.mode === 'retry') {
    statusEl.textContent = `Повторний прохід питань, у яких була помилка цього разу.`;
  }

  const listEl = document.getElementById('summaryList');
  listEl.innerHTML = '';
  const wrongOnes = session.answers.filter(a => !a.isCorrect);
  const showAll = session.answers.length <= 20;
  const note = document.createElement('p');
  note.className = 'summary-note';

  if (showAll) {
    note.textContent = wrongOnes.length ? 'Розбір відповідей:' : 'Усі відповіді правильні — розбирати нічого 🎉';
    listEl.appendChild(note);
    session.answers.forEach(a => listEl.appendChild(renderSummaryItem(a)));
  } else {
    note.textContent = wrongOnes.length
      ? `Питання з помилками (${wrongOnes.length} з ${session.answers.length}):`
      : 'Усі відповіді правильні — розбирати нічого 🎉';
    listEl.appendChild(note);
    wrongOnes.forEach(a => listEl.appendChild(renderSummaryItem(a)));
  }

  document.getElementById('summaryRetryWrong').hidden = wrongOnes.length === 0;
}

function renderSummaryItem(a) {
  const div = document.createElement('div');
  div.className = 'summary-item ' + (a.isCorrect ? 'correct' : 'wrong');
  div.innerHTML = `
    <div class="si-head">
      <span class="si-icon">${a.isCorrect ? '✓' : '✗'}</span>
      <span class="si-topic">${escapeHtml(a.topic)} · № ${a.number}</span>
    </div>
    <p class="si-q">${escapeHtml(a.question)}</p>
    ${a.isCorrect
      ? `<p class="si-line correct-line">Ваша відповідь: <b>${escapeHtml(a.chosen)}</b></p>`
      : `<p class="si-line chosen">Ваша відповідь: <b>${escapeHtml(a.chosen)}</b></p>
         <p class="si-line correct-line">Правильно: <b>${escapeHtml(a.correct)}</b></p>`
    }
  `;
  return div;
}

/* ==========================================================================
   Utils
   ========================================================================== */
function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
