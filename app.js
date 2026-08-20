/* =======================================================================
   Meu Treino — lógica principal (vanilla JS, sem dependências)
   Persistência: localStorage (o app roda 100% no navegador do usuário,
   sem servidor — por isso localStorage é apropriado aqui).
   ======================================================================= */

const STORAGE_KEY = "treinoapp_state_v1";

/* ---------------- Conta / login ----------------
   Backend mínimo (Cloudflare Worker + D1, pasta auth-worker/) que guarda
   usuários e sincroniza o STATE inteiro (perfil, fases, treinos) por
   usuário. O app continua salvando tudo no localStorage primeiro (rápido,
   funciona offline) e sincroniza com o servidor em segundo plano sempre que
   algo muda ou quando a conexão volta. */
const AUTH_API_BASE = "https://meu-treino-auth.rochamathias.workers.dev";
const AUTH_TOKEN_KEY = "treinoapp_auth_token_v1";
const AUTH_EMAIL_KEY = "treinoapp_auth_email_v1";
const SYNC_KEY = "treinoapp_last_synced_at_v1";

let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || null;
let authEmail = localStorage.getItem(AUTH_EMAIL_KEY) || null;
let authMode = "login"; // login | register

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayISO = () => new Date().toISOString().slice(0, 10);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round1 = (n) => Math.round(n * 10) / 10;

/* ---------------- Estado padrão ---------------- */
function defaultState() {
  return {
    profile: {
      name: "",
    },
    phases: [
      {
        id: uid(),
        name: "Fase 1 — Foco Superior/Peito",
        focus: "peito",
        goal: "bulk", // bulk | cut | manter
        startDate: todayISO(),
        durationWeeks: 12,
        trainingDays: ["segunda", "terca", "quarta", "quinta", "sexta"],
        template: null, // preenchido ao criar
      },
    ],
    activePhaseId: null, // definido após criar fase 1
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
    let migrated = false;
    (state.phases || []).forEach((ph) => {
      if (!ph.trainingDays) {
        // Migração: fases antigas treinavam segunda-a-sábado. Passa a excluir o sábado por padrão.
        ph.trainingDays = ["segunda", "terca", "quarta", "quinta", "sexta"];
        ph.template = generateSplit(ph.focus, ph.goal, ph.trainingDays);
        migrated = true;
      }
    });
    if (migrated) saveState(state);
    return state;
  } catch (e) {
    console.error("Erro ao carregar estado, recriando.", e);
    return initFirstRun();
  }
}

