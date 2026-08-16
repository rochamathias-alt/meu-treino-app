/* =======================================================================
   Meu Treino & Dieta — lógica principal (vanilla JS, sem dependências)
   Persistência: localStorage (o app roda 100% no navegador do usuário,
   sem servidor — por isso localStorage é apropriado aqui).
   ======================================================================= */

const STORAGE_KEY = "treinoapp_state_v1";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayISO = () => new Date().toISOString().slice(0, 10);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round1 = (n) => Math.round(n * 10) / 10;

/* ---------------- Estado padrão ---------------- */
function defaultState() {
  return {
    profile: {
      name: "",
      sex: "M", // M / F
      age: 25,
      weightKg: 70,
      heightCm: 175,
      activity: 1.55, // fator de atividade
      wakeTime: "07:00",
      mealIntervalHours: 3,
      sleepWindowHours: 16, // período acordado, para calcular quantas refeições cabem
    },
    phases: [
      {
        id: uid(),
        name: "Fase 1 — Foco Superior/Peito",
        focus: "peito",
        goal: "bulk", // bulk | cut | manter
        startDate: todayISO(),
        durationWeeks: 12,
        template: null, // preenchido ao criar
      },
    ],
    activePhaseId: null, // definido após criar fase 1
    customFoods: [],
    mealLogs: [], // {id, date, time, mealSlot, name, grams, kcal, p, c, g}
    workoutLogs: [], // {id, date, dayLabel, exercises:[{name, sets:[{reps,weight}]}]}
  };
}

/* ---------------- Persistência ---------------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initFirstRun();
    const state = JSON.parse(raw);
    if (!state.activePhaseId && state.phases && state.phases.length) {
      state.activePhaseId = state.phases[0].id;
    }
    return state;
  } catch (e) {
    console.error("Erro ao carregar estado, recriando.", e);
    return initFirstRun();
  }
}

function initFirstRun() {
  const state = defaultState();
  state.phases[0].template = generateSplit(state.phases[0].focus, state.phases[0].goal);
  state.activePhaseId = state.phases[0].id;
  saveState(state);
  return state;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// STATE é inicializado mais abaixo (após EXERCISE_LIB/generateSplit estarem definidos),
// pois initFirstRun() depende dessas constantes.
let STATE;
function persist() {
  saveState(STATE);
}

/* =======================================================================
   CÁLCULO DE CALORIAS E MACROS (Mifflin-St Jeor)
   ======================================================================= */
function calcBMR(p) {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  return p.sex === "M" ? base + 5 : base - 161;
}

function calcTDEE(p) {
  return calcBMR(p) * p.activity;
}

function goalAdjustment(goal) {
  if (goal === "bulk") return 350; // superávit moderado
  if (goal === "cut") return -400; // déficit moderado
  return 0;
}

function calcTargets(p, goal) {
  const tdee = calcTDEE(p);
  const kcal = Math.round(tdee + goalAdjustment(goal));
  const proteinG = Math.round(p.weightKg * (goal === "cut" ? 2.2 : 2.0));
  const fatG = Math.round((kcal * 0.25) / 9);
  const remainingKcal = kcal - proteinG * 4 - fatG * 9;
  const carbG = Math.max(0, Math.round(remainingKcal / 4));
  return { kcal, proteinG, fatG, carbG, tdee: Math.round(tdee) };
}

function currentPhase() {
  return STATE.phases.find((ph) => ph.id === STATE.activePhaseId) || STATE.phases[0];
}

/* =======================================================================
   HORÁRIOS DE REFEIÇÃO (a cada N horas a partir do horário que acorda)
   ======================================================================= */
function mealSlots() {
  const p = STATE.profile;
  const [h, m] = p.wakeTime.split(":").map(Number);
  const slots = [];
  let minutes = h * 60 + m;
  const endMinutes = minutes + p.sleepWindowHours * 60;
  let idx = 1;
  while (minutes <= endMinutes) {
    const hh = Math.floor((minutes / 60) % 24).toString().padStart(2, "0");
    const mm = (minutes % 60).toString().padStart(2, "0");
    slots.push({ label: `Refeição ${idx}`, time: `${hh}:${mm}` });
    minutes += p.mealIntervalHours * 60;
    idx += 1;
  }
  return slots;
}

