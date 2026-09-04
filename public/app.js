/* Lara - Prospecções — front-end */
'use strict';
const $ = (id) => document.getElementById(id);
const api = (p, opts) => fetch(p, opts).then(r => r.json());

// ---------- mapa ----------
const map = L.map('map', { zoomControl: true }).setView([-23.55, -46.63], 11);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 19,
}).addTo(map);

let heat = L.heatLayer([], { radius: 32, blur: 22, maxZoom: 14,
  gradient: { 0.2: '#0d5c43', 0.5: '#28d192', 0.8: '#f2b34b', 1.0: '#ef6b6b' } }).addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const cityMarkers = L.layerGroup().addTo(map);

// ---------- busca de cidades (multi-seleção) ----------
let selectedCities = [];
let cityTimer = null;
$('cityInput').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(cityTimer);
  if (q.length < 3) { $('citySug').innerHTML = ''; return; }
  $('citySug').innerHTML = '<div class="loading">buscando…</div>';
  cityTimer = setTimeout(() => fetchCities(q), 450);
});
async function fetchCities(q) {
  try {
    const r = await api('/api/cities?q=' + encodeURIComponent(q));
    const list = r.results || [];
    if (!list.length) { $('citySug').innerHTML = '<div class="loading">nada encontrado</div>'; return; }
    $('citySug').innerHTML = list.map((c, i) =>
      `<div class="opt" data-i="${i}"><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.state || '')}</small></div>`).join('');
    $('citySug').querySelectorAll('.opt').forEach(el => el.onclick = () => addCity(list[+el.dataset.i]));
  } catch { $('citySug').innerHTML = '<div class="loading">erro na busca</div>'; }
}
function redrawCityMarkers() {
  cityMarkers.clearLayers();
  selectedCities.forEach(c => L.circleMarker([c.lat, c.lng],
    { radius: 7, color: '#28d192', weight: 2, fillColor: '#28d192', fillOpacity: .5 })
    .bindPopup('<b>' + escapeHtml(c.name) + '</b>').addTo(cityMarkers));
  if (selectedCities.length) map.fitBounds(L.latLngBounds(selectedCities.map(c => [c.lat, c.lng])).pad(0.3), { maxZoom: 12 });
}
function addCity(c) {
  if (selectedCities.some(x => x.display === c.display)) return;
  selectedCities.push(c);
  $('cityInput').value = ''; $('citySug').innerHTML = '';
  redrawCityMarkers(); renderChips();
}
function removeCity(display) { selectedCities = selectedCities.filter(c => c.display !== display); redrawCityMarkers(); renderChips(); }
function renderChips() {
  $('cityChips').innerHTML = selectedCities.map(c =>
    `<span class="chip"><b>${escapeHtml(c.name)}</b> <small>${escapeHtml(c.state || '')}</small><span class="x" data-d="${escapeHtml(c.display)}">×</span></span>`).join('');
  $('cityChips').querySelectorAll('.x').forEach(el => el.onclick = () => removeCity(el.dataset.d));
  updateProspectBtn();
}
function updateProspectBtn() { $('prospect').disabled = !(selectedCities.length && $('niche').value.trim()); }
$('niche').addEventListener('input', updateProspectBtn);

// ---------- prospectar ----------
$('prospect').onclick = async () => {
  const niche = $('niche').value.trim();
  if (!niche) return setMsg('Informe o nicho.', true);
  if (!selectedCities.length) return setMsg('Selecione ao menos uma cidade.', true);
  $('prospect').disabled = true; setMsg(`Rodando Apify em ${selectedCities.length} cidade(s)… (1–3 min)`);
  try {
    const r = await api('/api/prospect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ niche, cities: selectedCities, maxResults: +$('maxResults').value }) });
    if (r.error) setMsg('Erro: ' + r.error, true);
    else setMsg(`+${r.added} leads na fila (${r.skipped} repetidos). Total: ${r.total}.`);
  } catch (e) { setMsg('Falha: ' + e.message, true); }
  updateProspectBtn(); refresh();
};
function setMsg(t, err) { const m = $('prospectMsg'); m.textContent = t; m.className = 'msg' + (err ? ' err' : ''); }

// ---------- controles ----------
const ctrl = (action, value) => api('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, value }) }).then(refresh);
$('dryRun').onchange = (e) => ctrl('dryRun', e.target.checked);
$('paused').onchange = (e) => ctrl(e.target.checked ? 'pause' : 'resume');
$('resetC').onclick = () => confirm('Zerar contadores de mês/dia?') && ctrl('resetCounters');
$('clearQ').onclick = () => confirm('Remover todos os leads da fila (não enviados)?') && ctrl('clearQueue');
$('testSend').onclick = async () => {
  const phone = prompt('Enviar WhatsApp de TESTE para (com DDD):', '');
  if (!phone) return;
  const r = await api('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'testSend', phone }) });
  alert(r.ok ? 'Enviado! id ' + r.id : 'Falha: ' + (r.error || 'erro'));
  refresh();
};

let nichePronto = false;

// ---------- ajustes da campanha ----------
$('cfgSave').onclick = async () => {
  const b = $('cfgSave'), m = $('cfgMsg');
  b.disabled = true; b.textContent = 'Salvando…';
  try {
    const r = await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyCap: +$('cfgDaily').value, monthlyCap: +$('cfgMonthly').value,
        hourStart: +$('cfgH1').value, hourEnd: +$('cfgH2').value,
        niche: $('cfgNiche').value,
      }) });
    const c = r.config || {};
    // mostro o que o servidor GRAVOU, não o que eu digitei: se o teto de 50/dia cortou,
    // o número muda na tela e a pessoa vê o porquê.
    m.textContent = 'Salvo: ' + c.dailyCap + '/dia · ' + c.monthlyCap + '/mês · ' + c.hourStart + 'h às ' + c.hourEnd + 'h';
    m.className = 'msg ok';
    if (c.niche) { $('niche').value = c.niche; updateProspectBtn(); }
    refresh();
  } catch (e) {
    m.textContent = e.message || 'não consegui salvar'; m.className = 'msg err';
  }
  b.disabled = false; b.textContent = 'Salvar ajustes';
};

