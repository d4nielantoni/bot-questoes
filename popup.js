// O Firefox expõe `browser`, o Chrome expõe `chrome`. Ambos devolvem promessas
// (o Chrome desde o Manifest V3), então um único nome atende aos dois sem
// ramificar o código por navegador. Detecta a API, não o nome do navegador.
const api = globalThis.browser ?? globalThis.chrome;

const input = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const revealBtn = document.getElementById('revealBtn');
const keyStatus = document.getElementById('keyStatus');
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
