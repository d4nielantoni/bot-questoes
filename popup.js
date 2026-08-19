// O Firefox expõe `browser`, o Chrome expõe `chrome`. Ambos devolvem promessas
// (o Chrome desde o Manifest V3), então um único nome atende aos dois sem
// ramificar o código por navegador. Detecta a API, não o nome do navegador.
const api = globalThis.browser ?? globalThis.chrome;

const input = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const revealBtn = document.getElementById('revealBtn');
const keyStatus = document.getElementById('keyStatus');
const solveBtn = document.getElementById('solveBtn');
const solveStatus = document.getElementById('solveStatus');
const keyState = document.getElementById('keystate');

let keyStatusTimer = null;

// ─── Estado ──────────────────────────────────────────────────────────────────

function markSaved(saved) {
  keyState.dataset.saved = String(saved);
  keyState.textContent = saved ? 'Chave salva' : 'Sem chave';
}

function syncSaveButton() {
  saveBtn.disabled = input.value.trim() === '';
}

// A versão anterior escondia o aviso com display:none embutido, que vencia a
// regra do CSS e fazia o segundo aviso nunca mais aparecer. Agora o estado vive
// num atributo e o esvaziamento do texto é o que esconde.
function flashStatus(message, kind) {
  clearTimeout(keyStatusTimer);
  keyStatus.textContent = message;
  keyStatus.dataset.kind = kind;
  keyStatusTimer = setTimeout(() => { keyStatus.textContent = ''; }, 3200);
}

// ─── Início ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    const { geminiApiKey } = await api.storage.local.get('geminiApiKey');
    if (geminiApiKey) {
      input.value = geminiApiKey;
      markSaved(true);
    }
  } catch (err) {
    flashStatus(`Não foi possível ler a chave: ${err.message}`, 'error');
  }
  syncSaveButton();
})();

// ─── Interação ───────────────────────────────────────────────────────────────

input.addEventListener('input', syncSaveButton);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !saveBtn.disabled) saveBtn.click();
});

revealBtn.addEventListener('click', () => {
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  revealBtn.textContent = hidden ? 'Ocultar' : 'Mostrar';
});

saveBtn.addEventListener('click', async () => {
  const key = input.value.trim();
  if (!key) return;

  saveBtn.dataset.busy = 'true';
  try {
    await api.storage.local.set({ geminiApiKey: key });
    markSaved(true);
    flashStatus('Chave salva.', 'success');
  } catch (err) {
    flashStatus(err.message, 'error');
  } finally {
    delete saveBtn.dataset.busy;
  }
});

// ─── Resolver ────────────────────────────────────────────────────────────────

// O andamento chega da página enquanto o popup estiver aberto.
api.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'BOT_STATUS') return;
  solveStatus.textContent = msg.text;
  solveStatus.dataset.kind = msg.tone || 'busy';
});

function describe({ applied = 0, total = 0, seconds = 0, error }) {
  if (error) return [`${applied}/${total} — ${error}`, 'error'];
  if (total === 0) return ['Nada pendente nesta página.', 'success'];
  return [`${applied} de ${total} em ${seconds}s.`, 'success'];
}

solveBtn.addEventListener('click', async () => {
  solveBtn.dataset.busy = 'true';
  solveStatus.textContent = 'Resolvendo...';
  solveStatus.dataset.kind = 'busy';

  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('Nenhuma aba ativa.');

    const result = await api.tabs.sendMessage(tab.id, { type: 'BOT_SOLVE' });
    if (!result) throw new Error('Sem resposta da página.');

    const [text, kind] = describe(result);
    solveStatus.textContent = text;
    solveStatus.dataset.kind = kind;
  } catch (err) {
    // Sem o content script na página, o navegador devolve um erro de conexão
    // que não diz nada ao usuário — vale traduzir para a ação real.
    const semConexao = /Receiving end does not exist|Could not establish connection|message port closed/i.test(err.message);
    solveStatus.textContent = semConexao
      ? 'Abra a página do exercício e recarregue (F5).'
      : err.message;
    solveStatus.dataset.kind = 'error';
  } finally {
    delete solveBtn.dataset.busy;
  }
});