function nextMealInfo() {
  const slots = mealSlots();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  for (const slot of slots) {
    const [h, m] = slot.time.split(":").map(Number);
    const slotMinutes = h * 60 + m;
    if (slotMinutes >= nowMinutes) {
      return { ...slot, diffMinutes: slotMinutes - nowMinutes };
    }
  }
  // depois do último horário do dia: próxima é a primeira de amanhã
  const first = slots[0];
  const [h, m] = first.time.split(":").map(Number);
  const diff = 24 * 60 - nowMinutes + h * 60 + m;
  return { ...first, diffMinutes: diff, tomorrow: true };
}

/* =======================================================================
   ALIMENTOS
   ======================================================================= */
function normalize(str) {
  return str
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function allFoods() {
  return [...FOOD_DB, ...STATE.customFoods];
}

function searchFoods(query) {
  const q = normalize(query || "");
  if (!q) return allFoods().slice(0, 12);
  return allFoods().filter((f) => normalize(f.name).includes(q)).slice(0, 20);
}

function computeFromGrams(food, grams) {
  const ratio = grams / 100;
  return {
    kcal: round1(food.kcal * ratio),
    p: round1(food.p * ratio),
    c: round1(food.c * ratio),
    g: round1(food.g * ratio),
  };
}

function logsForDate(date) {
  return STATE.mealLogs.filter((l) => l.date === date);
}

function dayTotals(date) {
  const logs = logsForDate(date);
  return logs.reduce(
    (acc, l) => ({
      kcal: acc.kcal + l.kcal,
      p: acc.p + l.p,
      c: acc.c + l.c,
      g: acc.g + l.g,
    }),
    { kcal: 0, p: 0, c: 0, g: 0 }
  );
}

/* =======================================================================
   TREINO — geração de split padrão por foco muscular
   ======================================================================= */
const EXERCISE_LIB = {
  peito: [
    { name: "Supino reto (barra ou halteres)", sets: 4, reps: "6-10" },
    { name: "Supino inclinado com halteres", sets: 3, reps: "8-12" },
    { name: "Crucifixo (halteres ou cross)", sets: 3, reps: "10-15" },
    { name: "Tríceps corda (polia)", sets: 3, reps: "10-15" },
    { name: "Tríceps francês", sets: 3, reps: "8-12" },
  ],
  costas: [
    { name: "Puxada frente (pulley)", sets: 4, reps: "8-12" },
    { name: "Remada curvada (barra)", sets: 3, reps: "6-10" },
    { name: "Remada unilateral (haltere)", sets: 3, reps: "8-12" },
    { name: "Rosca direta (barra)", sets: 3, reps: "8-12" },
    { name: "Rosca alternada (halteres)", sets: 3, reps: "10-15" },
  ],
  ombro: [
    { name: "Desenvolvimento com halteres", sets: 4, reps: "8-12" },
    { name: "Elevação lateral", sets: 3, reps: "12-15" },
    { name: "Elevação frontal", sets: 3, reps: "12-15" },
    { name: "Encolhimento (trapézio)", sets: 3, reps: "10-15" },
    { name: "Abdominal supra + prancha", sets: 3, reps: "15-20 / 40s" },
  ],
  pernas: [
    { name: "Agachamento livre ou smith", sets: 4, reps: "6-10" },
    { name: "Leg press", sets: 3, reps: "10-15" },
    { name: "Cadeira extensora", sets: 3, reps: "12-15" },
    { name: "Mesa flexora", sets: 3, reps: "10-15" },
    { name: "Panturrilha em pé", sets: 4, reps: "12-20" },
  ],
  fullbody: [
    { name: "Agachamento livre", sets: 3, reps: "8-12" },
    { name: "Supino reto", sets: 3, reps: "8-12" },
    { name: "Remada curvada", sets: 3, reps: "8-12" },
    { name: "Desenvolvimento com halteres", sets: 3, reps: "10-12" },
    { name: "Abdominal + prancha", sets: 3, reps: "15-20 / 40s" },
  ],
  cardio: [{ name: "Corrida (leve a moderada)", sets: 1, reps: "20-30 min" }],
};

const FOCUS_LABELS = {
  peito: "Peito / Superior",
  costas: "Costas / Superior",
  ombro: "Ombro / Braços",
  pernas: "Pernas / Inferior",
  fullbody: "Corpo inteiro",
};

// Gera um split segunda-a-sexta com ênfase no grupo escolhido, + full body no sábado + cardio.
function generateSplit(focus, goal) {
  const secondaryOrder = ["peito", "costas", "ombro", "pernas"].filter((f) => f !== focus);
  const week = {
    segunda: EXERCISE_LIB[focus],
    terca: EXERCISE_LIB[secondaryOrder[0]],
    quarta: EXERCISE_LIB[secondaryOrder[1]],
    quinta: EXERCISE_LIB[focus],
    sexta: EXERCISE_LIB[secondaryOrder[2]] || EXERCISE_LIB.fullbody,
    sabado: EXERCISE_LIB.fullbody,
    domingo: goal === "cut" ? EXERCISE_LIB.cardio : [],
  };
  if (goal === "cut") {
    // adiciona corrida extra durante a semana em fase de definição
    week.terca = [...week.terca, ...EXERCISE_LIB.cardio];
    week.quinta = [...week.quinta, ...EXERCISE_LIB.cardio];
  }
  return week;
}

const WEEKDAYS = [
  { key: "segunda", label: "Segunda" },
  { key: "terca", label: "Terça" },
  { key: "quarta", label: "Quarta" },
  { key: "quinta", label: "Quinta" },
  { key: "sexta", label: "Sexta" },
  { key: "sabado", label: "Sábado" },
  { key: "domingo", label: "Domingo" },
];

function todayWeekdayKey() {
  const idx = new Date().getDay(); // 0=domingo
  const map = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
  return map[idx];
}

function workoutLogsForDate(date) {
  return STATE.workoutLogs.filter((w) => w.date === date);
}

function totalVolumeForLog(log) {
  return log.exercises.reduce(
    (sum, ex) => sum + ex.sets.reduce((s, set) => s + (Number(set.reps) || 0) * (Number(set.weight) || 0), 0),
    0
  );
}

/* =======================================================================
   NOTIFICAÇÕES (melhor esforço — enquanto o app está aberto)
   iOS só entrega notificações em segundo plano via Web Push com servidor;
   aqui usamos a API local, que funciona com o app aberto/em primeiro plano.
   ======================================================================= */
let notifTimer = null;
function scheduleNextMealNotification() {
  if (notifTimer) clearTimeout(notifTimer);
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const info = nextMealInfo();
  const ms = clamp(info.diffMinutes * 60 * 1000, 1000, 6 * 60 * 60 * 1000);
  notifTimer = setTimeout(() => {
    try {
      new Notification("Hora de comer! 🍽️", {
        body: `${info.label} às ${info.time}. Registre sua refeição no app.`,
        icon: "icons/icon-192.png",
      });
    } catch (e) {
      console.warn("Notificação falhou", e);
    }
    scheduleNextMealNotification();
  }, ms);
}

function requestNotificationPermission() {
  if (!("Notification" in window)) return Promise.resolve("unsupported");
  return Notification.requestPermission().then((perm) => {
    if (perm === "granted") scheduleNextMealNotification();
    return perm;
  });
}

/* =======================================================================
   RENDERIZAÇÃO — navegação por abas
   ======================================================================= */
const APP_EL = document.getElementById("app");
let activeTab = "inicio";

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  render();
}

