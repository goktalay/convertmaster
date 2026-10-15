'use strict';

// Uygulama ayarları penceresi, Gece/Gündüz düğmesi ve hesap durumu (ana pencere ve proje penceresi ortak)

// --- Mastertool hesabı ve senkron durumu -------------------------------------------
let acct = { loggedIn: false };
const acctListeners = [];

function syncText(st) {
  if (!st.syncEnabled || st.state === 'off') return t('sync.off');
  if (st.state === 'syncing') return t('sync.syncing');
  if (st.state === 'offline') return t('sync.offline');
  if (st.state === 'error') {
    if (st.error === 'decrypt_failed') return t('sync.errDecrypt');
    if (st.error === 'too_large') return t('sync.errTooLarge');
    return t('sync.error', { msg: st.errorMessage || st.error });
  }
  return st.lastSyncAt ? t('acct.lastSync', { time: formatDate(st.lastSyncAt) }) : t('acct.never');
}

function onAcct(fn) { acctListeners.push(fn); fn(acct); }
function setAcct(st) {
  acct = st;
  const live = document.querySelector('#acct-status');
  if (live) live.textContent = syncText(acct);
  acctListeners.forEach((fn) => fn(acct));
}
window.api.onAccountStatus(setAcct);
window.api.accountState().then(setAcct);

async function logout() {
  const ok = await confirmBox(t('acct.logout'), esc(t('acct.logoutMsg')), { okText: t('acct.logout') });
  if (ok) window.api.logout();
}