function initFirstRun() {
  const state = defaultState();
  state.phases[0].template = generateSplit(state.phases[0].focus, state.phases[0].goal, state.phases[0].trainingDays);
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
let syncDebounceTimer = null;
function persist() {
  saveState(STATE);
  if (authToken) {
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(pushStateToServer, 1200);
  }
}

function currentPhase() {
  return STATE.phases.find((ph) => ph.id === STATE.activePhaseId) || STATE.phases[0];
}

/* ---------------- Sincronização com o servidor ---------------- */
async function pushStateToServer() {
  if (!authToken) return;
  try {
    const res = await fetch(`${AUTH_API_BASE}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ state: STATE }),
    });
    if (res.status === 401) return handleAuthExpired();
    if (res.ok) {
      const data = await res.json();
      localStorage.setItem(SYNC_KEY, String(data.updatedAt));
    }
  } catch (e) {
    // Offline: fica só no localStorage por enquanto. O listener "online" logo
    // abaixo tenta de novo assim que a conexão voltar.
  }
}

async function pullStateFromServer() {
  if (!authToken) return;
  try {
    const res = await fetch(`${AUTH_API_BASE}/api/state`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.status === 401) return handleAuthExpired();
    if (!res.ok) return;
    const data = await res.json();
    if (data.state) {
      STATE = data.state;
      saveState(STATE);
      localStorage.setItem(SYNC_KEY, String(data.updatedAt || Date.now()));
    }
  } catch (e) {
    // Offline: segue com o que já está salvo localmente.
  }
}

// No boot com sessão já ativa: puxa o servidor em segundo plano e só troca o
// estado local se o servidor tiver algo mais novo que a última sincronização
// (evita sobrescrever uma edição feita agora mesmo, offline, neste aparelho).
async function syncOnBoot() {
  if (!authToken) return;
  try {
    const res = await fetch(`${AUTH_API_BASE}/api/state`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.status === 401) return handleAuthExpired();
    if (!res.ok) return;
    const data = await res.json();
    const lastSynced = Number(localStorage.getItem(SYNC_KEY) || 0);
    if (data.state && data.updatedAt && data.updatedAt > lastSynced) {
      STATE = data.state;
      saveState(STATE);
      localStorage.setItem(SYNC_KEY, String(data.updatedAt));
      render();
    }
  } catch (e) {
    // Offline no boot: segue com o cache local.
  }
}

async function onAuthSuccess(data, isNewAccount) {
  authToken = data.token;
  authEmail = data.email;
  localStorage.setItem(AUTH_TOKEN_KEY, authToken);
  localStorage.setItem(AUTH_EMAIL_KEY, authEmail);

  if (isNewAccount) {
    // Conta nova: migra pro servidor o que já estava salvo neste aparelho.
    await pushStateToServer();
  } else {
    await pullStateFromServer();
  }
  activeTab = "inicio";
  render();
}

function handleAuthExpired() {
  logout();
}

function logout() {
  authToken = null;
  authEmail = null;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_EMAIL_KEY);
  localStorage.removeItem(SYNC_KEY);
  // Limpa o cache local dos dados de treino: evita que a próxima conta a
  // logar neste aparelho veja, mesmo que por um instante, os dados da conta
  // anterior antes da sincronização com o servidor.
  localStorage.removeItem(STORAGE_KEY);
  STATE = defaultState();
  authMode = "login";
  activeTab = "inicio";
  render();
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
  // Programa "Full Body A/B (iniciante)" — protocolo de hipertrofia pra iniciante
  // ectomorfo: full body 3x/semana alternando A e B, priorizando compostos com
  // descanso maior (90-180s) e volume moderado (10-16 séries/grupo/semana).
  fullbody_ab_a: [
    { name: "Agachamento livre ou smith", sets: 3, reps: "8-10", rest: "90-180s" },
    { name: "Supino reto (barra ou halteres)", sets: 3, reps: "8-10", rest: "90-180s" },
    { name: "Remada curvada (barra)", sets: 3, reps: "8-10", rest: "90-180s" },
    { name: "Desenvolvimento com halteres", sets: 3, reps: "10-12" },
    { name: "Rosca direta (barra)", sets: 2, reps: "10-12" },
    { name: "Tríceps corda (polia)", sets: 2, reps: "10-12" },
    { name: "Prancha abdominal", sets: 3, reps: "quase até a falha" },
  ],
  fullbody_ab_b: [
    { name: "Levantamento terra (stiff ou convencional)", sets: 3, reps: "6-8", rest: "90-180s" },
    { name: "Puxada frente (pulley)", sets: 3, reps: "8-10", rest: "90-180s" },
    { name: "Leg press", sets: 3, reps: "10-12", rest: "90-180s" },
    { name: "Cadeira extensora", sets: 2, reps: "12" },
    { name: "Mesa flexora", sets: 2, reps: "12" },
    { name: "Elevação lateral", sets: 3, reps: "12-15" },
    { name: "Abdominal supra", sets: 3, reps: "quase até a falha" },
  ],
};

const FOCUS_LABELS = {
  peito: "Peito / Superior",
  costas: "Costas / Superior",
  ombro: "Ombro / Braços",
  pernas: "Pernas / Inferior",
  fullbody: "Corpo inteiro",
  fullbody_ab: "Full Body A/B (iniciante)",
};

const FOCUS_ICONS = {
  peito: "🏋️",
  costas: "🚣",
  ombro: "🤸",
  pernas: "🦵",
  fullbody: "🔁",
  fullbody_ab: "🆎",
  cardio: "🏃",
};

const DEFAULT_TRAINING_DAYS = ["segunda", "terca", "quarta", "quinta", "sexta"];

// Distribui os grupos musculares apenas pelos dias escolhidos pelo usuário (dias fora
// da lista viram descanso). Domingo, quando incluído, vira cardio (fase cut) ou full body.
function generateSplit(focus, goal, trainingDays) {
  const days = trainingDays && trainingDays.length ? trainingDays : DEFAULT_TRAINING_DAYS;
  const week = {};

  // Full Body A/B: alterna os dois treinos nos dias escolhidos, sem depender de
  // grupo muscular secundário nem tratar domingo como caso especial — ideal com
  // 3 dias não-consecutivos (ex: segunda/quarta/sexta) pra respeitar as 48h de
  // descanso entre sessões que trabalham os mesmos músculos.
  if (focus === "fullbody_ab") {
    let toggle = 0;
    WEEKDAYS.forEach(({ key: dayKey }) => {
      if (!days.includes(dayKey)) {
        week[dayKey] = [];
        return;
      }
      week[dayKey] = toggle % 2 === 0 ? EXERCISE_LIB.fullbody_ab_a : EXERCISE_LIB.fullbody_ab_b;
      toggle += 1;
    });
    return week;
  }

  const secondaryOrder = ["peito", "costas", "ombro", "pernas"].filter((f) => f !== focus);
  const pattern = [focus, secondaryOrder[0], secondaryOrder[1], focus, secondaryOrder[2], "fullbody"];
  let patternIdx = 0;
  WEEKDAYS.forEach(({ key: dayKey }) => {
    if (!days.includes(dayKey)) {
      week[dayKey] = [];
      return;
    }
    if (dayKey === "domingo") {
      week[dayKey] = goal === "cut" ? EXERCISE_LIB.cardio : EXERCISE_LIB.fullbody;
      return;
    }
    const group = pattern[patternIdx % pattern.length];
    week[dayKey] = EXERCISE_LIB[group];
    patternIdx += 1;
  });
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
   PRÉVIA DO EXERCÍCIO — 2 fotos (início/fim do movimento) exibidas em loop,
   como um GIF, direto no app. Fonte: free-exercise-db (domínio público),
   sem precisar abrir o YouTube.
   ======================================================================= */
const GIF_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";
const EXERCISE_GIF_MAP = {
  "Supino reto (barra ou halteres)": "Barbell_Bench_Press_-_Medium_Grip",
  "Supino inclinado com halteres": "Incline_Dumbbell_Press",
  "Crucifixo (halteres ou cross)": "Dumbbell_Flyes",
  "Tríceps corda (polia)": "Triceps_Pushdown_-_Rope_Attachment",
  "Tríceps francês": "Lying_Close-Grip_Barbell_Triceps_Extension_Behind_The_Head",
  "Puxada frente (pulley)": "Wide-Grip_Lat_Pulldown",
  "Remada curvada (barra)": "Bent_Over_Barbell_Row",
  "Remada unilateral (haltere)": "One-Arm_Dumbbell_Row",
  "Rosca direta (barra)": "Barbell_Curl",
  "Rosca alternada (halteres)": "Dumbbell_Alternate_Bicep_Curl",
  "Desenvolvimento com halteres": "Dumbbell_Shoulder_Press",
  "Elevação lateral": "Side_Lateral_Raise",
  "Elevação frontal": "Front_Dumbbell_Raise",
  "Encolhimento (trapézio)": "Dumbbell_Shrug",
  "Abdominal supra + prancha": "Crunches",
  "Agachamento livre ou smith": "Barbell_Squat",
  "Leg press": "Leg_Press",
  "Cadeira extensora": "Leg_Extensions",
  "Mesa flexora": "Lying_Leg_Curls",
  "Panturrilha em pé": "Standing_Calf_Raises",
  "Agachamento livre": "Barbell_Squat",
  "Supino reto": "Barbell_Bench_Press_-_Medium_Grip",
  "Remada curvada": "Bent_Over_Barbell_Row",
  "Abdominal + prancha": "Crunches",
  "Abdominal supra": "Crunches",
  "Corrida (leve a moderada)": "Running_Treadmill",
};

function exerciseGifFrames(exerciseName) {
  const id = EXERCISE_GIF_MAP[exerciseName];
  if (!id) return null;
  return [`${GIF_BASE}${id}/0.jpg`, `${GIF_BASE}${id}/1.jpg`];
}

function gifButtonHtml(exerciseName) {
  if (!exerciseGifFrames(exerciseName)) return "";
  return `<button type="button" class="video-link" data-gif-name="${escapeHtml(exerciseName)}">🎬 Ver</button>`;
}

let gifModalTimer = null;
function openGifModal(exerciseName) {
  const frames = exerciseGifFrames(exerciseName);
  if (!frames) return;
  const modal = document.getElementById("gif-modal");
  const img = document.getElementById("gif-modal-img");
  const title = document.getElementById("gif-modal-title");
  title.textContent = exerciseName;
  let frame = 0;
  img.src = frames[frame];
  modal.classList.remove("hidden");
  if (gifModalTimer) clearInterval(gifModalTimer);
  gifModalTimer = setInterval(() => {
    frame = frame === 0 ? 1 : 0;
    img.src = frames[frame];
  }, 600);
}

function closeGifModal() {
  if (gifModalTimer) clearInterval(gifModalTimer);
  gifModalTimer = null;
  document.getElementById("gif-modal").classList.add("hidden");
}

function allLoggedExerciseNames() {
  const set = new Set();
  STATE.workoutLogs.forEach((l) => l.exercises.forEach((e) => set.add(e.name)));
  return Array.from(set).sort();
}

function lastLoggedSetsForExercise(name) {
  const logs = STATE.workoutLogs
    .filter((l) => l.exercises.some((e) => e.name === name))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!logs.length) return null;
  const ex = logs[0].exercises.find((e) => e.name === name);
  return ex ? ex.sets : null;
}

// Maior peso do dia para o exercício, por data — últimas 12 sessões registradas.
function maxWeightSeriesForExercise(name) {
  const byDate = {};
  STATE.workoutLogs
    .filter((l) => l.exercises.some((e) => e.name === name))
    .forEach((l) => {
      l.exercises
        .filter((e) => e.name === name)
        .forEach((e) => {
          const maxW = Math.max(0, ...e.sets.map((s) => Number(s.weight) || 0));
          if (byDate[l.date] === undefined || maxW > byDate[l.date]) byDate[l.date] = maxW;
        });
    });
  return Object.entries(byDate)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([date, weight]) => ({ date, weight }));
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
  const nav = document.querySelector("nav.tabbar");
  if (!authToken) {
    nav.classList.add("hidden");
    APP_EL.innerHTML = renderAuth();
    attachHandlers();
    return;
  }
  nav.classList.remove("hidden");

  let html = "";
  if (activeTab === "inicio") html = renderInicio();
  else if (activeTab === "treino") html = renderTreino();
  else if (activeTab === "progresso") html = renderProgresso();
  else if (activeTab === "perfil") html = renderPerfil();
  APP_EL.innerHTML = html;
  attachHandlers();
}

/* ---------------- Login / criar conta ---------------- */
function renderAuth() {
  const isRegister = authMode === "register";
  return `
    <section class="card">
      <h2>${isRegister ? "Criar conta" : "Entrar"}</h2>
      <p class="muted">Seus treinos ficam salvos na sua conta e sincronizam entre aparelhos.</p>

      <label>E-mail</label>
      <input type="email" id="auth-email" autocomplete="username" />

      <label>Senha</label>
      <input type="password" id="auth-password" autocomplete="${isRegister ? "new-password" : "current-password"}" />

      ${
        isRegister
          ? `<label>Confirmar senha</label><input type="password" id="auth-password-confirm" autocomplete="new-password" />`
          : ""
      }

      <p id="auth-error" class="muted small hidden" style="color:#d03b3b;"></p>

      <button class="btn" id="btn-auth-submit">${isRegister ? "Criar conta" : "Entrar"}</button>
      <button class="btn secondary" id="btn-auth-toggle">${isRegister ? "Já tenho conta" : "Criar conta nova"}</button>
    </section>
  `;
}

function attachAuthHandlers() {
  document.getElementById("btn-auth-toggle").addEventListener("click", () => {
    authMode = authMode === "register" ? "login" : "register";
    render();
  });

  document.getElementById("btn-auth-submit").addEventListener("click", async () => {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    const errEl = document.getElementById("auth-error");
    errEl.classList.add("hidden");

    if (!email || !password) {
      errEl.textContent = "Preencha e-mail e senha.";
      errEl.classList.remove("hidden");
      return;
    }
    if (authMode === "register") {
      const confirmPassword = document.getElementById("auth-password-confirm").value;
      if (password !== confirmPassword) {
        errEl.textContent = "As senhas não coincidem.";
        errEl.classList.remove("hidden");
        return;
      }
    }

    const btn = document.getElementById("btn-auth-submit");
    btn.disabled = true;
    try {
      const path = authMode === "register" ? "/api/register" : "/api/login";
      const res = await fetch(`${AUTH_API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Não foi possível continuar.");
      await onAuthSuccess(data, authMode === "register");
    } catch (e) {
      errEl.textContent = e instanceof TypeError ? "Erro de conexão. Verifique a internet e tente de novo." : e.message;
      errEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- INÍCIO ---------------- */
function renderInicio() {
  const p = STATE.profile;
  const phase = currentPhase();
  const wk = todayWeekdayKey();
  const todaysWorkout = (phase.template && phase.template[wk]) || [];

  return `
    <section class="card">
      <h2>Olá${p.name ? ", " + escapeHtml(p.name) : ""} 👋</h2>
      <p class="muted">${new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}</p>
    </section>

    <section class="card">
      <h3>Treino de hoje — ${WEEKDAYS.find((w) => w.key === wk).label}</h3>
      <p class="muted">${phase.name}</p>
      ${
        todaysWorkout.length
          ? `<ul class="ex-list">${todaysWorkout
              .map(
                (e) =>
                  `<li>${escapeHtml(e.name)} — ${e.sets}x${e.reps} ${gifButtonHtml(e.name)}</li>`
              )
              .join("")}</ul>`
          : `<p class="muted">Descanso hoje 🙌</p>`
      }
      <button class="btn" data-goto="treino">Ir para Treino</button>
    </section>
  `;
}

/* ---------------- TREINO ---------------- */
function renderDayAccordion(w, exs, isToday) {
  return `
        <details class="day-acc ${isToday ? "today" : ""}" ${isToday ? "open" : ""}>
          <summary class="day-acc-head">
            <span class="day-acc-name">${w.label}</span>
            ${isToday ? `<span class="badge today">hoje</span>` : ""}
            <span class="day-acc-count">${exs.length ? `${exs.length} exercícios` : "descanso"}</span>
            <span class="chev">›</span>
          </summary>
          <div class="day-acc-body">
            ${
              exs.length
                ? `<ul class="ex-rows">${exs
                    .map(
                      (e, i) => `
                  <li class="ex-row">
                    <span class="ex-num">${i + 1}</span>
                    <span class="ex-info">
                      <span class="ex-name">${escapeHtml(e.name)}</span>
                      <span class="ex-meta">${e.sets}×${e.reps}${e.rest ? ` · descanso ${e.rest}` : ""}</span>
                    </span>
                    ${gifButtonHtml(e.name)}
                  </li>`
                    )
                    .join("")}</ul>`
                : `<p class="rest-note">😌 Dia de descanso</p>`
            }
          </div>
        </details>`;
}

function renderLogExercise(e, i) {
  const lastSets = lastLoggedSetsForExercise(e.name);
  const lastWeight = lastSets && lastSets.length ? Math.max(...lastSets.map((s) => Number(s.weight) || 0)) : null;
  return `
          <div class="log-exercise">
            <div class="log-exercise-head">
              <span class="ex-num">${i + 1}</span>
              <span class="ex-title">
                <b>${escapeHtml(e.name)}</b>
                <span class="muted small">alvo ${e.sets}×${e.reps}${e.rest ? ` · descanso ${e.rest}` : ""}</span>
              </span>
              ${gifButtonHtml(e.name)}
            </div>
            ${lastWeight ? `<span class="last-load">📊 última carga: ${lastWeight}kg</span>` : ""}
            <div class="sets-row" data-ex-idx="${i}" data-ex-name="${escapeHtml(e.name)}">
              ${Array.from({ length: e.sets })
                .map(
                  (_, si) => `
                <div class="set-input">
                  <span class="set-label">${si + 1}</span>
                  <input type="number" placeholder="reps" data-set="${si}" data-field="reps" />
                  <input type="number" placeholder="${lastWeight ? "kg (últ. " + lastWeight + ")" : "kg"}" data-set="${si}" data-field="weight" />
                </div>`
                )
                .join("")}
            </div>
          </div>`;
}

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
      <p class="focus-chip"><span class="focus-ico">${FOCUS_ICONS[phase.focus] || "🏋️"}</span> ${FOCUS_LABELS[phase.focus] || phase.focus} <span class="badge accent">${goalLabel(phase.goal)}</span> <span class="muted small">${phase.durationWeeks} semanas</span></p>

      <label>Foco do treino</label>
      <select id="phase-focus-select">
        ${Object.keys(FOCUS_LABELS)
          .map((f) => `<option value="${f}" ${f === phase.focus ? "selected" : ""}>${FOCUS_ICONS[f] || ""} ${FOCUS_LABELS[f]}</option>`)
          .join("")}
      </select>
      ${
        phase.focus === "fullbody_ab"
          ? `<p class="muted small coach-note">🆎 Pra esse programa funcionar como pensado, o ideal é marcar só 3 dias não-consecutivos abaixo (ex: segunda/quarta/sexta) — full body direto sem folga entre os dias não dá tempo de recuperar.</p>`
          : ""
      }

      <label>Dias de treino</label>
      <div class="weekday-picker">
        ${WEEKDAYS.map(
          (w) => `
          <label><input type="checkbox" name="training-day" value="${w.key}" ${(phase.trainingDays || []).includes(w.key) ? "checked" : ""} /> ${w.label}</label>`
        ).join("")}
      </div>

      <button class="btn secondary" id="btn-new-phase">+ Nova fase</button>
    </section>

    <section class="card">
      <h3>Semana de treino</h3>
      <div class="day-acc-list">
        ${WEEKDAYS.map((w) => renderDayAccordion(w, (phase.template && phase.template[w.key]) || [], w.key === wk)).join("")}
      </div>
    </section>

    <section class="card">
      <h3>Registrar treino de hoje</h3>
      <div id="log-exercise-list">
        ${((phase.template && phase.template[wk]) || []).map((e, i) => renderLogExercise(e, i)).join("") || `<p class="muted">Sem exercícios programados para hoje.</p>`}
      </div>
      <button class="btn" id="btn-save-workout">Salvar treino de hoje</button>
    </section>

    <section class="card">
      <h3>Treinos registrados hoje</h3>
      ${
        todaysLogs.length
          ? `<ul class="workout-log-list">${todaysLogs
              .map(
                (l) => `
              <li class="workout-log-item">
                <div>
                  <b>${escapeHtml(l.dayLabel)}</b>
                  <div class="workout-log-stats">
                    <span class="badge">${l.exercises.length} exercícios</span>
                    <span class="badge accent">${Math.round(totalVolumeForLog(l))} kg</span>
                  </div>
                </div>
                <button class="icon-btn" data-del-workout="${l.id}">✕</button>
              </li>`
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
let selectedLoadExercise = null;

function renderProgresso() {
  const names = allLoggedExerciseNames();
  if (!selectedLoadExercise || !names.includes(selectedLoadExercise)) {
    selectedLoadExercise = names[names.length - 1] || null;
  }

  return `
    <section class="card">
      <h2>Progresso</h2>
      <p class="muted">Últimos 7 dias</p>
      <h3>Volume de treino (kg totais)</h3>
      <canvas id="chart-volume" width="600" height="220"></canvas>
    </section>
    <section class="card">
      <h3>Evolução de carga por exercício</h3>
      ${
        names.length
          ? `
        <select id="load-exercise-select">
          ${names.map((n) => `<option value="${escapeHtml(n)}" ${n === selectedLoadExercise ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}
        </select>
        <canvas id="chart-load" width="600" height="220"></canvas>
        <p id="load-trend" class="muted small"></p>`
          : `<p class="muted">Registre treinos com peso para ver aqui se sua carga está aumentando.</p>`
      }
    </section>
  `;
}

function drawChartsIfNeeded() {
  const volCanvas = document.getElementById("chart-volume");
  const loadCanvas = document.getElementById("chart-load");
  if (volCanvas) drawVolumeChart(volCanvas);
  if (loadCanvas && selectedLoadExercise) drawLoadChart(loadCanvas, selectedLoadExercise);

  const loadSelect = document.getElementById("load-exercise-select");
  if (loadSelect) {
    loadSelect.addEventListener("change", () => {
      selectedLoadExercise = loadSelect.value;
      render();
    });
  }
}

// Paleta do skill dataviz: series-1 azul #2a78d6
const COLOR_BLUE = "#2a78d6";
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

function drawLoadChart(canvas, exerciseName) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const series = maxWeightSeriesForExercise(exerciseName);
  const trendEl = document.getElementById("load-trend");
  if (!series.length) {
    if (trendEl) trendEl.textContent = "";
    return;
  }

  const values = series.map((s) => s.weight);
  const maxVal = Math.max(...values, 1) * 1.15;

  const padL = 40, padB = 24, padT = 14, padR = 14;
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

  const stepX = series.length > 1 ? chartW / (series.length - 1) : 0;
  const pointX = (i) => padL + (series.length > 1 ? stepX * i : chartW / 2);
  const pointY = (val) => padT + chartH - (val / maxVal) * chartH;

  ctx.strokeStyle = COLOR_BLUE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((s, i) => {
    const x = pointX(i);
    const y = pointY(s.weight);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.font = "10px system-ui, sans-serif";
  series.forEach((s, i) => {
    const x = pointX(i);
    const y = pointY(s.weight);
    ctx.fillStyle = COLOR_BLUE;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COLOR_TEXT;
    ctx.textAlign = "center";
    const label = new Date(s.date + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
    ctx.fillText(label, x, h - 6);
  });

  if (trendEl) {
    const first = values[0];
    const last = values[values.length - 1];
    const diff = round1(last - first);
    if (values.length < 2) {
      trendEl.innerHTML = `Primeiro registro: <b>${last}kg</b>. Continue registrando para ver a evolução.`;
    } else if (diff > 0) {
      trendEl.innerHTML = `<span class="trend-up">📈 +${diff}kg</span> desde o primeiro registro (${first}kg → ${last}kg)`;
    } else if (diff < 0) {
      trendEl.innerHTML = `<span class="trend-down">📉 ${diff}kg</span> desde o primeiro registro (${first}kg → ${last}kg)`;
    } else {
      trendEl.innerHTML = `➖ Carga estável em ${last}kg`;
    }
  }
}

/* ---------------- PERFIL ---------------- */
function renderPerfil() {
  const p = STATE.profile;

  return `
    <section class="card">
      <h2>Perfil</h2>
      ${authEmail ? `<p class="muted small">Conectado como <b>${escapeHtml(authEmail)}</b></p>` : ""}
      <label>Nome</label>
      <input type="text" id="pf-name" value="${escapeHtml(p.name)}" />

      <button class="btn" id="btn-save-profile">Salvar perfil</button>
    </section>

    <section class="card">
      <h3>Dados</h3>
      <button class="btn secondary" id="btn-export">Exportar backup (JSON)</button>
      <button class="btn danger" id="btn-reset">Apagar todos os dados</button>
    </section>

    <section class="card">
      <h3>Conta</h3>
      <button class="btn secondary" id="btn-logout">Sair</button>
    </section>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* =======================================================================
   HANDLERS
   ======================================================================= */
function attachHandlers() {
  if (!authToken) {
    attachAuthHandlers();
    return;
  }

  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", () => setTab(el.dataset.goto));
  });

  if (activeTab === "treino") attachTreinoHandlers();
  if (activeTab === "perfil") attachPerfilHandlers();
  if (activeTab === "progresso") drawChartsIfNeeded();
}

function attachTreinoHandlers() {
  const phaseSelect = document.getElementById("phase-select");
  phaseSelect.addEventListener("change", () => {
    STATE.activePhaseId = phaseSelect.value;
    persist();
    render();
  });

  const focusSelect = document.getElementById("phase-focus-select");
  focusSelect.addEventListener("change", () => {
    const phase = currentPhase();
    phase.focus = focusSelect.value;
    phase.template = generateSplit(phase.focus, phase.goal, phase.trainingDays);
    persist();
    render();
  });

  document.querySelectorAll('input[name="training-day"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const checkboxes = document.querySelectorAll('input[name="training-day"]');
      const checked = Array.from(checkboxes)
        .filter((c) => c.checked)
        .map((c) => c.value);
      if (!checked.length) {
        cb.checked = true;
        alert("Selecione ao menos um dia de treino.");
        return;
      }
      const orderedDays = WEEKDAYS.filter((w) => checked.includes(w.key)).map((w) => w.key);
      const phase = currentPhase();
      phase.trainingDays = orderedDays;
      phase.template = generateSplit(phase.focus, phase.goal, orderedDays);
      persist();
      render();
    });
  });

  document.getElementById("btn-new-phase").addEventListener("click", () => {
    const name = prompt("Nome da nova fase (ex: Fase 2 — Foco Pernas):");
    if (!name) return;
    const focus = (prompt("Foco: peito, costas, ombro, pernas, fullbody ou fullbody_ab (Full Body A/B iniciante)", "peito") || "peito").trim();
    const goal = (prompt("Objetivo: bulk (ganho de massa), cut (definição) ou manter", "bulk") || "bulk").trim();
    const durationWeeks = Number(prompt("Duração em semanas:", "12")) || 12;
    const validFocus = FOCUS_LABELS[focus] ? focus : "peito";
    const validGoal = ["bulk", "cut", "manter"].includes(goal) ? goal : "bulk";
    const trainingDays = currentPhase().trainingDays || DEFAULT_TRAINING_DAYS;
    const newPhase = {
      id: uid(),
      name,
      focus: validFocus,
      goal: validGoal,
      startDate: todayISO(),
      durationWeeks,
      trainingDays,
      template: generateSplit(validFocus, validGoal, trainingDays),
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
    };
    persist();
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
    if (authToken) pushStateToServer();
    render();
  });

  document.getElementById("btn-logout").addEventListener("click", () => {
    if (!confirm("Sair da conta?")) return;
    logout();
  });
}

/* =======================================================================
   INICIALIZAÇÃO
   ======================================================================= */
STATE = loadState();

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

document.body.addEventListener("click", (e) => {
  const gifBtn = e.target.closest("[data-gif-name]");
  if (gifBtn) {
    openGifModal(gifBtn.dataset.gifName);
    return;
  }
  if (e.target.closest("#gif-modal-close") || e.target.id === "gif-modal") {
    closeGifModal();
  }
});

window.addEventListener("online", () => {
  if (authToken) pushStateToServer();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW falhou", e));
  });

  // No iPhone, abrir pela tela de início costuma só retomar o processo
  // suspenso em vez de recarregar a página — nenhum fetch novo acontece e o
  // app fica preso na versão antiga. Se o app ficou em segundo plano por mais
  // de 5 minutos, força um reload ao voltar pra buscar a versão mais nova.
  let reloadingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    window.location.reload();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const last = Number(sessionStorage.getItem("lastActiveAt") || 0);
    const now = Date.now();
    sessionStorage.setItem("lastActiveAt", String(now));
    if (last && now - last > 5 * 60 * 1000) {
      window.location.reload();
    }
  });
}

render();
if (authToken) syncOnBoot();
