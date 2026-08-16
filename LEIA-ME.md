# Meu Treino & Dieta — App (PWA)

Este é um app web que você instala direto no seu iPhone sem passar pela App Store.
Não usa nenhum servidor: todos os seus dados (perfil, refeições, treinos) ficam
salvos só no seu celular (no navegador).

## Passo 1 — Colocar o app "no ar" (hospedar)

O iPhone só instala apps web (PWA) que estejam em um endereço `https://`. Escolha
uma opção (as duas são gratuitas):

### Opção A — GitHub Pages (recomendado, gratuito e permanente)
1. Crie uma conta em https://github.com (se ainda não tiver).
2. Crie um novo repositório (ex: `meu-treino-app`), público.
3. Faça upload de TODOS os arquivos desta pasta (index.html, app.js, foods.js,
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

## Sobre lembretes de refeição

O app calcula os horários das refeições a cada 3 horas a partir do horário
que você acorda (editável em Perfil). Ele tenta mandar notificação enquanto
está aberto/em segundo plano recente. Notificações confiáveis mesmo com o
app fechado no iPhone exigiriam um servidor de "push" — se você quiser isso
no futuro, dá pra evoluir o app com um backend simples.

## Resumo do que o app faz

- **Início**: próxima refeição, resumo de calorias do dia, treino de hoje.
- **Dieta**: registra o que você comeu (busca por alimento + gramas, calcula
  calorias/macros automaticamente), com banco de +50 alimentos comuns e opção
  de cadastrar alimentos personalizados.
- **Treino**: fases de treino (ex: 3 meses focado em peito/superior, depois
  outra fase focada em outro grupo), com treino de segunda a sexta focado no
  grupo escolhido + treino de corpo inteiro no sábado + corrida automática
  nas fases de definição. Você registra séries, repetições e carga de cada
  treino.
- **Progresso**: gráficos de calorias consumidas vs. meta e volume de treino
  nos últimos 7 dias.
- **Perfil**: seus dados (peso, altura, idade, sexo, atividade) calculam
  automaticamente sua meta calórica e de macros (proteína/carbo/gordura),
  ajustada conforme o objetivo da fase (ganho de massa ou definição).

## Editar depois

Todo o código está em `app.js` (lógica), `index.html` (visual) e `foods.js`
(banco de alimentos). Pode me pedir para ajustar qualquer parte — exercícios,
alimentos, cores, cálculo de calorias, etc.
