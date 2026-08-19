(() => {
  'use strict';

  // O Firefox expõe `browser`, o Chrome expõe `chrome`. Ambos devolvem promessas
  // (o Chrome desde o Manifest V3), então um único nome atende aos dois sem
  // ramificar o código por navegador. Detecta a API, não o nome do navegador.
  const api = globalThis.browser ?? globalThis.chrome;

  if (document.getElementById('bot-questoes-btn')) return;

  const MODEL = 'gemini-3.5-flash-lite';
  // Gemini 3.x trocou thinkingBudget por thinkingLevel. 'minimal' é o indicado
  // pela documentação para tarefas de extração/classificação, que é o caso aqui.
  const THINKING_LEVEL = 'minimal';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const CLICK_DELAY_MS = 50;   // só para a página acompanhar os cliques
  const RETRY_DELAY_MS = 400;  // entre as repescas individuais

  const DEFAULT_LABEL = 'Resolver quiz';

  // Mesma paleta do popup. A cor do botão é o próprio indicador de estado,
  // por isso cada tom tem um significado.
  const TONE = {
    idle:  { bg: 'oklch(0.16 0.008 145)', fg: 'oklch(0.85 0.185 128)' },
    busy:  { bg: 'oklch(0.16 0.008 145)', fg: 'oklch(0.75 0.012 145)' },
    ok:    { bg: 'oklch(0.85 0.185 128)', fg: 'oklch(0.18 0.040 128)' },
    error: { bg: 'oklch(0.27 0.070 25)',  fg: 'oklch(0.83 0.130 25)'  },
  };

  // ─── Botão flutuante ────────────────────────────────────────────────────────

  // Fica por cima do conteúdo de estudo, então descansa apagado e só ganha
  // presença quando o ponteiro chega perto.
  const IDLE_OPACITY = 0.65;

  const btn = document.createElement('button');
  btn.id = 'bot-questoes-btn';
  btn.type = 'button';
  btn.textContent = DEFAULT_LABEL;
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '2147483647',
    padding: '7px 13px',
    background: TONE.idle.bg,
    color: TONE.idle.fg,
    border: 'none',
    borderRadius: '999px',
    fontSize: '12px',
    fontWeight: '600',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    letterSpacing: '-0.005em',
    lineHeight: '1.4',
    cursor: 'pointer',
    opacity: String(IDLE_OPACITY),
    boxShadow: '0 1px 4px oklch(0 0 0 / 0.25)',
    transition: 'opacity 150ms cubic-bezier(0.22,1,0.36,1), background 150ms, color 150ms',
    userSelect: 'none',
    maxWidth: '86vw',
    textAlign: 'left',
  });

  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (REDUCED_MOTION) btn.style.transition = 'none';

  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = String(IDLE_OPACITY); });
  btn.addEventListener('focus', () => {
    btn.style.opacity = '1';
    btn.style.outline = `2px solid ${TONE.idle.fg}`;
    btn.style.outlineOffset = '2px';
  });
  btn.addEventListener('blur', () => {
    btn.style.opacity = String(IDLE_OPACITY);
    btn.style.outline = 'none';
  });

  btn.addEventListener('click', startSolver);
  document.body.appendChild(btn);

  function report(text, tone = 'busy') {
    btn.textContent = text;
    btn.style.background = TONE[tone].bg;
    btn.style.color = TONE[tone].fg;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function simulateClick(alternativeBtn) {
    const target = alternativeBtn.querySelector('[data-testid^="alt-"]') || alternativeBtn;
    const pointerOpts = { bubbles: true, cancelable: true, view: window, pointerId: 1, pointerType: 'mouse' };
    const mouseOpts   = { bubbles: true, cancelable: true, view: window };
    target.dispatchEvent(new PointerEvent('pointerover',  pointerOpts));
    target.dispatchEvent(new PointerEvent('pointerenter', { ...pointerOpts, bubbles: false }));
    target.dispatchEvent(new PointerEvent('pointerdown',  pointerOpts));
    target.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    target.dispatchEvent(new PointerEvent('pointerup',    pointerOpts));
    target.dispatchEvent(new MouseEvent('mouseup',   mouseOpts));
    target.dispatchEvent(new MouseEvent('click',     mouseOpts));
  }

  function extractQuestionText(questionEl) {
    const allTypographies = questionEl.querySelectorAll('[data-testid="question-typography"]');
    for (const el of allTypographies) {
      if (!el.closest('button')) return el.innerText.trim();
    }
    const clone = questionEl.cloneNode(true);
    clone.querySelectorAll('button').forEach((el) => el.remove());
    return clone.innerText.trim();
  }

  function getAlternativeButtons(questionEl) {
    return Array.from(questionEl.querySelectorAll('button[data-testid^="alternative-"]'));
  }

  function isAlreadyAnswered(buttons) {
    return buttons.some((b) => {
      const color = b.getAttribute('color');
      return color && color !== 'white';
    });
  }

  function letterList(count) {
    return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i));
  }

  function letterToIndex(raw, count) {
    const letter = String(raw ?? '').trim().toUpperCase().match(/[A-Z]/)?.[0];
    if (!letter) return -1;
    const index = letter.charCodeAt(0) - 65;
    return index >= 0 && index < count ? index : -1;
  }

  // ─── Gemini API ─────────────────────────────────────────────────────────────

  const ANSWER_SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        q: { type: 'INTEGER' },
        a: { type: 'STRING' },
      },
      required: ['q', 'a'],
    },
  };

  // O raciocínio é a maior fatia do tempo de cada chamada, por isso fica no
  // mínimo. Ele ainda consome maxOutputTokens, então o teto é folgado de
  // propósito: apertá-lo trunca a resposta e derruba a chamada inteira.
  function buildRequest(prompt, maxOutputTokens, schema) {
    // Gemini 3.x removeu temperature/top_p; enviá-los devolve 400.
    const generationConfig = {
      maxOutputTokens,
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
    };

    if (schema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = schema;
    }

    return { contents: [{ parts: [{ text: prompt }] }], generationConfig };
  }

  async function callGemini(apiKey, payload, retries = 2) {
    // Sem codificar, um '+' na chave chega ao servidor como espaço e uma chave
    // válida é recusada com "API key not valid".
    const response = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 429 || response.status === 503) {
      if (retries <= 0) throw new Error(`Limite de requisições persistente (${response.status}).`);
      let wait = response.status === 503 ? 5000 : 30000;
      try {
        const errData = await response.clone().json();
        const retryDelay = errData?.error?.details?.find((d) => d.retryDelay)?.retryDelay;
        if (retryDelay) wait = (parseInt(retryDelay, 10) + 1) * 1000;
      } catch (_) {}
      console.warn(`[Bot Questões] ${response.status} — aguardando ${wait / 1000}s... (${retries} restantes)`);
      report(`Limite atingido — aguardando ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      return callGemini(apiKey, payload, retries - 1);
    }

    // Se algum parâmetro da configuração não for aceito por este modelo,
    // reenvia sem ele em vez de derrubar a execução inteira.
    if (response.status === 400 && payload.generationConfig.thinkingConfig) {
      const body = await response.text();
      if (/thinking|temperature|top_p|topP/i.test(body)) {
        console.warn('[Bot Questões] Config rejeitada pelo modelo — repetindo sem ela:', body.slice(0, 160));
        const { thinkingConfig: _drop, ...rest } = payload.generationConfig;
        return callGemini(apiKey, { ...payload, generationConfig: rest }, retries);
      }
      throw new Error(`Gemini 400: ${body.slice(0, 200)}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      console.warn('[Bot Questões] Resposta truncada por maxOutputTokens.');
    }
    return candidate?.content?.parts?.[0]?.text ?? '';
  }

  function buildBatchPrompt(items) {
    const blocks = items.map((item, i) => {
      const alts = item.alternatives
        .map((text, j) => `${String.fromCharCode(65 + j)}) ${text}`)
        .join('\n');
      return `[Questão ${i + 1}]\n${item.text}\n${alts}`;
    });

    return (
      `Responda às ${items.length} questões de múltipla escolha abaixo.\n\n` +
      `${blocks.join('\n\n')}\n\n` +
      `Devolva um array JSON com um objeto por questão, onde "q" é o número da ` +
      `questão e "a" é a letra da alternativa correta. ` +
      `Inclua todas as ${items.length} questões, na ordem.`
    );
  }

  // Uma única chamada para o quiz inteiro. Devolve um Map posição -> índice da
  // alternativa, contendo apenas o que veio válido — o que faltar é repescado
  // individualmente por quem chamou.
  async function askGeminiBatch(apiKey, items) {
    const raw = await callGemini(
      apiKey,
      buildRequest(buildBatchPrompt(items), 512 + items.length * 32, ANSWER_SCHEMA),
    );

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      const bare = raw.replace(/^[^[]*/, '').replace(/[^\]]*$/, '');
      try {
        parsed = JSON.parse(bare);
      } catch (_) {
        throw new Error(`Resposta em lote ilegível: "${raw.trim().slice(0, 120)}"`);
      }
    }
    if (!Array.isArray(parsed)) throw new Error('Resposta em lote não veio como lista.');

    const answers = new Map();
    for (const entry of parsed) {
      const position = Number(entry?.q) - 1;
      const item = items[position];
      if (!item) continue;
      const index = letterToIndex(entry?.a, item.alternatives.length);
      if (index >= 0) answers.set(position, index);
    }

    console.log(`[Bot Questões] Lote → ${answers.size}/${items.length} respostas válidas.`);
    return answers;
  }

  async function askGeminiSingle(apiKey, item) {
    const letters = letterList(item.alternatives.length);
    const alts = item.alternatives.map((text, j) => `${letters[j]}) ${text}`).join('\n');
    const prompt =
      `Pergunta:\n${item.text}\n\nAlternativas:\n${alts}\n\n` +
      `Responda SOMENTE com a letra correta (${letters.join(', ')}).`;

    const raw = await callGemini(apiKey, buildRequest(prompt, 256, null));
    const index = letterToIndex(raw, item.alternatives.length);
    if (index < 0) throw new Error(`Resposta inválida: "${raw.trim()}"`);
    return index;
  }

  // ─── DOM → questões pendentes ───────────────────────────────────────────────

  function collectPendingQuestions(container) {
    const questionEls = Array.from(container.querySelectorAll('[data-testid^="question-"]'))
      .filter((el) => /^question-\d+$/.test(el.getAttribute('data-testid')));

    const items = [];
    questionEls.forEach((questionEl, i) => {
      const buttons = getAlternativeButtons(questionEl);
      if (buttons.length === 0) {
        console.warn(`[Bot Questões] Q${i + 1} sem alternativas.`);
        return;
      }
      if (isAlreadyAnswered(buttons)) {
        console.log(`[Bot Questões] Q${i + 1} já respondida.`);
        return;
      }

      items.push({
        label: `Q${i + 1}`,
        buttons,
        text: extractQuestionText(questionEl),
        alternatives: buttons.map((b) => {
          const inner = b.querySelector('[data-testid="question-typography"]');
          return (inner || b).innerText.trim();
        }),
      });
    });

    return items;
  }

  // ─── Execução ───────────────────────────────────────────────────────────────

  async function solve() {
    const started = performance.now();
    let lastError = null;

    const { geminiApiKey } = await api.storage.local.get('geminiApiKey');
    if (!geminiApiKey) return { error: 'Nenhuma chave salva.' };

    console.log(`[Bot Questões] chave: ${geminiApiKey.length} caracteres, começa com "${geminiApiKey.slice(0, 4)}"`);

    const container = document.querySelector('[data-testid="questions-template"]');
    if (!container) return { error: 'Nenhum quiz encontrado nesta página.' };

    report('Lendo questões...');
    const items = collectPendingQuestions(container);
    if (items.length === 0) return { applied: 0, total: 0, seconds: 0 };

    // 1. uma única chamada com o quiz inteiro
    report(`Resolvendo ${items.length} questões...`);
    let answers = new Map();
    try {
      answers = await askGeminiBatch(geminiApiKey, items);
    } catch (err) {
      lastError = err.message;
      console.error('[Bot Questões] Lote falhou:', err.message);
    }

    // 2. repesca individual só do que faltou
    const missing = items.map((_, i) => i).filter((i) => !answers.has(i));
    for (let n = 0; n < missing.length; n++) {
      const position = missing[n];
      report(`Repescando ${n + 1} de ${missing.length}...`);
      try {
        answers.set(position, await askGeminiSingle(geminiApiKey, items[position]));
      } catch (err) {
        if (!lastError) lastError = err.message;
        console.error(`[Bot Questões] ${items[position].label} erro:`, err.message);
      }
      if (n < missing.length - 1) await sleep(RETRY_DELAY_MS);
    }

    // 3. aplica os cliques
    report('Marcando respostas...');
    const ordered = [...answers.entries()].sort((a, b) => a[0] - b[0]);
    for (const [position, index] of ordered) {
      simulateClick(items[position].buttons[index]);
      await sleep(CLICK_DELAY_MS);
    }

    const seconds = Number(((performance.now() - started) / 1000).toFixed(1));
    console.log(`[Bot Questões] ✓ ${ordered.length}/${items.length} em ${seconds}s.`);

    return {
      applied: ordered.length,
      total: items.length,
      seconds,
      error: ordered.length < items.length ? lastError : null,
    };
  }

  // ─── Disparo pelo botão ─────────────────────────────────────────────────────

  async function startSolver() {
    if (btn.disabled) return;
    btn.disabled = true;

    let result;
    try {
      result = await solve();
    } catch (err) {
      console.error('[Bot Questões] Erro geral:', err);
      result = { error: err.message };
    }

    const { applied = 0, total = 0, seconds = 0, error } = result;

    if (error) {
      // A causa fica visível na tela: o console provou ser difícil de alcançar.
      btn.title = error;
      report(`${applied}/${total} — ${error.slice(0, 60)}`, 'error');
    } else if (total === 0) {
      report('Tudo já respondido', 'ok');
    } else {
      report(`${applied} de ${total} em ${seconds}s`, 'ok');
    }

    // Em caso de erro a mensagem fica na tela até o próximo clique.
    if (!error) {
      await sleep(2500);
      btn.title = '';
      report(DEFAULT_LABEL, 'idle');
    }

    btn.disabled = false;
  }
})();