function render() {
  let html = "";
  if (activeTab === "inicio") html = renderInicio();
  else if (activeTab === "alimentacao") html = renderAlimentacao();
  else if (activeTab === "treino") html = renderTreino();
  else if (activeTab === "progresso") html = renderProgresso();
  else if (activeTab === "perfil") html = renderPerfil();
  APP_EL.innerHTML = html;
  attachHandlers();
}

/* ---------------- INÍCIO ---------------- */
function renderInicio() {
  const p = STATE.profile;
  const phase = currentPhase();
  const targets = calcTargets(p, phase.goal);
  const totals = dayTotals(todayISO());
  const pct = clamp(Math.round((totals.kcal / targets.kcal) * 100), 0, 999);
  const next = nextMealInfo();
  const hh = Math.floor(next.diffMinutes / 60);
  const mm = next.diffMinutes % 60;
  const wk = todayWeekdayKey();
  const todaysWorkout = (phase.template && phase.template[wk]) || [];

  return `
    <section class="card">
      <h2>Olá${p.name ? ", " + escapeHtml(p.name) : ""} 👋</h2>
      <p class="muted">${new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}</p>
    </section>

    <section class="card highlight">
      <h3>Próxima refeição</h3>
      <p class="big">${next.label} — ${next.time}${next.tomorrow ? " (amanhã)" : ""}</p>
      <p class="muted">em ${hh}h${mm.toString().padStart(2, "0")}min</p>
      <button class="btn" id="btn-enable-notif">🔔 Ativar lembretes</button>
    </section>

    <section class="card">
      <h3>Calorias hoje</h3>
      <div class="progress-bar"><div class="progress-fill" style="width:${clamp(pct, 0, 100)}%"></div></div>
      <p>${Math.round(totals.kcal)} / ${targets.kcal} kcal (${pct}%)</p>
      <div class="macro-row">
        <span>P: ${round1(totals.p)}g / ${targets.proteinG}g</span>
        <span>C: ${round1(totals.c)}g / ${targets.carbG}g</span>
        <span>G: ${round1(totals.g)}g / ${targets.fatG}g</span>
      </div>
    </section>

    <section class="card">
      <h3>Treino de hoje — ${WEEKDAYS.find((w) => w.key === wk).label}</h3>
      <p class="muted">${phase.name}</p>
      ${
        todaysWorkout.length
          ? `<ul class="ex-list">${todaysWorkout.map((e) => `<li>${escapeHtml(e.name)} — ${e.sets}x${e.reps}</li>`).join("")}</ul>`
          : `<p class="muted">Descanso hoje 🙌</p>`
      }
      <button class="btn" data-goto="treino">Ir para Treino</button>
    </section>
  `;
}

