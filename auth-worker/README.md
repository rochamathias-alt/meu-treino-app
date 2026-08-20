# auth-worker

Backend mínimo (Cloudflare Worker + D1) que dá conta de usuário ao app: cria
login (e-mail + senha), guarda a senha com hash (nunca em texto puro) e
sincroniza o estado do app (perfil, fases, treinos registrados) entre
aparelhos, por usuário.

## Deploy (primeira vez)

```
cd auth-worker
npm install
npx wrangler login
npx wrangler d1 create treino-auth-db
```

O comando acima imprime um `database_id` — cole ele em `wrangler.toml` no
lugar de `COLE_AQUI_O_DATABASE_ID`. Depois crie as tabelas e gere o segredo
usado para assinar os tokens de login:

```
npm run db:init
npx wrangler secret put JWT_SECRET
```

(Para `JWT_SECRET`, cole qualquer string longa e aleatória — ex: gerada com
`npx wrangler secret put JWT_SECRET` e colando o resultado de
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.)

Por fim:

```
npx wrangler deploy
```

Isso imprime a URL do worker (algo como
`https://meu-treino-auth.SEU-USUARIO.workers.dev`). Cole essa URL na
constante `AUTH_API_BASE` em `app.js`.

## Redeploy (depois de mexer no código)

```
cd auth-worker
npx wrangler deploy
```

## Rotas

- `POST /api/register` — `{ email, password }` → cria a conta e devolve
  `{ token, userId, email }`.
- `POST /api/login` — `{ email, password }` → devolve `{ token, userId, email }`.
- `GET /api/state` — (com `Authorization: Bearer <token>`) devolve
  `{ state, updatedAt }` com o último estado salvo desse usuário.
- `PUT /api/state` — (com `Authorization: Bearer <token>`) `{ state }` →
  salva o estado e devolve `{ updatedAt }`.

## Como funciona

- Senha: guardada como hash PBKDF2-SHA256 (100.000 iterações) com salt
  aleatório por usuário — nunca em texto puro.
- Sessão: sem estado no servidor. O login devolve um token assinado
  (HMAC-SHA256, formato parecido com JWT) válido por 90 dias; o app manda
  esse token em cada chamada e o worker só confere a assinatura.
- Dados: o app inteiro (perfil, fases, treinos) é salvo como um único JSON
  por usuário na tabela `user_state` — mesmo formato que já era salvo no
  localStorage, só que agora também no servidor.
