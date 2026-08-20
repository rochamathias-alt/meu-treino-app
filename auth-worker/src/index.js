// Backend mínimo (Cloudflare Worker + D1) para conta de usuário do app de
// treino: cadastro/login por e-mail+senha e guarda/recupera o "estado" do
// app (perfil, fases, treinos registrados) por usuário, pra sincronizar
// entre aparelhos. Sem sessões no servidor: o login devolve um token
// assinado (JWT simples, HMAC-SHA256) que o app guarda e reenvia em cada
// chamada.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 dias
const PBKDF2_ITERATIONS = 100000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function bytesToBase64Url(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  return new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
}

/* ---------------- Senha: PBKDF2-SHA256 com salt aleatório ---------------- */
async function hashPassword(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bytesToBase64Url(new Uint8Array(bits)), salt: bytesToBase64Url(salt) };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, storedHash, storedSaltB64) {
  const { hash } = await hashPassword(password, base64UrlToBytes(storedSaltB64));
  return timingSafeEqual(hash, storedHash);
}

/* ---------------- Token: JWT simples (HMAC-SHA256) ---------------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64 = bytesToBase64Url(new Uint8Array(sig));
  return `${data}.${sigB64}`;
}

async function verifyToken(token, secret) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, base64UrlToBytes(sigB64), new TextEncoder().encode(`${headerB64}.${payloadB64}`));
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function requireUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const payload = await verifyToken(token, env.JWT_SECRET);
  return payload ? payload.sub : null;
}

/* ---------------- Validação simples ---------------- */
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ---------------- Rotas ---------------- */
async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body && body.email);
  const password = String((body && body.password) || "");
  if (!isValidEmail(email)) return json({ error: "E-mail inválido." }, 400);
  if (password.length < 6) return json({ error: "Senha precisa ter ao menos 6 caracteres." }, 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return json({ error: "Já existe uma conta com esse e-mail." }, 409);

  const { hash, salt } = await hashPassword(password);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, hash, salt, now)
    .run();

  const token = await signToken({ sub: id, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }, env.JWT_SECRET);
  return json({ token, userId: id, email });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body && body.email);
  const password = String((body && body.password) || "");

  const user = await env.DB.prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?").bind(email).first();
  if (!user) return json({ error: "E-mail ou senha incorretos." }, 401);

  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) return json({ error: "E-mail ou senha incorretos." }, 401);

  const token = await signToken({ sub: user.id, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }, env.JWT_SECRET);
  return json({ token, userId: user.id, email });
}

async function handleGetState(request, env) {
  const userId = await requireUser(request, env);
  if (!userId) return json({ error: "Não autenticado." }, 401);

  const row = await env.DB.prepare("SELECT state_json, updated_at FROM user_state WHERE user_id = ?").bind(userId).first();
  if (!row) return json({ state: null, updatedAt: null });
  return json({ state: JSON.parse(row.state_json), updatedAt: row.updated_at });
}

async function handlePutState(request, env) {
  const userId = await requireUser(request, env);
  if (!userId) return json({ error: "Não autenticado." }, 401);

  const body = await request.json().catch(() => null);
  if (!body || typeof body.state !== "object") return json({ error: "Corpo inválido." }, 400);

  const updatedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO user_state (user_id, state_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
  )
    .bind(userId, JSON.stringify(body.state), updatedAt)
    .run();

  return json({ updatedAt });
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (url.pathname === "/health") return new Response("ok", { headers: CORS_HEADERS });

  try {
    if (url.pathname === "/api/register" && request.method === "POST") return await handleRegister(request, env);
    if (url.pathname === "/api/login" && request.method === "POST") return await handleLogin(request, env);
    if (url.pathname === "/api/state" && request.method === "GET") return await handleGetState(request, env);
    if (url.pathname === "/api/state" && request.method === "PUT") return await handlePutState(request, env);
  } catch (e) {
    return json({ error: "Erro interno." }, 500);
  }

  return json({ error: "Não encontrado." }, 404);
}

export default {
  fetch: (request, env) => handleFetch(request, env),
};