/* ---------------- ALIMENTAÇÃO ---------------- */
function renderAlimentacao() {
  const date = todayISO();
  const logs = logsForDate(date).sort((a, b) => a.time.localeCompare(b.time));
  const totals = dayTotals(date);
  const phase = currentPhase();
  const targets = calcTargets(STATE.profile, phase.goal);

  return `
    <section class="card">
      <h2>Diário alimentar</h2>
      <p class="muted">${new Date().toLocaleDateString("pt-BR")}</p>
      <div class="macro-row">
        <span><b>${Math.round(totals.kcal)}</b> / ${targets.kcal} kcal</span>
        <span>P ${round1(totals.p)}g</span>
        <span>C ${round1(totals.c)}g</span>
        <span>G ${round1(totals.g)}g</span>
      </div>
    </section>

    <section class="card">
      <h3>Adicionar alimento</h3>
      <input type="text" id="food-search" placeholder="Buscar alimento (ex: arroz, frango...)" autocomplete="off" />
      <div id="food-results" class="food-results"></div>
      <div id="food-add-form" class="hidden">
        <p id="food-selected-name" class="muted"></p>
        <input type="number" id="food-grams" placeholder="Gramas (ex: 100)" value="100" min="1" />
        <select id="food-meal-slot">
          ${mealSlots()
            .map((s) => `<option value="${s.label}">${s.label} (${s.time})</option>`)
            .join("")}
        </select>
        <button class="btn" id="btn-confirm-add-food">Adicionar</button>
      </div>
      <details class="custom-food-details">
        <summary>Cadastrar alimento personalizado</summary>
        <input type="text" id="cf-name" placeholder="Nome do alimento" />
        <div class="grid4">
          <input type="number" id="cf-kcal" placeholder="kcal/100g" />
          <input type="number" id="cf-p" placeholder="Proteína/100g" />
          <input type="number" id="cf-c" placeholder="Carbo/100g" />
          <input type="number" id="cf-g" placeholder="Gordura/100g" />
        </div>
        <button class="btn secondary" id="btn-add-custom-food">Salvar alimento</button>
      </details>
    </section>

    <section class="card">
      <h3>Refeições de hoje</h3>
      ${
        logs.length
          ? `<ul class="meal-list">${logs
              .map(
                (l) => `
            <li>
              <div>
                <b>${escapeHtml(l.mealSlot)}</b> · ${l.time}<br/>
                ${escapeHtml(l.name)} — ${l.grams}g
              </div>
              <div class="meal-kcal">
                ${Math.round(l.kcal)} kcal
                <button class="icon-btn" data-del-meal="${l.id}">✕</button>
              </div>
            </li>`
              )
              .join("")}</ul>`
          : `<p class="muted">Nenhuma refeição registrada ainda.</p>`
      }
    </section>
  `;
}