// ---------- avisos no WhatsApp do Diretor ----------
// Os dois eventos ligam/desligam separados de proposito: um e' por disparo
// (muitos por dia), o outro so' quando alguem responde (raro e importante).
async function salvaAviso() {
  const m = $('avisoMsg');
  try {
    await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avisaDisparo: $('avisoDisparo').checked, avisaCrm: $('avisoCrm').checked }) });
    m.textContent = 'Salvo.'; m.className = 'msg ok';
    refresh();
  } catch (e) { m.textContent = e.message || 'nao consegui salvar'; m.className = 'msg err'; }
}
$('avisoDisparo').onchange = salvaAviso;
$('avisoCrm').onchange = salvaAviso;
$('avisoTeste').onclick = async () => {
  const b = $('avisoTeste'), m = $('avisoMsg');
  b.disabled = true; b.textContent = 'Enviando…';
  try {
    const r = await api('/api/aviso-teste', { method: 'POST' });
    m.textContent = r.ok ? 'Enviado — confira o WhatsApp.' : ('Nao saiu: ' + (r.motivo || 'erro'));
    m.className = 'msg ' + (r.ok ? 'ok' : 'err');
  } catch (e) { m.textContent = e.message || 'falhou'; m.className = 'msg err'; }
  b.disabled = false; b.textContent = 'Enviar mensagem de teste';
};

// ---------- render/estado ----------
const COLOR = { queued: '#f2b34b', sent: '#28d192', failed: '#ef6b6b', skipped: '#4a5a54' };
async function refresh() {
  let s; try { s = await api('/api/state'); } catch { return; }
  const c = s.campaign;
  $('mSent').textContent = c.monthSent; $('mCap').textContent = c.monthlyCap;
  $('dSent').textContent = c.daySent; $('dCap').textContent = c.dailyCap;
  $('qCount').textContent = s.counts.queued; $('sCount').textContent = s.counts.sent;
  $('bizStatus').textContent = c.paused ? '⏸ pausado' : (c.dryRun ? '🧪 teste' : (c.businessNow ? '🟢 no ar' : '🌙 fora do horário'));
  $('nextSend').textContent = c.businessNow && !c.paused ? `próx. ~${c.nextGapMin} min` : c.hours;
  $('hours').textContent = c.hours;
  $('dryRun').checked = c.dryRun; $('paused').checked = c.paused;

  // config: nao sobrescreve o campo que esta em foco (o poll roda a cada poucos segundos)
  const cfg = c.config || {};
  const põe = (id, v) => { const el = $(id); if (el && document.activeElement !== el && v != null) el.value = v; };
  põe('cfgDaily', cfg.dailyCap); põe('cfgMonthly', cfg.monthlyCap);
  põe('cfgH1', cfg.hourStart); põe('cfgH2', cfg.hourEnd); põe('cfgNiche', cfg.niche);
  // estado do canal de avisos
  const av = c.avisos || {};
  const ad = $('avisoDisparo'), ac = $('avisoCrm'), ae = $('avisoEstado');
  if (ad && document.activeElement !== ad) ad.checked = !!cfg.avisaDisparo;
  if (ac && document.activeElement !== ac) ac.checked = !!cfg.avisaCrm;
  if (ae) {
    ae.textContent = av.ligado
      ? ('canal ligado · ' + av.destinos + ' numero(s) · instancia "' + av.instancia + '"')
      : ('canal DESLIGADO — ' + (av.motivo || 'configuracao incompleta'));
    ae.style.color = av.ligado ? '' : '#ef6b6b';
  }

  const h = $('cfgHint');
  if (h) {
    const uteis = 21, teto = (cfg.dailyCap || 0) * uteis;
    h.textContent = 'Só dias úteis, de segunda a sexta. No ritmo de ' + (cfg.dailyCap || 0)
      + '/dia dá ~' + teto + ' por mês'
      + (teto > (cfg.monthlyCap || 0) ? ' — acima do teto de ' + (cfg.monthlyCap || 0) + ', que vai travar antes do fim do mês.' : '.');
  }
  // o nicho padrão entra no campo de prospecção na primeira carga
  if (!nichePronto && cfg.niche && !$('niche').value) { $('niche').value = cfg.niche; nichePronto = true; updateProspectBtn(); }

  // mapa: heat p/ enviados, pins p/ fila/pulados
  const hpts = [], sub = [];
  pinLayer.clearLayers();
  for (const l of s.leads) {
    if (l.status === 'sent') hpts.push([l.lat, l.lng, 0.9]);
    else {
      L.circleMarker([l.lat, l.lng], { radius: 4, color: COLOR[l.status] || '#888', weight: 1,
        fillColor: COLOR[l.status] || '#888', fillOpacity: .7 })
        .bindPopup(`<b>${l.name}</b><br>${l.category || ''}<br>${l.phone || l.reason || ''}<br><i>${l.status}</i>`)
        .addTo(pinLayer);
    }
  }
  heat.setLatLngs(hpts);

  // log
  $('log').innerHTML = s.log.slice().reverse().map(e =>
    `<div class="l-${e.level}"><time>${e.t.slice(11, 19)}</time>${escapeHtml(e.msg)}</div>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }

refresh();
setInterval(refresh, 5000);
