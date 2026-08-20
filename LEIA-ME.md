# Meu Treino — App (PWA)

Este é um app web que você instala direto no seu iPhone sem passar pela App Store.
Agora tem login com e-mail e senha: seus dados (perfil, treinos) ficam
salvos numa conta e sincronizam entre aparelhos — veja o Passo 0 antes de
hospedar o app.

## Passo 0 — Publicar o backend de login (uma vez só)

O login usa um pequeno backend (Cloudflare Worker + banco de dados),
guardado na pasta `auth-worker/`. Siga `auth-worker/README.md` pra publicar
— ao final você recebe uma URL tipo
`https://meu-treino-auth.SEU-USUARIO.workers.dev`. Cole essa URL na
constante `AUTH_API_BASE`, no topo do arquivo `app.js`, antes de seguir pro
Passo 1.

## Passo 1 — Colocar o app "no ar" (hospedar)

O iPhone só instala apps web (PWA) que estejam em um endereço `https://`. Escolha
uma opção (as duas são gratuitas):

### Opção A — GitHub Pages (recomendado, gratuito e permanente)
1. Crie uma conta em https://github.com (se ainda não tiver).
2. Crie um novo repositório (ex: `meu-treino-app`), público.
3. Faça upload de TODOS os arquivos desta pasta (index.html, app.js,
   manifest.json, service-worker.js e a pasta icons/) para esse repositório
   (pelo site do GitHub: "Add file" → "Upload files").
4. Vá em Settings → Pages → Source → selecione a branch `main` e pasta `/root`.
   Salve.
5. Em ~1 minuto, o GitHub te dá um link tipo:
   `https://SEU-USUARIO.github.io/meu-treino-app/`

### Opção B — Netlify (drag-and-drop, rápido)
1. Acesse https://app.netlify.com e crie uma conta gratuita.
2. Depois de logar, arraste esta pasta inteira para a área de deploy.
3. Você recebe um link `https://algum-nome.netlify.app` na hora.

## Passo 2 — Instalar no iPhone (sem App Store)

1. Abra o link (do Passo 1) no **Safari** do iPhone (tem que ser o Safari, não
   funciona pelo Chrome no iOS).
2. Toque no ícone de compartilhar (quadrado com seta para cima).
3. Toque em **"Adicionar à Tela de Início"**.
4. Pronto! Um ícone do app aparece na tela inicial, abre em tela cheia, como
   um app normal — e não veio da App Store.

## Resumo do que o app faz

- **Login**: cria conta com e-mail e senha (ou entra numa já existente) antes
  de usar o app. Os dados ficam salvos numa conta e sincronizam sozinhos
  entre aparelhos — ainda funciona offline, salvando local e enviando pro
  servidor quando a internet voltar.
- **Início**: saudação e treino de hoje.
- **Treino**: fases de treino (ex: 3 meses focado em peito/superior, depois
  outra fase focada em outro grupo), com treino de segunda a sexta focado no
  grupo escolhido + treino de corpo inteiro no sábado + corrida automática
  nas fases de definição. Você registra séries, repetições e carga de cada
  treino.
- **Progresso**: gráficos de volume de treino e evolução de carga por
  exercício nos últimos 7 dias.
- **Perfil**: seu nome e backup/reset dos dados salvos.

## Editar depois

Todo o código está em `app.js` (lógica) e `index.html` (visual). Pode me
pedir para ajustar qualquer parte — exercícios, cores, etc.
