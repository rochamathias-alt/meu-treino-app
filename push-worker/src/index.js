import { buildPushPayload } from "@block65/webcrypto-web-push";

// App de um usuário só: a inscrição de push + config de horários fica numa
// chave fixa no KV. "last-sent" evita mandar a mesma refeição duas vezes
// (o cron roda todo minuto).
const CONFIG_KEY = "reminder-config";
const LAST_SENT_KEY = "last-sent";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const WEEKDAY_MAP = {
  Sun: "domingo",
  Mon: "segunda",
  Tue: "terca",
  Wed: "quarta",
  Thu: "quinta",
  Fri: "sexta",
  Sat: "sabado",
};

// Mesma lógica de app.js:mealSlots(), reimplementada aqui porque o Worker
// não tem acesso ao STATE do app — a config (wakeTime, intervalo, etc.) vem
// do cliente via POST /subscribe e fica salva no KV.
function mealSlots(cfg, isTrainingDay) {
  const [h, m] = cfg.wakeTime.split(":").map(Number);
  const wakeMinutes = h * 60 + m;
  let startMinutes = wakeMinutes;

  if (isTrainingDay && cfg.fastedTraining && cfg.trainingTime) {
    const [th, tm] = cfg.trainingTime.split(":").map(Number);
    const postWorkoutMinutes = th * 60 + tm + 60;
    if (postWorkoutMinutes > startMinutes) startMinutes = postWorkoutMinutes;
  }

  const slots = [];
  let minutes = startMinutes;
  const endMinutes = wakeMinutes + cfg.sleepWindowHours * 60;
  let idx = 1;
  while (minutes <= endMinutes) {
    const hh = Math.floor((minutes / 60) % 24).toString().padStart(2, "0");
    const mm = (minutes % 60).toString().padStart(2, "0");
    slots.push({ label: `Refeição ${idx}`, time: `${hh}:${mm}` });
    minutes += cfg.mealIntervalHours * 60;
    idx += 1;
  }
  return slots;
}

function nowPartsInTZ(timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24; // "24:00" em algumas engines à meia-noite
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${String(hour).padStart(2, "0")}:${parts.minute}`,
    weekdayKey: WEEKDAY_MAP[parts.weekday],
  };
}

async function sendPush(env, subscription, notif) {
  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const message = { data: JSON.stringify(notif), options: { ttl: 3600, urgency: "high" } };
  const payload = await buildPushPayload(message, subscription, vapid);
  const res = await fetch(subscription.endpoint, payload);
  if (res.status === 404 || res.status === 410) {
    // Inscrição expirou (app desinstalado, permissão revogada, etc.)
    await env.REMINDERS.delete(CONFIG_KEY);
  }
  return res;
}

async function handleTick(env) {
  const raw = await env.REMINDERS.get(CONFIG_KEY);
  if (!raw) return;
  const cfg = JSON.parse(raw);
  if (!cfg.subscription) return;

  const { dateStr, hhmm, weekdayKey } = nowPartsInTZ(cfg.timezone || "America/Sao_Paulo");
  const isTrainingDay = (cfg.trainingDays || []).includes(weekdayKey);
  const match = mealSlots(cfg, isTrainingDay).find((s) => s.time === hhmm);
  if (!match) return;

  const dedupeKey = `${dateStr}|${hhmm}`;
  if ((await env.REMINDERS.get(LAST_SENT_KEY)) === dedupeKey) return;

  await sendPush(env, cfg.subscription, {
    title: "Hora de comer! 🍽️",
    body: `${match.label} às ${match.time}. Registre sua refeição no app.`,
  });
  await env.REMINDERS.put(LAST_SENT_KEY, dedupeKey);
}

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (url.pathname === "/health") return new Response("ok", { headers: CORS_HEADERS });

  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  if (url.pathname === "/subscribe" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !body.subscription || !body.subscription.endpoint) {
      return new Response("Bad request", { status: 400, headers: CORS_HEADERS });
    }
    await env.REMINDERS.put(CONFIG_KEY, JSON.stringify(body));
    return new Response("OK", { headers: CORS_HEADERS });
  }

  if (url.pathname === "/unsubscribe" && request.method === "POST") {
    await env.REMINDERS.delete(CONFIG_KEY);
    return new Response("OK", { headers: CORS_HEADERS });
  }

  return new Response("Not found", { status: 404, headers: CORS_HEADERS });
}

export default {
  fetch: (request, env) => handleFetch(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(handleTick(env)),
};