/* ---------------- TREINO ---------------- */
function renderTreino() {
  const phase = currentPhase();
  const wk = todayWeekdayKey();
  const todaysLogs = workoutLogsForDate(todayISO());

  return `
    <section class="card">
      <h2>Treino</h2>
      <label>Fase ativa</label>
      <select id="phase-select">
        ${STATE.phases
          .map((ph) => `<option value="${ph.id}" ${ph.id === STATE.activePhaseId ? "selected" : ""}>${escapeHtml(ph.name)}</option>`)
          .join("")}
      </select>
      <p class="muted">${FOCUS_LABELS[phase.focus] || phase.focus} · objetivo: ${goalLabel(phase.goal)} · ${phase.durationWeeks} semanas</p>
      <button class="btn secondary" id="btn-new-phase">+ Nova fase</button>
    </section>

    <section class="card">
      <h3>Semana de treino</h3>
      ${WEEKDAYS.map((w) => {
        const exs = (phase.template && phase.template[w.key]) || [];
        return `
        <details ${w.key === wk ? "open" : ""}>
          <summary>${w.label}${w.key === wk ? " (hoje)" : ""}</summary>
          ${
            exs.length
              ? `<ul class="ex-list">${exs.map((e) => `<li>${escapeHtml(e.name)} — ${e.sets}x${e.reps}</li>`).join("")}</ul>`
              : `<p class="muted">Descanso</p>`
          }
        </details>`;
      }).join("")}
    </section>

    <section class="card">
      <h3>Registrar treino de hoje</h3>
      <div id="log-exercise-list">
        ${((phase.template && phase.template[wk]) || [])
          .map(
            (e, i) => `
          <div class="log-exercise">
            <b>${escapeHtml(e.name)}</b> <span class="muted">(alvo ${e.sets}x${e.reps})</span>
            <div class="sets-row" data-ex-idx="${i}" data-ex-name="${escapeHtml(e.name)}">
              ${Array.from({ length: e.sets })
                .map(
                  (_, si) => `
                <div class="set-input">
                  <input type="number" placeholder="reps" data-set="${si}" data-field="reps" />
                  <input type="number" placeholder="kg" data-set="${si}" data-field="weight" />
                </div>`
                )
                .join("")}
            </div>
          </div>`
          )
          .join("") || `<p class="muted">Sem exercícios programados para hoje.</p>`}
      </div>
      <button class="btn" id="btn-save-workout">Salvar treino de hoje</button>
    </section>

    <section class="card">
      <h3>Treinos registrados hoje</h3>
      ${
        todaysLogs.length
          ? `<ul class="meal-list">${todaysLogs
              .map(
                (l) => `<li><div><b>${escapeHtml(l.dayLabel)}</b><br/>${l.exercises.length} exercícios · volume ${Math.round(totalVolumeForLog(l))} kg</div>
              <button class="icon-btn" data-del-workout="${l.id}">✕</button></li>`
              )
              .join("")}</ul>`
          : `<p class="muted">Nenhum treino salvo hoje ainda.</p>`
      }
    </section>
  `;
}

function goalLabel(goal) {
  return goal === "bulk" ? "Ganho de massa" : goal === "cut" ? "Definição" : "Manutenção";
}

/* ---------------- PROGRESSO ---------------- */
function renderProgresso() {
  return `
    <section class="card">
      <h2>Progresso</h2>
      <p class="muted">Últimos 7 dias</p>
      <canvas id="chart-calories" width="600" height="220"></canvas>
      <div id="calories-legend" class="legend"></div>
    </section>
    <section class="card">
      <h3>Volume de treino (kg totais)</h3>
      <canvas id="chart-volume" width="600" height="220"></canvas>
    </section>
  `;
}

function drawChartsIfNeeded() {
  const calCanvas = document.getElementById("chart-calories");
  const volCanvas = document.getElementById("chart-volume");
  if (calCanvas) drawCaloriesChart(calCanvas);
  if (volCanvas) drawVolumeChart(volCanvas);
}

// Paleta do skill dataviz: series-1 azul #2a78d6 (meta), series-2 laranja #eb6834 (real)
const COLOR_BLUE = "#2a78d6";
const COLOR_ORANGE = "#eb6834";
const COLOR_MUTED = "#898781";
const COLOR_GRID = "#e1e0d9";
const COLOR_TEXT = "#52514e";

function last7Dates() {
  const arr = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    arr.push(d.toISOString().slice(0, 10));
  }
  return arr;
}