// Hızlı tema düğmesi: Gece ↔ Gündüz
function themeButton(btn, getSettings) {
  const paint = () => {
    const s = getSettings();
    const dark = (s.appTheme || 'dark') !== 'light' && !(s.appTheme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
    btn.innerHTML = icon(dark ? 'sun' : 'moon');
    btn.title = dark ? t('set.toLight') : t('set.toDark');
  };
  btn.onclick = async () => {
    const dark = !matchMedia('(prefers-color-scheme: light)').matches;
    await window.api.setSettings({ appTheme: dark ? 'light' : 'dark' });
  };
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', paint);
  paint();
  return paint;
}

const options = (list, v) => list.map(([k, l]) => `<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const modelLabel = (k) => `${t(`speech.model.${k}`)} · ~${FORMATS.SPEECH_MODELS[k].mb} MB`;

// Konuşma modelleri listesi (indir / sil / iptal); ayarlarda ve proje formunda kullanılır
function speechModelsBox() {
  const box = h('<div class="models"></div>');
  let st = null;
  let dl = null;
  const paint = () => {
    if (!st) return;
    box.innerHTML = '';
    if (!st.engine) {
      box.appendChild(h(`<div class="model-note">${icon('info')}<span>${esc(st.canDownloadEngine ? t('speech.engineAuto') : t('speech.engineMissing'))}</span></div>`));
    }
    for (const k of Object.keys(FORMATS.SPEECH_MODELS)) {
      const m = st.models[k] || {};
      const busy = st.downloading.includes(k) || (dl && dl.model === k);
      const row = h(`<div class="model-row">
        <span class="model-name">${esc(t(`speech.model.${k}`))}</span>
        <span class="model-sub">${m.installed ? esc(t('speech.installed', { size: formatSize(m.size) })) : esc(`~${FORMATS.SPEECH_MODELS[k].mb} MB`)}</span>
        <span class="model-act"></span></div>`);
      const act = row.querySelector('.model-act');
      if (busy) {
        const pct = dl && dl.model === k ? Math.round(dl.progress * 100) : 0;
        act.appendChild(h(`<div class="progress mini"><div style="width:${pct}%"></div></div>`));
        const c = h(`<button class="btn sm ghost" type="button">${esc(t('common.cancel'))}</button>`);
        c.onclick = () => window.api.speechCancelDownload(k);
        act.appendChild(c);
      } else if (m.installed) {
        const b = h(`<button class="btn sm ghost danger" type="button">${icon('trash')}${esc(t('common.delete'))}</button>`);
        b.onclick = async () => { await window.api.speechDeleteModel(k); refresh(); };
        act.appendChild(b);
      } else {
        const b = h(`<button class="btn sm" type="button">${icon('download')}${esc(t('speech.download'))}</button>`);
        b.onclick = async () => {
          st.downloading.push(k);
          paint();
          const r = await window.api.speechDownload(k);
          if (!r.ok) toast(t('speech.downloadFailed'), { type: 'err', sub: r.message, timeout: 8000 });
          refresh();
        };
        act.appendChild(b);
      }
      box.appendChild(row);
    }
  };
  const refresh = async () => { st = await window.api.speechStatus(); paint(); };
  const off = window.api.onSpeechDownload((x) => {
    if (!box.isConnected) return off();
    const prev = dl;
    dl = x && x.what === 'model' ? x : null;
    if (!x && prev) refresh(); else paint();
  });
  refresh();
  return box;
}

async function openSettings(s) {
  let appTheme = s.appTheme || 'dark';
  const langOptions = Object.entries(I18N.LANGUAGES)
    .map(([code, l]) => `<option value="${code}" ${code === LANG ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const body = h(`<div style="display:grid;gap:16px">
    <div class="section-title" style="margin:0">${esc(t('acct.section'))}</div>
    <div class="acct-box">
      <div class="acct-who">${icon('user')}<span>${esc(t('acct.signedInAs', { email: (acct.user && acct.user.email) || acct.email || '' }))}</span></div>
      <label class="check"><input type="checkbox" id="s-sync" ${acct.syncEnabled ? 'checked' : ''}>
        <span>${esc(t('acct.syncToggle'))}<small>${esc(t('acct.syncHint'))}</small></span></label>
      <div class="acct-status">${icon('cloud')}<span id="acct-status">${esc(syncText(acct))}</span></div>
      <div class="acct-actions">
        <button class="btn sm" type="button" id="s-syncnow">${icon('refresh')}${esc(t('acct.syncNow'))}</button>
        <button class="btn sm" type="button" id="s-delremote">${icon('trash')}${esc(t('acct.deleteRemote'))}</button>
        <button class="btn sm" type="button" id="s-web">${icon('open')}${esc(t('acct.myAccount'))}</button>
        <span style="flex:1"></span>
        <button class="btn sm danger" type="button" id="s-logout">${icon('logout')}${esc(t('acct.logout'))}</button>
      </div>
    </div>

    <div class="section-title" style="margin:6px 0 0">${esc(t('set.appearance'))}</div>
    <div class="row c-1-1">
      <div class="field"><label>${esc(t('set.theme'))}</label>
        <div class="seg" id="s-theme">
          <button data-v="dark">${icon('moon')}${esc(t('set.themeDark'))}</button>
          <button data-v="light">${icon('sun')}${esc(t('set.themeLight'))}</button>
          <button data-v="system">${icon('monitor')}${esc(t('set.themeSystem'))}</button>
        </div></div>
      <div class="field"><label>${esc(t('set.language'))}</label><select class="input" id="s-lang">${langOptions}</select></div>
    </div>

    <div class="section-title" style="margin:6px 0 0">${esc(t('set.conversion'))}</div>
    <div class="row c-1-1">
      <div class="field"><label>${esc(t('set.defaultConcurrency'))}</label><input class="input" id="s-conc" type="number" min="1" max="32" value="${esc(s.defaultConcurrency || 2)}">
        <small class="hint">${esc(t('set.defaultConcurrencyHint'))}</small></div>
      <div class="field"><label>${esc(t('set.speechConcurrency'))}</label><input class="input" id="s-sconc" type="number" min="1" max="4" value="${esc(s.speechConcurrency || 1)}">
        <small class="hint">${esc(t('set.speechConcurrencyHint'))}</small></div>
    </div>

    <div class="section-title" style="margin:6px 0 0">${esc(t('set.speech'))}</div>
    <div class="field"><label>${esc(t('set.speechModel'))}</label>
      <select class="input" id="s-model">${options(Object.keys(FORMATS.SPEECH_MODELS).map((k) => [k, modelLabel(k)]), s.speechModel || 'base')}</select></div>
    <div id="s-models"></div>

    <div class="section-title" style="margin:6px 0 0">${esc(t('set.storage'))}</div>
    <div class="storage" id="s-storage"><div class="empty-note">…</div></div>
    <div class="about">${icon('info')} Convert Master ${esc(window.api.version || '')}</div>
  </div>`);

  const q = (sel) => body.querySelector(sel);
  q('#s-models').replaceWith(speechModelsBox());

  // Depolama: boyutlar ve temizlik (anında uygulanır)
  const paintStorage = async () => {
    const info = await window.api.storageInfo();
    const el = q('#s-storage');
    el.innerHTML = `
      <div class="st-row">${icon('layers')}<span>${esc(t('set.converted'))}</span><b>${formatSize(info.converted)}</b>
        <button class="btn sm ghost" data-a="open-converted">${icon('folder')}${esc(t('common.open'))}</button>
        <button class="btn sm ghost danger" data-a="clear-converted" ${info.converted ? '' : 'disabled'}>${icon('trash')}${esc(t('set.clearConverted'))}</button></div>
      <div class="st-row">${icon('image')}<span>${esc(t('set.previewCache'))}</span><b>${formatSize(info.cache)}</b>
        <span></span><button class="btn sm ghost danger" data-a="clear-cache" ${info.cache ? '' : 'disabled'}>${icon('broom')}${esc(t('set.clearCache'))}</button></div>
      <div class="st-row">${icon('mic')}<span>${esc(t('set.models'))}</span><b>${formatSize(info.models)}</b>
        <button class="btn sm ghost" data-a="open-models">${icon('folder')}${esc(t('common.open'))}</button><span></span></div>
      <div class="hint st-path">${esc(info.dir)}</div>`;
    el.querySelector('[data-a="open-converted"]').onclick = () => window.api.openStorage('converted');
    el.querySelector('[data-a="open-models"]').onclick = () => window.api.openStorage('models');
    el.querySelector('[data-a="clear-cache"]').onclick = async () => { await window.api.clearCache(); paintStorage(); };
    el.querySelector('[data-a="clear-converted"]').onclick = async () => {
      const r = await clearOutputsDialog(t('set.clearConverted'), t('set.clearConvertedMsg'));
      if (!r) return;
      await window.api.clearConverted(r.transcripts);
      toast(t('set.clearedConverted'), { type: 'ok' });
      paintStorage();
    };
  };
  paintStorage();

  q('#s-sync').onchange = async (e) => {
    const on = e.target.checked;
    const r = await window.api.setSyncEnabled(on);
    if (!r.ok) { e.target.checked = !on; toast(t('sync.error', { msg: r.code }), { type: 'err' }); }
  };
  q('#s-syncnow').onclick = () => window.api.syncNow();
  q('#s-web').onclick = () => window.api.openWeb('account');
  q('#s-delremote').onclick = async () => {
    const ok = await confirmBox(t('acct.deleteRemote'), esc(t('acct.deleteRemoteMsg')));
    if (!ok) return;
    const r = await window.api.deleteRemoteLibrary();
    if (r.ok) { q('#s-sync').checked = false; toast(t('acct.deleteRemoteDone'), { type: 'ok' }); }
    else toast(t('sync.error', { msg: r.code }), { type: 'err' });
  };
  q('#s-logout').onclick = logout;

  const setTheme = (v) => {
    appTheme = v;
    body.querySelectorAll('#s-theme button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    window.api.setSettings({ appTheme: v });
  };
  body.querySelectorAll('#s-theme button').forEach((b) => (b.onclick = () => setTheme(b.dataset.v)));
  body.querySelectorAll('#s-theme button').forEach((b) => b.classList.toggle('on', b.dataset.v === appTheme));
  const originalTheme = appTheme;

  const clamp = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def; };
  const res = await openModal({
    title: t('set.title'), iconName: 'gear', width: 640, body,
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: t('common.save'), cls: 'primary',
        onClick: () => ({
          appTheme,
          language: q('#s-lang').value,
          defaultConcurrency: clamp(q('#s-conc').value, 1, 32, 2),
          speechConcurrency: clamp(q('#s-sconc').value, 1, 4, 1),
          speechModel: q('#s-model').value,
        }),
      },
    ],
  });
  if (!res) {
    if (appTheme !== originalTheme) window.api.setSettings({ appTheme: originalTheme });
    return null;
  }
  const langChanged = res.language !== LANG;
  if (!langChanged) delete res.language;
  await window.api.setSettings(res);
  if (!langChanged) toast(t('set.saved'), { type: 'ok' });
  return res;
}

// "Çevrilmiş dosyaları sil" onayı; metinler isteğe bağlı
async function clearOutputsDialog(title, message, { speech = true } = {}) {
  return openModal({
    title, iconName: 'trash',
    body: `<div style="color:var(--text-2);line-height:1.5">${message}</div>
      ${speech ? `<label class="check"><input type="checkbox" id="cd-tr"><span>${esc(t('set.alsoTranscripts'))}</span></label>` : ''}`,
    buttons: [
      { label: t('common.giveUp'), value: null },
      { label: t('common.delete'), cls: 'primary danger-primary', onClick: (m) => ({ transcripts: !!(m.querySelector('#cd-tr') || {}).checked }) },
    ],
  });
}
