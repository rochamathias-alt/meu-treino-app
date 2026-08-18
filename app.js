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
      trainingTime: "08:00",
      fastedTraining: false, // se true, a 1ª refeição é agendada depois do treino, não na hora de acordar
      adaptationMode: false, // sobe a meta calórica aos poucos em vez de já começar na meta cheia
      adaptationStartDate: null, // ISO date de quando o modo adaptação foi ligado
      adaptationWeeks: 2,
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
    customFoods: [],
    mealLogs: [], // {id, date, time, mealSlot, name, grams, kcal, p, c, g, fullGrams, fullKcal, fullP, fullC, fullG, portionPct, leftoverHandled}
    workoutLogs: [], // {id, date, dayLabel, exercises:[{name, sets:[{reps,weight}]}]}
    dietAdjust: null, // {date, extraKcal} — sobra de calorias de refeições comidas parcialmente, redistribuída pro resto do dia
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
    if (state.profile && state.profile.trainingTime === undefined) {
      state.profile.trainingTime = "08:00";
      state.profile.fastedTraining = false;
      migrated = true;
    }
    if (state.profile && state.profile.adaptationMode === undefined) {
      state.profile.adaptationMode = false;
      state.profile.adaptationStartDate = null;
      state.profile.adaptationWeeks = 2;
      migrated = true;
    }
    if (state.dietAdjust === undefined) {
      state.dietAdjust = null;
      migrated = true;
    }
    (state.mealLogs || []).forEach((l) => {
      if (l.fullKcal === undefined) {
        l.fullGrams = l.grams;
        l.fullKcal = l.kcal;
        l.fullP = l.p;
        l.fullC = l.c;
        l.fullG = l.g;
        l.portionPct = 100;
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

// Modo adaptação: em vez de já começar na meta cheia, a meta calórica sobe
// aos poucos (começa ~15% abaixo) ao longo de 1-2 semanas — pra quem come
// pouco não precisar forçar volume grande logo de cara.
const ADAPTATION_START_FACTOR = 0.85;
function adaptationFactor(p) {
  if (!p.adaptationMode || !p.adaptationStartDate) return 1;
  const totalDays = clamp(p.adaptationWeeks || 2, 1, 2) * 7;
  const start = new Date(p.adaptationStartDate + "T00:00:00");
  const daysElapsed = Math.floor((new Date() - start) / 86400000);
  if (daysElapsed >= totalDays || daysElapsed < 0) return 1;
  const progress = clamp(daysElapsed / totalDays, 0, 1);
  return ADAPTATION_START_FACTOR + (1 - ADAPTATION_START_FACTOR) * progress;
}

function calcTargets(p, goal) {
  const tdee = calcTDEE(p);
  const fullKcal = Math.round(tdee + goalAdjustment(goal));
  const factor = adaptationFactor(p);
  const kcal = Math.round(fullKcal * factor);
  const proteinG = Math.round(p.weightKg * (goal === "cut" ? 2.2 : 2.0));
  const fatG = Math.round((kcal * 0.25) / 9);
  const remainingKcal = kcal - proteinG * 4 - fatG * 9;
  const carbG = Math.max(0, Math.round(remainingKcal / 4));
  return { kcal, proteinG, fatG, carbG, tdee: Math.round(tdee), fullKcal, adapting: factor < 1 };
}

function currentPhase() {
  return STATE.phases.find((ph) => ph.id === STATE.activePhaseId) || STATE.phases[0];
}

/* =======================================================================
   HORÁRIOS DE REFEIÇÃO (a cada N horas a partir do horário que acorda)
   Em dia de treino com "treino em jejum" ativado, a 1ª refeição é empurrada
   pra depois do treino em vez de cair bem na hora de acordar.
   ======================================================================= */
function mealSlots() {
  const p = STATE.profile;
  const [h, m] = p.wakeTime.split(":").map(Number);
  const wakeMinutes = h * 60 + m;
  let startMinutes = wakeMinutes;
  let firstIsPostWorkout = false;

  const isTrainingDay = (currentPhase().trainingDays || []).includes(todayWeekdayKey());
  if (isTrainingDay && p.fastedTraining && p.trainingTime) {
    const [th, tm] = p.trainingTime.split(":").map(Number);
    const postWorkoutMinutes = th * 60 + tm + 60; // ~1h após o treino
    if (postWorkoutMinutes > startMinutes) {
      startMinutes = postWorkoutMinutes;
      firstIsPostWorkout = true;
    }
  }

  const slots = [];
  let minutes = startMinutes;
  const endMinutes = wakeMinutes + p.sleepWindowHours * 60;
  let idx = 1;
  while (minutes <= endMinutes) {
    const hh = Math.floor((minutes / 60) % 24).toString().padStart(2, "0");
    const mm = (minutes % 60).toString().padStart(2, "0");
    slots.push({ label: `Refeição ${idx}`, time: `${hh}:${mm}`, postWorkout: idx === 1 && firstIsPostWorkout });
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

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Calorias que sobraram de refeições comidas parcialmente hoje e que o
// usuário escolheu redistribuir pro resto do dia (em vez de compensar com
// shake na hora). Some do zero automaticamente quando o dia vira.
function pendingRedistributionKcal() {
  const adj = STATE.dietAdjust;
  if (!adj || adj.date !== todayISO()) return 0;
  return adj.extraKcal || 0;
}

function addDietAdjustKcal(amount) {
  const today = todayISO();
  const current = STATE.dietAdjust && STATE.dietAdjust.date === today ? STATE.dietAdjust.extraKcal : 0;
  STATE.dietAdjust = { date: today, extraKcal: Math.max(0, current + amount) };
}

/* =======================================================================
   SUGESTÃO DE CARDÁPIO — pra cada horário (vindo do Perfil), mostra quantas
   calorias precisam ser batidas naquele horário, dividido por categoria do
   prato (Carboidrato / Feijão / Proteína / Verdura), igual um cardápio de
   nutricionista. O usuário escolhe o alimento de cada categoria (ou deixa
   em branco) e o app calcula a quantidade em gramas necessária pra bater a
   meta daquele horário. Sobra de calorias/proteína do dia é fechada com
   whey/hipercalórico. Escolhas não são salvas entre sessões (preferência de
   uso, não dado permanente).
   ======================================================================= */
const FOOD_CATEGORIES = [
  { key: "carbo", label: "Carboidrato" },
  { key: "leguminosa", label: "Feijão" },
  { key: "proteina", label: "Proteína" },
  { key: "vegetal", label: "Verdura/Legume" },
  { key: "gordura", label: "Gordura extra" },
];
const DEFAULT_SLOT_TEMPLATES = {
  breakfast: { carbo: "Pão integral", leguminosa: "", proteina: "Ovo", vegetal: "", gordura: "" },
  main: {
    carbo: "Arroz branco cozido",
    leguminosa: "Feijão carioca cozido",
    proteina: "Peito de frango grelhado",
    vegetal: "Salada mista (folhas/legumes crus)",
    gordura: "",
  },
};
let planFoodChoices = {}; // { [slotIndex]: { carbo: foodName|"", ... } } — escolha do usuário, não persistida
let planSlotMode = {}; // { [slotIndex]: "normal" | "dense" | "shake" } — não persistida
let expandedAdjust = {}; // { [slotIndex]: true } — painel "ajustar refeição" aberto, não persistida

// Verdura/legume é sempre uma porção fixa (tipo "salada à vontade"), não entra
// na divisão de calorias — se entrasse, sairia tipo 500g de alface pra bater a
// meta calórica do horário. As demais categorias dividem a caloria do horário
// pelos pesos abaixo. No modo "denso", carbo/feijão perdem peso pra
// proteína/gordura, que são mais calóricos por grama — mesma meta de kcal,
// bem menos volume de comida.
const SLOT_MODES = {
  normal: { label: "Prato normal", shares: { carbo: 0.4, leguminosa: 0.2, proteina: 0.35, gordura: 0.05 }, vegetalGrams: 150 },
  dense: { label: "Mais denso (menos volume)", shares: { carbo: 0.15, leguminosa: 0.1, proteina: 0.3, gordura: 0.45 }, vegetalGrams: 80 },
};
const DENSE_MODE_DEFAULT_FAT = "Pasta de amendoim";

// Shake calórico: alternativa líquida pra bater a mesma meta de kcal de uma
// refeição com muito menos volume pra mastigar/engolir. As gramas-base abaixo
// são escaladas proporcionalmente pra bater a meta de kcal do horário.
const SHAKE_COMBO_BASE = [
  { name: "Leite integral", baseGrams: 300 },
  { name: "Banana", baseGrams: 100 },
  { name: "Pasta de amendoim", baseGrams: 20 },
  { name: "Whey protein (pó)", baseGrams: 30 },
];

function computeShakeForKcal(targetKcal) {
  const items = SHAKE_COMBO_BASE.map((c) => ({ ...c, food: allFoods().find((f) => f.name === c.name) })).filter((it) => it.food);
  const baseKcal = items.reduce((s, it) => s + (it.food.kcal * it.baseGrams) / 100, 0);
  const factor = baseKcal > 0 && targetKcal > 0 ? targetKcal / baseKcal : 1;
  const macros = { kcal: 0, p: 0, c: 0, g: 0 };
  const scaled = items.map((it) => {
    const grams = Math.max(5, Math.round((it.baseGrams * factor) / 5) * 5);
    const m = computeFromGrams(it.food, grams);
    macros.kcal += m.kcal;
    macros.p += m.p;
    macros.c += m.c;
    macros.g += m.g;
    return { name: it.name, grams, macros: m };
  });
  return { items: scaled, macros };
}

function gramsForKcal(food, kcalTarget) {
  if (!food || kcalTarget <= 0) return 0;
  return Math.max(5, Math.round(((kcalTarget / food.kcal) * 100) / 5) * 5);
}

function generateMealPlan() {
  const p = STATE.profile;
  const phase = currentPhase();
  const targets = calcTargets(p, phase.goal);
  const slots = mealSlots();
  if (!slots.length) return null;

  const wheyFood = FOOD_DB.find((f) => f.name === "Whey protein (pó)");
  const hiperFood = FOOD_DB.find((f) => f.name === "Hipercalórico (pó)");
  let wheyServings = 1;
  let wheyMacros = computeFromGrams(wheyFood, wheyServings * 30);

  const baseSlotKcal = Math.max(0, (targets.kcal - wheyMacros.kcal) / slots.length);

  // Sobra redistribuída de refeições comidas parcialmente hoje: só entra nos
  // horários que ainda não passaram (os que já passaram já foram decididos).
  const extraKcal = pendingRedistributionKcal();
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const upcomingIdx = slots.map((s, i) => i).filter((i) => timeToMinutes(slots[i].time) >= nowMinutes);
  const bonusPerSlot = extraKcal > 0 && upcomingIdx.length ? extraKcal / upcomingIdx.length : 0;

  let mealTotals = { kcal: 0, p: 0, c: 0, g: 0 };
  const planSlots = slots.map((slot, i) => {
    const perSlotKcal = baseSlotKcal + (upcomingIdx.includes(i) ? bonusPerSlot : 0);
    const mode = planSlotMode[i] || "normal";

    if (mode === "shake") {
      const shake = computeShakeForKcal(perSlotKcal);
      mealTotals = {
        kcal: mealTotals.kcal + shake.macros.kcal,
        p: mealTotals.p + shake.macros.p,
        c: mealTotals.c + shake.macros.c,
        g: mealTotals.g + shake.macros.g,
      };
      return {
        time: slot.time,
        label: slot.label,
        postWorkout: slot.postWorkout,
        targetKcal: Math.round(perSlotKcal),
        mode,
        shake,
        macros: shake.macros,
      };
    }

    const modeCfg = SLOT_MODES[mode] || SLOT_MODES.normal;
    const defaults = i === 0 ? DEFAULT_SLOT_TEMPLATES.breakfast : DEFAULT_SLOT_TEMPLATES.main;
    const choice = planFoodChoices[i] || {};
    const items = {};
    FOOD_CATEGORIES.forEach((cat) => {
      let name = choice[cat.key] !== undefined ? choice[cat.key] : defaults[cat.key];
      if (mode === "dense" && cat.key === "gordura" && !name) name = DENSE_MODE_DEFAULT_FAT;
      const food = name ? allFoods().find((f) => f.name === name) : null;
      items[cat.key] = { name: name || "", food };
    });
    const weightSum = Object.keys(modeCfg.shares).reduce((s, key) => s + (items[key].food ? modeCfg.shares[key] : 0), 0);

    const macros = { kcal: 0, p: 0, c: 0, g: 0 };
    FOOD_CATEGORIES.forEach((cat) => {
      const entry = items[cat.key];
      if (!entry.food) {
        entry.grams = 0;
        entry.macros = null;
        return;
      }
      const grams =
        cat.key === "vegetal" ? modeCfg.vegetalGrams : gramsForKcal(entry.food, weightSum ? (perSlotKcal * modeCfg.shares[cat.key]) / weightSum : 0);
      entry.grams = grams;
      entry.macros = computeFromGrams(entry.food, grams);
      macros.kcal += entry.macros.kcal;
      macros.p += entry.macros.p;
      macros.c += entry.macros.c;
      macros.g += entry.macros.g;
    });
    mealTotals = { kcal: mealTotals.kcal + macros.kcal, p: mealTotals.p + macros.p, c: mealTotals.c + macros.c, g: mealTotals.g + macros.g };

    return { time: slot.time, label: slot.label, postWorkout: slot.postWorkout, targetKcal: Math.round(perSlotKcal), mode, items, macros };
  });

  // Whey: pelo menos 1 dose por dia (hábito relatado); 2 doses se as
  // refeições escolhidas ainda deixarem uma boa lacuna de proteína.
  let totals = { kcal: mealTotals.kcal + wheyMacros.kcal, p: mealTotals.p + wheyMacros.p, c: mealTotals.c + wheyMacros.c, g: mealTotals.g + wheyMacros.g };
  if (targets.proteinG - totals.p > 30) {
    wheyServings = 2;
    wheyMacros = computeFromGrams(wheyFood, wheyServings * 30);
    totals = { kcal: mealTotals.kcal + wheyMacros.kcal, p: mealTotals.p + wheyMacros.p, c: mealTotals.c + wheyMacros.c, g: mealTotals.g + wheyMacros.g };
  }

  // Hipercalórico fecha o restante das calorias do dia.
  let hiper = null;
  const gapKcal = targets.kcal - totals.kcal;
  if (gapKcal > 50) {
    const grams = Math.min(300, Math.max(20, Math.round(((gapKcal / hiperFood.kcal) * 100) / 5) * 5));
    const macros = computeFromGrams(hiperFood, grams);
    hiper = { name: hiperFood.name, grams, macros, splitAdvised: grams > 150 };
    totals = { kcal: totals.kcal + macros.kcal, p: totals.p + macros.p, c: totals.c + macros.c, g: totals.g + macros.g };
  }

  return {
    targets,
    slots: planSlots,
    whey: { name: wheyFood.name, grams: wheyServings * 30, servings: wheyServings, macros: wheyMacros },
    hiper,
    totals,
    redistributedKcal: Math.round(extraKcal),
  };
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

/* ---------------- ALIMENTAÇÃO ---------------- */
let lastMealPlan = null;

function foodSelectOptions(selected, group) {
  const foods = [...allFoods()]
    .filter((f) => !group || f.group === group)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const opts = [`<option value="" ${selected === "" ? "selected" : ""}>— nenhum —</option>`];
  foods.forEach((f) => {
    opts.push(`<option value="${escapeHtml(f.name)}" ${selected === f.name ? "selected" : ""}>${escapeHtml(f.name)}</option>`);
  });
  return opts.join("");
}

function renderPlanSlotBody(s, i) {
  if (s.mode === "shake") {
    return `
      <p class="muted small">🥤 Shake calórico — bate a mesma meta com bem menos volume.</p>
      <ul class="shake-items">
        ${s.shake.items.map((it) => `<li>${escapeHtml(it.name)} — <b>${it.grams}g</b> <span class="muted">(${Math.round(it.macros.kcal)} kcal)</span></li>`).join("")}
      </ul>
    `;
  }
  return FOOD_CATEGORIES.map((cat) => {
    const item = s.items[cat.key];
    return `
    <div class="plan-food-row">
      <span class="plan-food-label">${cat.label}</span>
      <select data-plan-food="${i}-${cat.key}">${foodSelectOptions(item.name, cat.key)}</select>
      ${item.grams ? `<b class="plan-grams">${item.grams}g</b>` : ""}
    </div>`;
  }).join("");
}

function renderPlanSlotAdjust(s, i) {
  if (s.mode === "dense" || s.mode === "shake") {
    const modeLabel = s.mode === "dense" ? "Prato mais denso" : "Shake calórico";
    return `
      <div class="adjust-banner">
        <span>🎯 Ajustado pra menos volume: <b>${modeLabel}</b></span>
        <button type="button" class="link-btn" data-slot-mode="${i}-normal">voltar ao prato normal</button>
      </div>
    `;
  }
  if (expandedAdjust[i]) {
    return `
      <div class="adjust-panel">
        <p class="muted small">Sem problema! Duas formas de bater a mesma meta de kcal com menos comida:</p>
        <div class="adjust-options">
          <button type="button" class="btn secondary small" data-slot-mode="${i}-dense">🥑 Prato mais denso</button>
          <button type="button" class="btn secondary small" data-slot-mode="${i}-shake">🥤 Shake calórico</button>
        </div>
        <button type="button" class="link-btn" data-adjust-toggle="${i}">fechar</button>
      </div>
    `;
  }
  return `<button type="button" class="link-btn adjust-toggle" data-adjust-toggle="${i}">Não estou conseguindo comer tudo? Ajustar essa refeição</button>`;
}

function renderMealPlanCard(plan) {
  return `
    <section class="card highlight">
      <h3>O que comer hoje</h3>
      <p class="muted small">Monte o prato de cada horário por categoria — a grama pra bater a caloria é calculada sozinha.</p>
      ${
        plan.redistributedKcal > 0
          ? `<p class="muted small coach-note">↻ Redistribuindo ${plan.redistributedKcal} kcal que sobraram de refeições anteriores nos próximos horários de hoje.</p>`
          : ""
      }
      <ul class="plan-list">
        ${plan.slots
          .map(
            (s, i) => `
          <li class="plan-item">
            <div class="plan-item-head">
              <span><b>${s.time}</b>${s.postWorkout ? " (pós-treino)" : ""} · ${s.targetKcal} kcal</span>
              <button type="button" class="btn secondary small" data-log-plan="${i}">+</button>
            </div>
            ${renderPlanSlotBody(s, i)}
            ${renderPlanSlotAdjust(s, i)}
          </li>`
          )
          .join("")}
        <li class="plan-item">
          <div class="plan-item-head">
            <span><b>Whey</b> · ${plan.whey.servings}x/dia</span>
            <button type="button" class="btn secondary small" data-log-plan="whey">+</button>
          </div>
          <p class="muted small">${plan.whey.grams}g no total</p>
        </li>
        ${
          plan.hiper
            ? `
        <li class="plan-item">
          <div class="plan-item-head">
            <span><b>Hipercalórico</b> · completa a meta</span>
            <button type="button" class="btn secondary small" data-log-plan="hiper">+</button>
          </div>
          <p class="muted small">${plan.hiper.grams}g${plan.hiper.splitAdvised ? " — divida em 2 doses no dia" : ""}</p>
        </li>`
            : ""
        }
      </ul>
      <p class="muted small">+ Creatina 5g/dia junto de qualquer refeição.</p>
      <div class="macro-row">
        <span><b>${Math.round(plan.totals.kcal)}</b> / ${plan.targets.kcal} kcal</span>
        <span>P ${round1(plan.totals.p)}g / ${plan.targets.proteinG}g</span>
      </div>
    </section>
  `;
}

function renderAlimentacao() {
  const date = todayISO();
  const logs = logsForDate(date).sort((a, b) => a.time.localeCompare(b.time));
  const totals = dayTotals(date);
  const phase = currentPhase();
  const targets = calcTargets(STATE.profile, phase.goal);
  const plan = generateMealPlan();
  lastMealPlan = plan;

  return `
    <section class="card">
      <h2>Diário alimentar</h2>
      <p class="muted">${new Date().toLocaleDateString("pt-BR")}</p>
      ${
        targets.adapting
          ? `<p class="muted small coach-note">🌱 Modo adaptação ativo — hoje sua meta é ${targets.kcal} kcal, subindo aos poucos até ${targets.fullKcal} kcal.</p>`
          : ""
      }
      <div class="macro-row">
        <span><b>${Math.round(totals.kcal)}</b> / ${targets.kcal} kcal</span>
        <span>P ${round1(totals.p)}g</span>
        <span>C ${round1(totals.c)}g</span>
        <span>G ${round1(totals.g)}g</span>
      </div>
    </section>

    ${plan ? renderMealPlanCard(plan, phase) : ""}

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
        <select id="cf-group">
          <option value="carbo">Carboidrato</option>
          <option value="leguminosa">Feijão</option>
          <option value="proteina">Proteína</option>
          <option value="vegetal">Verdura/Legume</option>
          <option value="fruta">Fruta</option>
          <option value="laticinio">Laticínio</option>
          <option value="gordura">Gordura/Oleaginosa</option>
          <option value="suplemento">Suplemento</option>
        </select>
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
          ? `<ul class="meal-list">${logs.map((l) => renderMealLogItem(l)).join("")}</ul>`
          : `<p class="muted">Nenhuma refeição registrada ainda.</p>`
      }
    </section>
  `;
}

const PORTION_STEPS = [25, 50, 75, 100];

function renderMealLogItem(l) {
  const leftoverKcal = round1((l.fullKcal || l.kcal) - l.kcal);
  const showCoach = l.portionPct < 100 && !l.leftoverHandled && leftoverKcal > 20;
  return `
    <li class="meal-log-item">
      <div class="meal-log-row">
        <div>
          <b>${escapeHtml(l.mealSlot)}</b> · ${l.time}<br/>
          ${escapeHtml(l.name)} — ${l.grams}g
        </div>
        <div class="meal-kcal">
          ${Math.round(l.kcal)} kcal
          <button class="icon-btn" data-del-meal="${l.id}">✕</button>
        </div>
      </div>
      <div class="portion-row">
        <span class="muted small">Comi:</span>
        ${PORTION_STEPS.map(
          (pct) => `<button type="button" class="portion-btn ${l.portionPct === pct ? "active" : ""}" data-portion-id="${l.id}" data-portion-pct="${pct}">${pct}%</button>`
        ).join("")}
      </div>
      ${
        showCoach
          ? `
      <div class="coach-box">
        <p class="muted small">Tudo bem, sobraram ~${Math.round(leftoverKcal)} kcal dessa refeição. Quer:</p>
        <div class="coach-options">
          <button type="button" class="btn secondary small" data-compensate-leftover="${l.id}">🥤 Compensar com shake agora</button>
          <button type="button" class="btn secondary small" data-redistribute-leftover="${l.id}">↻ Redistribuir no resto do dia</button>
        </div>
        <button type="button" class="link-btn" data-dismiss-leftover="${l.id}">deixar assim</button>
      </div>`
          : ""
      }
    </li>`;
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
      <canvas id="chart-calories" width="600" height="220"></canvas>
      <div id="calories-legend" class="legend"></div>
    </section>
    <section class="card">
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
  const calCanvas = document.getElementById("chart-calories");
  const volCanvas = document.getElementById("chart-volume");
  const loadCanvas = document.getElementById("chart-load");
  if (calCanvas) drawCaloriesChart(calCanvas);
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

      <label>Horário do treino</label>
      <input type="time" id="pf-training-time" value="${p.trainingTime}" />

      <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
        <input type="checkbox" id="pf-fasted" ${p.fastedTraining ? "checked" : ""} style="width:auto;" />
        Treino em jejum (sem comer antes)
      </label>
      <p class="muted small">Treinar em jejum é seguro pra ganho de massa — o que mais importa é bater a caloria e a proteína do dia. Com essa opção, sua 1ª refeição na aba Dieta é agendada pra ~1h depois do treino, nos dias de treino.</p>

      <label style="display:flex; align-items:center; gap:8px; margin-top:14px;">
        <input type="checkbox" id="pf-adaptation" ${p.adaptationMode ? "checked" : ""} style="width:auto;" />
        Modo adaptação (subir a meta calórica aos poucos)
      </label>
      <select id="pf-adaptation-weeks">
        <option value="1" ${p.adaptationWeeks === 1 ? "selected" : ""}>Subir ao longo de 1 semana</option>
        <option value="2" ${p.adaptationWeeks === 2 ? "selected" : ""}>Subir ao longo de 2 semanas</option>
      </select>
      <p class="muted small">Pra quem tem dificuldade de comer o volume da meta cheia logo de cara: em vez de começar direto em ${targets.fullKcal} kcal, a meta começa ~15% abaixo e sobe aos poucos até a meta cheia. Dá tempo do estômago se acostumar sem forçar.${
        p.adaptationMode && p.adaptationStartDate
          ? ` Em andamento desde ${new Date(p.adaptationStartDate + "T00:00:00").toLocaleDateString("pt-BR")}.`
          : ""
      }</p>
      ${p.adaptationMode && p.adaptationStartDate ? `<button type="button" class="link-btn" id="btn-restart-adaptation">reiniciar do começo</button>` : ""}

      <button class="btn" id="btn-save-profile">Salvar perfil</button>
    </section>

    <section class="card highlight">
      <h3>Suas metas calculadas (fase atual: ${goalLabel(phase.goal)})</h3>
      <p>TDEE (gasto estimado): <b>${targets.tdee} kcal</b></p>
      <p>Meta calórica: <b>${targets.kcal} kcal/dia</b>${targets.adapting ? ` <span class="muted small">(subindo até ${targets.fullKcal} kcal)</span>` : ""}</p>
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

// Registra uma refeição já comida a 100% — os campos full* guardam a
// quantidade original servida, pra permitir marcar depois "comi só metade"
// sem perder a referência do que foi oferecido.
function pushMealLog({ mealSlot, name, grams, macros }) {
  STATE.mealLogs.push({
    id: uid(),
    date: todayISO(),
    time: new Date().toTimeString().slice(0, 5),
    mealSlot,
    name,
    grams,
    kcal: macros.kcal,
    p: macros.p,
    c: macros.c,
    g: macros.g,
    fullGrams: grams,
    fullKcal: macros.kcal,
    fullP: macros.p,
    fullC: macros.c,
    fullG: macros.g,
    portionPct: 100,
    leftoverHandled: false,
  });
}

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
    pushMealLog({ mealSlot, name: selectedFood.name, grams, macros });
    persist();
    selectedFood = null;
    render();
  });

  const addCustomBtn = document.getElementById("btn-add-custom-food");
  addCustomBtn.addEventListener("click", () => {
    const name = document.getElementById("cf-name").value.trim();
    const group = document.getElementById("cf-group").value;
    const kcal = Number(document.getElementById("cf-kcal").value);
    const p = Number(document.getElementById("cf-p").value) || 0;
    const c = Number(document.getElementById("cf-c").value) || 0;
    const g = Number(document.getElementById("cf-g").value) || 0;
    if (!name || !kcal) return;
    STATE.customFoods.push({ name, kcal, p, c, g, group });
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

  document.querySelectorAll("[data-log-plan]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!lastMealPlan) return;
      const key = btn.dataset.logPlan;
      let mealSlot, name, grams, macros;
      if (key === "whey") {
        mealSlot = "Suplemento";
        name = `${lastMealPlan.whey.name} — ${lastMealPlan.whey.grams}g`;
        grams = lastMealPlan.whey.grams;
        macros = lastMealPlan.whey.macros;
      } else if (key === "hiper") {
        if (!lastMealPlan.hiper) return;
        mealSlot = "Suplemento";
        name = `${lastMealPlan.hiper.name} — ${lastMealPlan.hiper.grams}g`;
        grams = lastMealPlan.hiper.grams;
        macros = lastMealPlan.hiper.macros;
      } else {
        const slot = lastMealPlan.slots[Number(key)];
        if (!slot) return;
        if (slot.mode === "shake") {
          if (!slot.shake.items.length) return;
          mealSlot = slot.label;
          name = slot.shake.items.map((it) => `${it.name} ${it.grams}g`).join(" + ");
          grams = slot.shake.items.reduce((s, it) => s + it.grams, 0);
          macros = slot.macros;
        } else {
          const items = FOOD_CATEGORIES.map((cat) => slot.items[cat.key]).filter((it) => it.food);
          if (!items.length) return;
          mealSlot = slot.label;
          name = items.map((it) => `${it.name} ${it.grams}g`).join(" + ");
          grams = items.reduce((s, it) => s + it.grams, 0);
          macros = slot.macros;
        }
      }
      pushMealLog({ mealSlot, name, grams, macros });
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-plan-food]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const [slotIdx, component] = sel.dataset.planFood.split("-");
      planFoodChoices[slotIdx] = { ...planFoodChoices[slotIdx], [component]: sel.value };
      render();
    });
  });

  document.querySelectorAll("[data-adjust-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.adjustToggle;
      expandedAdjust[idx] = !expandedAdjust[idx];
      render();
    });
  });

  document.querySelectorAll("[data-slot-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [idx, mode] = btn.dataset.slotMode.split("-");
      if (mode === "normal") delete planSlotMode[idx];
      else planSlotMode[idx] = mode;
      expandedAdjust[idx] = false;
      render();
    });
  });

  document.querySelectorAll("[data-portion-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const log = STATE.mealLogs.find((l) => l.id === btn.dataset.portionId);
      if (!log) return;
      const pct = Number(btn.dataset.portionPct);
      const ratio = pct / 100;
      log.portionPct = pct;
      log.grams = round1(log.fullGrams * ratio);
      log.kcal = round1(log.fullKcal * ratio);
      log.p = round1(log.fullP * ratio);
      log.c = round1(log.fullC * ratio);
      log.g = round1(log.fullG * ratio);
      if (pct === 100) log.leftoverHandled = false;
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-compensate-leftover]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const log = STATE.mealLogs.find((l) => l.id === btn.dataset.compensateLeftover);
      if (!log) return;
      const leftoverKcal = round1(log.fullKcal - log.kcal);
      if (leftoverKcal > 0) {
        const shake = computeShakeForKcal(leftoverKcal);
        const name = shake.items.map((it) => `${it.name} ${it.grams}g`).join(" + ");
        const grams = shake.items.reduce((s, it) => s + it.grams, 0);
        pushMealLog({ mealSlot: "Shake (compensação)", name, grams, macros: shake.macros });
      }
      log.leftoverHandled = true;
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-redistribute-leftover]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const log = STATE.mealLogs.find((l) => l.id === btn.dataset.redistributeLeftover);
      if (!log) return;
      const leftoverKcal = round1(log.fullKcal - log.kcal);
      if (leftoverKcal > 0) addDietAdjustKcal(leftoverKcal);
      log.leftoverHandled = true;
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-dismiss-leftover]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const log = STATE.mealLogs.find((l) => l.id === btn.dataset.dismissLeftover);
      if (!log) return;
      log.leftoverHandled = true;
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
    const adaptationMode = document.getElementById("pf-adaptation").checked;
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
      trainingTime: document.getElementById("pf-training-time").value || STATE.profile.trainingTime,
      fastedTraining: document.getElementById("pf-fasted").checked,
      adaptationMode,
      adaptationWeeks: Number(document.getElementById("pf-adaptation-weeks").value) || STATE.profile.adaptationWeeks,
      adaptationStartDate: adaptationMode ? STATE.profile.adaptationStartDate || todayISO() : STATE.profile.adaptationStartDate,
    };
    persist();
    scheduleNextMealNotification();
    render();
    alert("Perfil salvo!");
  });

  const restartBtn = document.getElementById("btn-restart-adaptation");
  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      STATE.profile.adaptationStartDate = todayISO();
      persist();
      render();
    });
  }

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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW falhou", e));
  });
}

if ("Notification" in window && Notification.permission === "granted") {
  scheduleNextMealNotification();
}

render();