function drawCaloriesChart(canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const dates = last7Dates();
  const phase = currentPhase();
  const targets = calcTargets(STATE.profile, phase.goal);
  const values = dates.map((d) => dayTotals(d).kcal);
  const maxVal = Math.max(targets.kcal * 1.2, ...values, 100);

  const padL = 40, padB = 24, padT = 10, padR = 10;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  // grid + eixo
  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // linha de meta (azul)
  const goalY = padT + chartH - (targets.kcal / maxVal) * chartH;
  ctx.strokeStyle = COLOR_BLUE;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padL, goalY);
  ctx.lineTo(w - padR, goalY);
  ctx.stroke();
  ctx.setLineDash([]);

  // barras (laranja) — consumo real
  const barW = (chartW / dates.length) * 0.5;
  dates.forEach((d, i) => {
    const x = padL + (chartW / dates.length) * i + (chartW / dates.length - barW) / 2;
    const val = values[i];
    const barH = (val / maxVal) * chartH;
    const y = padT + chartH - barH;
    ctx.fillStyle = COLOR_ORANGE;
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(x, y + barH);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + barH);
    ctx.closePath();
    ctx.fill();

    // label eixo x
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    const label = new Date(d + "T00:00:00").toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
    ctx.fillText(label, x + barW / 2, h - 6);
  });

  document.getElementById("calories-legend").innerHTML = `
    <span class="legend-item"><i style="background:${COLOR_ORANGE}"></i>Consumido</span>
    <span class="legend-item"><i style="background:${COLOR_BLUE}"></i>Meta (${targets.kcal} kcal)</span>
  `;
}

function drawVolumeChart(canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const dates = last7Dates();
  const values = dates.map((d) => workoutLogsForDate(d).reduce((s, l) => s + totalVolumeForLog(l), 0));
  const maxVal = Math.max(...values, 100);

  const padL = 40, padB = 24, padT = 10, padR = 10;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  const barW = (chartW / dates.length) * 0.5;
  dates.forEach((d, i) => {
    const x = padL + (chartW / dates.length) * i + (chartW / dates.length - barW) / 2;
    const val = values[i];
    const barH = (val / maxVal) * chartH;
    const y = padT + chartH - barH;
    ctx.fillStyle = COLOR_BLUE;
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(x, y + barH);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + barH);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = COLOR_TEXT;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    const label = new Date(d + "T00:00:00").toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
    ctx.fillText(label, x + barW / 2, h - 6);
  });
}

