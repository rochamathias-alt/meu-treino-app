# push-worker

Backend mínimo (Cloudflare Worker) que dispara o lembrete de refeição como
push de verdade, mesmo com o app fechado no iPhone. Guarda a inscrição de
push + os horários de um único usuário no KV e roda um cron a cada minuto
pra checar se é hora de notificar.

Já está publicado em: https://meu-treino-push.rochamathias.workers.dev

## Redeploy (depois de mexer no código)

```
cd push-worker
npm install
npx wrangler deploy
```

Precisa estar logado (`npx wrangler login`) ou ter `CLOUDFLARE_API_TOKEN`
no ambiente (token criado em dash.cloudflare.com/profile/api-tokens, template
"Edit Cloudflare Workers", com "Zone Resources" em "All zones").

## Secrets (já configurados, só documentando)

- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: par de chaves do Web Push,
  gerado com `npx web-push generate-vapid-keys`. A pública também está
  hardcoded em `app.js` (`PUSH_VAPID_PUBLIC_KEY`) — é pública mesmo, tudo bem
  estar no código do cliente.
- `VAPID_SUBJECT`: `mailto:rochamathias@gmail.com` (exigido pelo protocolo
  Web Push, não é usado pra nada além de identificação).
- `AUTH_TOKEN`: token simples pra proteger o endpoint `/subscribe` (também
  hardcoded em `app.js` como `PUSH_AUTH_TOKEN`). Não é segurança forte — só
  evita que estranhos que acharem a URL do worker sobrescrevam sua inscrição.
  Suficiente pra um app pessoal sem dado sensível em jogo.

Pra recriar os secrets: `npx wrangler secret put NOME_DO_SECRET`.

## KV namespace

Um namespace `REMINDERS` guarda duas chaves:
- `reminder-config`: JSON com a inscrição de push + horários (wakeTime,
  mealIntervalHours, sleepWindowHours, trainingTime, fastedTraining,
  trainingDays, timezone). Reenviado pelo app sempre que o perfil ou os dias
  de treino mudam (função `syncPushConfig()` em app.js).
- `last-sent`: dedupe pra não mandar a mesma refeição duas vezes no mesmo
  minuto.

Se precisar recriar o namespace: `npx wrangler kv namespace create REMINDERS`
e colar o id novo em `wrangler.toml`.