/* ---------------- PERFIL ---------------- */
function renderPerfil() {
  const p = STATE.profile;
  const phase = currentPhase();
  const targets = calcTargets(p, phase.goal);

  return `
    <section class="card">
      <h2>Perfil</h2>
      <label>Nome</label>
      <input type="text" id="pf-name" value="${escapeHtml(p.name)}" />

      <label>Sexo</label>
      <select id="pf-sex">
        <option value="M" ${p.sex === "M" ? "selected" : ""}>Masculino</option>
        <option value="F" ${p.sex === "F" ? "selected" : ""}>Feminino</option>
      </select>

      <label>Idade</label>
      <input type="number" id="pf-age" value="${p.age}" />

      <label>Peso (kg)</label>
      <input type="number" id="pf-weight" value="${p.weightKg}" step="0.1" />

      <label>Altura (cm)</label>
      <input type="number" id="pf-height" value="${p.heightCm}" />

      <label>Nível de atividade</label>
      <select id="pf-activity">
        <option value="1.2" ${p.activity == 1.2 ? "selected" : ""}>Sedentário</option>
        <option value="1.375" ${p.activity == 1.375 ? "selected" : ""}>Leve (1-3x/semana)</option>
        <option value="1.55" ${p.activity == 1.55 ? "selected" : ""}>Moderado (3-5x/semana)</option>
        <option value="1.725" ${p.activity == 1.725 ? "selected" : ""}>Alto (6-7x/semana)</option>
        <option value="1.9" ${p.activity == 1.9 ? "selected" : ""}>Muito alto (atleta)</option>
      </select>

      <label>Horário que acorda</label>
      <input type="time" id="pf-wake" value="${p.wakeTime}" />

      <label>Intervalo entre refeições (horas)</label>
      <input type="number" id="pf-interval" value="${p.mealIntervalHours}" min="1" max="6" />

      <label>Horas acordado por dia</label>
      <input type="number" id="pf-sleepwindow" value="${p.sleepWindowHours}" min="8" max="20" />

      <button class="btn" id="btn-save-profile">Salvar perfil</button>
    </section>

    <section class="card highlight">
      <h3>Suas metas calculadas (fase atual: ${goalLabel(phase.goal)})</h3>
      <p>TDEE (gasto estimado): <b>${targets.tdee} kcal</b></p>
      <p>Meta calórica: <b>${targets.kcal} kcal/dia</b></p>
      <div class="macro-row">
        <span>Proteína: ${targets.proteinG}g</span>
        <span>Carboidrato: ${targets.carbG}g</span>
        <span>Gordura: ${targets.fatG}g</span>
      </div>
      <p class="muted small">Cálculo por Mifflin-St Jeor + fator de atividade. Ajuste conforme seus resultados reais ao longo das semanas.</p>
    </section>

    <section class="card">
      <h3>Notificações de refeição</h3>
      <p class="muted small">No iPhone, lembretes funcionam com o app aberto (instalado na Tela de Início). Notificações em segundo plano exigiriam um servidor de push — pode ser adicionado depois se você quiser.</p>
      <button class="btn secondary" id="btn-enable-notif-2">🔔 Ativar lembretes</button>
    </section>

    <section class="card">
      <h3>Dados</h3>
      <button class="btn secondary" id="btn-export">Exportar backup (JSON)</button>
      <button class="btn danger" id="btn-reset">Apagar todos os dados</button>
    </section>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* =======================================================================
   HANDLERS
   ======================================================================= */
let selectedFood = null;

function attachHandlers() {
  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", () => setTab(el.dataset.goto));
  });

  const notifBtns = [document.getElementById("btn-enable-notif"), document.getElementById("btn-enable-notif-2")];
  notifBtns.forEach((btn) => {
    if (btn) btn.addEventListener("click", () => requestNotificationPermission());
  });

  if (activeTab === "alimentacao") attachAlimentacaoHandlers();
  if (activeTab === "treino") attachTreinoHandlers();
  if (activeTab === "perfil") attachPerfilHandlers();
  if (activeTab === "progresso") drawChartsIfNeeded();
}

function attachAlimentacaoHandlers() {
  const search = document.getElementById("food-search");
  const results = document.getElementById("food-results");
  const addForm = document.getElementById("food-add-form");
  const selectedName = document.getElementById("food-selected-name");

  search.addEventListener("input", () => {
    const matches = searchFoods(search.value);
    results.innerHTML = matches
      .map((f) => `<div class="food-result-item" data-food-name="${escapeHtml(f.name)}">${escapeHtml(f.name)} <span class="muted">(${f.kcal} kcal/100g)</span></div>`)
      .join("");
  });
  results.innerHTML = searchFoods("")
    .map((f) => `<div class="food-result-item" data-food-name="${escapeHtml(f.name)}">${escapeHtml(f.name)} <span class="muted">(${f.kcal} kcal/100g)</span></div>`)
    .join("");

  results.addEventListener("click", (e) => {
    const item = e.target.closest(".food-result-item");
    if (!item) return;
    const name = item.dataset.foodName;
    selectedFood = allFoods().find((f) => f.name === name);
    if (!selectedFood) return;
    selectedName.textContent = `Selecionado: ${selectedFood.name}`;
    addForm.classList.remove("hidden");
  });

  const confirmBtn = document.getElementById("btn-confirm-add-food");
  confirmBtn.addEventListener("click", () => {
    if (!selectedFood) return;
    const grams = Number(document.getElementById("food-grams").value) || 0;
    if (grams <= 0) return;
    const mealSlot = document.getElementById("food-meal-slot").value;
    const macros = computeFromGrams(selectedFood, grams);
    STATE.mealLogs.push({
      id: uid(),
      date: todayISO(),
      time: new Date().toTimeString().slice(0, 5),
      mealSlot,
      name: selectedFood.name,
      grams,
      ...macros,
    });
    persist();
    selectedFood = null;
    render();
  });

  const addCustomBtn = document.getElementById("btn-add-custom-food");
  addCustomBtn.addEventListener("click", () => {
    const name = document.getElementById("cf-name").value.trim();
    const kcal = Number(document.getElementById("cf-kcal").value);
    const p = Number(document.getElementById("cf-p").value) || 0;
    const c = Number(document.getElementById("cf-c").value) || 0;
    const g = Number(document.getElementById("cf-g").value) || 0;
    if (!name || !kcal) return;
    STATE.customFoods.push({ name, kcal, p, c, g });
    persist();
    render();
  });

  document.querySelectorAll("[data-del-meal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.mealLogs = STATE.mealLogs.filter((l) => l.id !== btn.dataset.delMeal);
      persist();
      render();
    });
  });
}

function attachTreinoHandlers() {
  const phaseSelect = document.getElementById("phase-select");
  phaseSelect.addEventListener("change", () => {
    STATE.activePhaseId = phaseSelect.value;
    persist();
    render();
  });

  document.getElementById("btn-new-phase").addEventListener("click", () => {
    const name = prompt("Nome da nova fase (ex: Fase 2 — Foco Pernas):");
    if (!name) return;
    const focus = (prompt("Foco muscular: peito, costas, ombro, pernas ou fullbody", "peito") || "peito").trim();
    const goal = (prompt("Objetivo: bulk (ganho de massa), cut (definição) ou manter", "bulk") || "bulk").trim();
    const durationWeeks = Number(prompt("Duração em semanas:", "12")) || 12;
    const validFocus = EXERCISE_LIB[focus] ? focus : "peito";
    const validGoal = ["bulk", "cut", "manter"].includes(goal) ? goal : "bulk";
    const newPhase = {
      id: uid(),
      name,
      focus: validFocus,
      goal: validGoal,
      startDate: todayISO(),
      durationWeeks,
      template: generateSplit(validFocus, validGoal),
    };
    STATE.phases.push(newPhase);
    STATE.activePhaseId = newPhase.id;
    persist();
    render();
  });

  document.getElementById("btn-save-workout").addEventListener("click", () => {
    const phase = currentPhase();
    const wk = todayWeekdayKey();
    const template = (phase.template && phase.template[wk]) || [];
    const exercises = [];
    document.querySelectorAll(".sets-row").forEach((row) => {
      const idx = Number(row.dataset.exIdx);
      const name = row.dataset.exName;
      const sets = [];
      const setInputs = row.querySelectorAll(".set-input");
      setInputs.forEach((si) => {
        const reps = si.querySelector('[data-field="reps"]').value;
        const weight = si.querySelector('[data-field="weight"]').value;
        if (reps || weight) sets.push({ reps: Number(reps) || 0, weight: Number(weight) || 0 });
      });
      if (sets.length) exercises.push({ name, sets });
    });
    if (!exercises.length) {
      alert("Preencha ao menos uma série antes de salvar.");
      return;
    }
    STATE.workoutLogs.push({
      id: uid(),
      date: todayISO(),
      dayLabel: WEEKDAYS.find((w) => w.key === wk).label,
      exercises,
    });
    persist();
    render();
  });

  document.querySelectorAll("[data-del-workout]").forEach((btn) => {
    btn.addEventListener("click", () => {
      STATE.workoutLogs = STATE.workoutLogs.filter((l) => l.id !== btn.dataset.delWorkout);
      persist();
      render();
    });
  });
}

function attachPerfilHandlers() {
  document.getElementById("btn-save-profile").addEventListener("click", () => {
    STATE.profile = {
      ...STATE.profile,
      name: document.getElementById("pf-name").value.trim(),
      sex: document.getElementById("pf-sex").value,
      age: Number(document.getElementById("pf-age").value) || STATE.profile.age,
      weightKg: Number(document.getElementById("pf-weight").value) || STATE.profile.weightKg,
      heightCm: Number(document.getElementById("pf-height").value) || STATE.profile.heightCm,
      activity: Number(document.getElementById("pf-activity").value),
      wakeTime: document.getElementById("pf-wake").value || STATE.profile.wakeTime,
      mealIntervalHours: Number(document.getElementById("pf-interval").value) || STATE.profile.mealIntervalHours,
      sleepWindowHours: Number(document.getElementById("pf-sleepwindow").value) || STATE.profile.sleepWindowHours,
    };
    persist();
    scheduleNextMealNotification();
    render();
    alert("Perfil salvo!");
  });

  document.getElementById("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `treino-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("btn-reset").addEventListener("click", () => {
    if (!confirm("Tem certeza? Isso vai apagar todos os dados salvos no app.")) return;
    localStorage.removeItem(STORAGE_KEY);
    STATE = initFirstRun();
    render();
  });
}

/* =======================================================================
   INICIALIZAÇÃO
   ======================================================================= */
STATE = loadState();

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW falhou", e));
  });
}

if ("Notification" in window && Notification.permission === "granted") {
  scheduleNextMealNotification();
}

render();
