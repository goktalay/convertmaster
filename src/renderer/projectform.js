'use strict';

// Proje formu: "Yeni" (ana pencere) ve "Proje ayarları" (ana pencere ve proje penceresi).
// Akış: Proje İsmi → Tür (Video / Resim / Ses) → kaynak ve hedef uzantı → Dosya / Klasör → seçim
//       → aynı anda kaç dosya → (video/seste) konuşmayı metne çevir / (resimde) OCR — ikisi de isteğe bağlı → Kaydet.

const TYPE_ICONS = { video: 'video', image: 'image', audio: 'audio' };
// langName: settings.js

const optList = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');

// --- Kalite ve boyut: en-boy oranı şekilleri, hazır ayar adları ---------------------------
const AR_WORD = { '16:9': 'landscape', '9:16': 'portrait', '1:1': 'square', '4:5': 'portrait', '4:3': 'classic', '3:4': 'portrait', '21:9': 'cinema' };
const aspectLabel = (a) => (a === 'source' ? t('out.ar.source') : a === 'custom' ? t('out.ar.custom') : `${a} · ${t(`out.ar.${AR_WORD[a]}`)}`);
// Oranı gösteren küçük dikdörtgen (kaynak/özel kesikli kenarlı)
function arShape(a, text = '') {
  const [w, h] = /^\d+:\d+$/.test(a) ? a.split(':').map(Number) : [4, 3];
  const k = 26 / Math.max(w, h);
  if (w * k < 24) text = ''; // dar (dikey) şekle yazı sığmaz
  return `<span class="ar-shape ${/^\d/.test(a) ? '' : 'loose'}" style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px">${esc(text)}</span>`;
}
function presetDesc(type, pr) {
  const o = { ...FORMATS.defaultOptions()[type], ...pr.o };
  const f = FORMATS.frameSize(o, 0, 0, type === 'video');
  return f ? `${o.aspect} · ${f.W}×${f.H}` : t(`preset.${pr.id}Desc`);
}
function presetTag(pr) {
  if (pr.o.aspect) return pr.o.aspect;
  if (pr.o.resolution && pr.o.resolution !== 'source') return `${pr.o.resolution}p`;
  if (pr.o.maxWidth) return `${pr.o.maxWidth}`;
  return 'HQ';
}

function targetOptions(type, v) {
  const T = FORMATS.TYPES[type];
  if (type !== 'video') return optList(T.target.map((x) => [x, x.toUpperCase()]), v);
  const vids = T.target.filter((x) => !T.audioOnlyTargets.includes(x) && x !== 'gif');
  const group = (label, list) => `<optgroup label="${esc(label)}">${optList(list.map((x) => [x, x.toUpperCase()]), v)}</optgroup>`;
  return group(t('pf.groupVideo'), vids) + group(t('pf.groupAnim'), ['gif']) + group(t('pf.groupAudioOnly'), T.audioOnlyTargets);
}

// folders: hiyerarşik klasör seçimi için; null ise klasör alanı gizlenir
async function editProject(project, { folderId = null, folders = null, settings = {} } = {}) {
  const isNew = !project;
  const p = JSON.parse(JSON.stringify(project || {
    name: '', type: 'video', sourceExts: [...FORMATS.TYPES.video.defaultSource], targetExt: FORMATS.TYPES.video.defaultTarget,
    sourceMode: 'folder', includeSubfolders: true, concurrency: settings.defaultConcurrency || 2,
    speech: { ...FORMATS.defaultSpeech(), model: settings.speechModel || 'base' },
    ocr: { ...FORMATS.defaultOcr(), languages: settings.ocrLanguages || FORMATS.defaultOcr().languages },
    options: FORMATS.defaultOptions(), folderId, sourcePath: '',
  }));
  p.options = { ...FORMATS.defaultOptions(), ...(p.options || {}) };
  for (const k of ['video', 'image', 'audio']) p.options[k] = { ...FORMATS.defaultOptions()[k], ...(p.options[k] || {}) };
  p.speech = { ...FORMATS.defaultSpeech(), ...(p.speech || {}) };
  p.ocr = { ...FORMATS.defaultOcr(), languages: settings.ocrLanguages || FORMATS.defaultOcr().languages, ...(p.ocr || {}) };
  let sourcePath = p.sourcePath || '';

  const folderSelect = () => {
    const out = [`<option value="">${esc(t('app.rootFolder'))}</option>`];
    const walk = (parentId, depth) => {
      for (const f of folders.filter((x) => (x.parentId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name, LANG))) {
        out.push(`<option value="${f.id}" ${f.id === p.folderId ? 'selected' : ''}>${'&nbsp;&nbsp;&nbsp;'.repeat(depth)}${esc(f.name)}</option>`);
        walk(f.id, depth + 1);
      }
    };
    walk(null, 1);
    return out.join('');
  };

  const body = h(`<div class="pf">
    <div class="tabs">
      <button type="button" data-tab="general" class="on">${icon('layers')}${esc(t('pf.tabGeneral'))}</button>
      <button type="button" data-tab="output">${icon('gear')}${esc(t('pf.tabOutput'))}</button>
      <button type="button" data-tab="speech">${icon('mic')}${esc(t('pf.tabSpeech'))}</button>
      <button type="button" data-tab="ocr">${icon('text')}${esc(t('pf.tabOcr'))}</button>
    </div>

    <div class="tab-panel" data-panel="general">
      <div class="field"><label>${esc(t('pf.name'))}</label><input class="input" id="pf-name" maxlength="120" placeholder="${esc(t('pf.namePh'))}" value="${esc(p.name)}"></div>
      <div class="field"><label>${esc(t('pf.type'))}</label>
        <div class="types">${Object.keys(FORMATS.TYPES).map((k) => `
          <button type="button" class="type-card" data-type="${k}" style="--c:${FORMATS.TYPES[k].color}">
            <span class="ti">${icon(TYPE_ICONS[k])}</span><span><b>${esc(t(`type.${k}`))}</b><small>${esc(t(`type.${k}Hint`))}</small></span>
          </button>`).join('')}</div></div>
      <div class="ext-row">
        <div class="field"><div class="hint-line"><label>${esc(t('pf.sourceExt'))}</label><a id="pf-all"></a></div><div class="ext-chips" id="pf-src"></div></div>
        <div class="ext-arrow">${icon('arrowRight', '')}</div>
        <div class="field"><label>${esc(t('pf.targetExt'))}</label><select class="input" id="pf-target"></select>
          <small class="hint" id="pf-target-hint"></small></div>
      </div>
      <div class="out-sum">${icon('gauge')}<span>${esc(t('pf.tabOutput'))}:</span><b id="pf-outsum"></b><a id="pf-outgo">${esc(t('pf.change'))}</a></div>
      <div class="field"><label>${esc(t('pf.source'))}</label>
        <div class="seg" id="pf-mode">
          <button type="button" data-v="file">${icon('file')}${esc(t('pf.modeFile'))}</button>
          <button type="button" data-v="folder">${icon('folder')}${esc(t('pf.modeFolder'))}</button>
        </div></div>
      <div class="field"><label id="pf-path-label"></label>
        <div class="src-pick"><input class="input" id="pf-path" readonly spellcheck="false"><button type="button" class="btn" id="pf-pick">${icon('folder')}${esc(t('common.choose'))}</button></div>
        <label class="check" id="pf-sub-wrap"><input type="checkbox" id="pf-sub" ${p.includeSubfolders !== false ? 'checked' : ''}><span>${esc(t('pf.subfolders'))}</span></label>
      </div>
      <div class="row c-1-1">
        <div class="field"><label>${esc(t('pf.concurrency'))}</label>
          <div class="inline"><input class="input" id="pf-conc" type="number" min="1" max="32" value="${esc(p.concurrency || 2)}"><div class="chips" id="pf-conc-chips"></div></div>
          <small class="hint">${esc(t('pf.concurrencyHint'))}</small></div>
        ${folders ? `<div class="field"><label>${esc(t('pf.folder'))}</label><select class="input" id="pf-folder">${folderSelect()}</select></div>` : '<div></div>'}
      </div>
      <label class="speech-ask check hidden" id="pf-ocr-ask"><input type="checkbox" id="pf-ocr" ${p.ocr.enabled ? 'checked' : ''}>
        <span>${icon('text', 'si')}</span><span><b>${esc(t('pf.ocrAsk'))}</b><small>${esc(t('pf.ocrAskHint'))}</small></span></label>
      <label class="speech-ask check" id="pf-speech-ask"><input type="checkbox" id="pf-speech" ${p.speech.enabled ? 'checked' : ''}>
        <span>${icon('mic', 'si')}</span><span><b>${esc(t('pf.speechAsk'))}</b><small>${esc(t('pf.speechAskHint'))}</small></span></label>
    </div>

    <div class="tab-panel hidden" data-panel="output"></div>

    <div class="tab-panel hidden" data-panel="ocr">
      <label class="check"><input type="checkbox" id="pf-ocr2"><span>${esc(t('pf.ocrAsk'))}<small>${esc(t('pf.ocrAskHint'))}</small></span></label>
      <div class="field"><div class="hint-line"><label>${esc(t('pf.ocrLangs'))}</label></div><div class="ext-chips" id="pf-ocr-langs"></div>
        <small class="hint">${esc(t('pf.ocrLangsHint'))}</small></div>
      <div class="section-title">${esc(t('pf.ocrData'))}</div>
      <div id="pf-ocr-models"></div>
      <small class="hint">${esc(t('pf.ocrNote'))}</small>
    </div>

    <div class="tab-panel hidden" data-panel="speech">
      <label class="check"><input type="checkbox" id="pf-speech2"><span>${esc(t('pf.speechAsk'))}<small>${esc(t('pf.speechAskHint'))}</small></span></label>
      <div class="row c-1-1">
        <div class="field"><label>${esc(t('pf.speechModel'))}</label>
          <select class="input" id="pf-model">${optList(Object.keys(FORMATS.SPEECH_MODELS).map((k) => [k, `${t(`speech.model.${k}`)} · ~${FORMATS.SPEECH_MODELS[k].mb} MB`]), p.speech.model)}</select></div>
        <div class="field"><label>${esc(t('pf.speechLang'))}</label>
          <select class="input" id="pf-lang">${optList(FORMATS.SPEECH_LANGS.map((c) => [c, langName(c)]), p.speech.language)}</select></div>
      </div>
      <label class="check"><input type="checkbox" id="pf-window" ${p.speech.perWindow ? 'checked' : ''}><span>${esc(t('pf.perWindow'))}<small>${esc(t('pf.perWindowHint'))}</small></span></label>
      <div class="section-title">${esc(t('pf.models'))}</div>
      <div id="pf-models"></div>
      <small class="hint">${esc(t('pf.speechNote'))}</small>
    </div>
  </div>`);
  const q = (s) => body.querySelector(s);
  q('#pf-models').replaceWith(speechModelsBox());
  q('#pf-ocr-models').replaceWith(ocrLangsBox(() => p.ocr.languages));

  // OCR dilleri (en çok 6; Tesseract birden çok dili aynı anda okuyabilir)
  const paintOcrLangs = () => {
    const el = q('#pf-ocr-langs');
    el.innerHTML = '';
    for (const l of FORMATS.OCR_LANGS) {
      const b = h(`<button type="button" class="ext-chip all ${p.ocr.languages.includes(l) ? 'on' : ''}">${esc(langName(FORMATS.OCR_ISO[l]))}</button>`);
      b.onclick = () => {
        if (p.ocr.languages.includes(l)) { if (p.ocr.languages.length > 1) p.ocr.languages = p.ocr.languages.filter((x) => x !== l); }
        else if (p.ocr.languages.length < 6) p.ocr.languages = [...p.ocr.languages, l];
        paintOcrLangs();
        document.dispatchEvent(new Event('ocr-langs-changed'));
      };
      el.appendChild(b);
    }
  };
  paintOcrLangs();

  // --- Sekmeler
  const showTab = (name) => {
    body.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    body.querySelectorAll('.tab-panel').forEach((x) => x.classList.toggle('hidden', x.dataset.panel !== name));
  };
  body.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  q('#pf-outgo').onclick = () => showTab('output');

  // --- Kalite ve boyut (türe göre). st: o anki türün seçenekleri; en-boy ve yerleştirme düğmeleri doğrudan st'yi değiştirir
  let st = null;
  const syncFromDom = () => {
    const o = JSON.parse(JSON.stringify(p.options));
    const v = (id) => { const el = q(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
    const set = (obj, k, val) => { if (val !== undefined) obj[k] = val; };
    if (p.type === 'video' && st) {
      for (const [k, id] of [['quality', '#o-q'], ['resolution', '#o-res'], ['fps', '#o-fps'], ['codec', '#o-codec'], ['speed', '#o-speed'],
        ['audioBitrate', '#o-ab'], ['noAudio', '#o-noa'], ['padColor', '#o-pad'], ['rotate', '#o-rot']]) set(st, k, v(id));
    } else if (p.type === 'image' && st) {
      for (const [k, id] of [['size', '#o-size'], ['keepMeta', '#o-meta'], ['padColor', '#o-pad'], ['rotate', '#o-rot']]) set(st, k, v(id));
      if (q('#o-iq')) st.quality = Number(v('#o-iq'));
      if (q('#o-w')) { st.maxWidth = Number(v('#o-w')) || 0; st.maxHeight = Number(v('#o-h')) || 0; }
    }
    if (st && q('#o-cw')) { st.width = Number(v('#o-cw')) || st.width; st.height = Number(v('#o-ch2')) || st.height; }
    if (p.type === 'audio') Object.assign(o.audio, { bitrate: v('#o-br'), sampleRate: v('#o-sr'), channels: v('#o-ch') });
    else if (st) o[p.type] = { ...st };
    return o;
  };
  const readOutput = syncFromDom;

  const outSummary = (o) => {
    if (p.type === 'audio') return `${o.audio.bitrate} kbps`;
    const x = o[p.type];
    const parts = [];
    if (x.preset && x.preset !== 'custom') parts.push(t(`preset.${x.preset}`));
    else {
      const f = FORMATS.frameSize(x, 0, 0, p.type === 'video');
      if (x.aspect && x.aspect !== 'source') parts.push(f ? `${aspectLabel(x.aspect)} · ${f.W}×${f.H}` : aspectLabel(x.aspect));
      else if (p.type === 'video' && x.resolution !== 'source') parts.push(`${x.resolution}p`);
      else if (p.type === 'image' && (x.maxWidth || x.maxHeight)) parts.push(`≤ ${x.maxWidth || '∞'}×${x.maxHeight || '∞'}`);
      else parts.push(t('out.asSource'));
      if (Number(x.rotate)) parts.push(t(`out.rot.${x.rotate}`));
    }
    parts.push(p.type === 'video' ? t(`out.q.${x.quality}`).replace(/\s*\(.*\)$/, '') : `${t('out.imgQuality')} ${x.quality}`);
    return parts.join(' · ');
  };
  const paintSummary = () => { q('#pf-outsum').textContent = outSummary(readOutput()); };

  // Hazır ayar kartları + boyut/oran bölümü (video ve resim ortak)
  const frameHtml = (type, v) => {
    const presets = FORMATS.PRESETS[type];
    const pads = type === 'image' ? FORMATS.PAD_COLORS : FORMATS.PAD_COLORS.filter((c) => c !== 'transparent');
    const sizeSel = type === 'video'
      ? `<select class="input" id="o-res">${optList(FORMATS.RESOLUTIONS.map((k) => [k, k === 'source' ? t('out.asSource') : `${k}p`]), v.resolution)}</select>`
      : `<select class="input" id="o-size">${optList(FORMATS.IMAGE_SIZES.map((k) => [k, k === 'source' ? t('out.asSource') : `${k} px`]), v.size)}</select>`;
    return `
      <div class="section-title">${esc(t('out.presets'))}</div>
      <div class="presets" id="o-presets">
        <button type="button" class="preset" data-p="custom">${arShape('custom', '✎')}<span><b>${esc(t('out.presetCustom'))}</b><small>${esc(t('out.presetCustomDesc'))}</small></span></button>
        ${presets.map((pr) => `<button type="button" class="preset" data-p="${pr.id}">${arShape(pr.o.aspect || '16:9', presetTag(pr))}
          <span><b>${esc(t(`preset.${pr.id}`))}</b><small>${esc(presetDesc(type, pr))}</small></span></button>`).join('')}
      </div>
      <div class="section-title">${esc(t('out.frame'))}</div>
      <div class="aspects" id="o-ar">${FORMATS.ASPECTS.map((a) => `<button type="button" class="ar-chip" data-v="${a}">${arShape(a, a === 'custom' ? '…' : '')}<span>${esc(aspectLabel(a))}</span></button>`).join('')}</div>
      <div class="row c-1-1">
        <div class="field" id="o-size-f"><label id="o-size-l"></label>${sizeSel}<small class="hint" id="o-size-hint"></small></div>
        <div class="field hidden" id="o-custom-f"><label>${esc(t('out.width'))} × ${esc(t('out.height'))}</label>
          <div class="wh"><div class="unit-wrap"><input class="input" id="o-cw" type="number" min="16" max="8192" value="${esc(v.width)}"><span>px</span></div><b>×</b>
          <div class="unit-wrap"><input class="input" id="o-ch2" type="number" min="16" max="8192" value="${esc(v.height)}"><span>px</span></div></div></div>
        <div class="field"><label>${esc(t('out.rotate'))}</label><select class="input" id="o-rot">${optList(FORMATS.ROTATIONS.map((r) => [r, t(`out.rot.${r}`)]), String(v.rotate || '0'))}</select></div>
      </div>
      ${type === 'image' ? `<div class="row c-1-1" id="o-limit">
          <div class="field"><label>${esc(t('out.maxWidth'))}</label><div class="unit-wrap"><input class="input" id="o-w" type="number" min="0" max="20000" value="${esc(v.maxWidth || '')}" placeholder="${esc(t('out.noLimit'))}"><span>px</span></div></div>
          <div class="field"><label>${esc(t('out.maxHeight'))}</label><div class="unit-wrap"><input class="input" id="o-h" type="number" min="0" max="20000" value="${esc(v.maxHeight || '')}" placeholder="${esc(t('out.noLimit'))}"><span>px</span></div></div>
        </div>` : ''}
      <div class="row c-1-1" id="o-fit-row">
        <div class="field"><label>${esc(t('out.fit'))}</label>
          <div class="seg" id="o-fit">${FORMATS.FITS.map((f) => `<button type="button" data-v="${f}">${esc(t(`out.fit.${f}`))}</button>`).join('')}</div>
          <small class="hint" id="o-fit-hint"></small></div>
        <div class="field" id="o-pad-f"><label>${esc(t('out.padColor'))}</label><select class="input" id="o-pad">${optList(pads.map((c) => [c, t(`out.pad.${c}`)]), v.padColor)}</select></div>
      </div>
      <div class="out-size" id="o-outsize"></div>`;
  };

  // Görünürlük, seçili düğmeler, çıktı boyutu satırı
  const paintFrame = () => {
    const type = p.type;
    syncFromDom();
    const framed = st.aspect && st.aspect !== 'source';
    const custom = st.aspect === 'custom';
    body.querySelectorAll('#o-presets .preset').forEach((b) => b.classList.toggle('on', b.dataset.p === (st.preset || 'custom')));
    body.querySelectorAll('#o-ar .ar-chip').forEach((b) => b.classList.toggle('on', b.dataset.v === (st.aspect || 'source')));
    body.querySelectorAll('#o-fit button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.fit));
    q('#o-size-f').classList.toggle('hidden', custom || (type === 'image' && !framed));
    q('#o-custom-f').classList.toggle('hidden', !custom);
    if (q('#o-limit')) q('#o-limit').classList.toggle('hidden', framed);
    q('#o-fit-row').classList.toggle('hidden', !framed);
    q('#o-pad-f').classList.toggle('hidden', st.fit !== 'pad');
    q('#o-fit-hint').textContent = t(`out.fitHint.${st.fit}`);
    q('#o-size-l').textContent = framed ? t('out.shortSide') : t('out.resolution');
    q('#o-size-hint').textContent = framed ? t('out.frameHint') : type === 'video' ? t('out.resolutionHint') : '';
    const f = FORMATS.frameSize(st, 0, 0, type === 'video');
    q('#o-outsize').innerHTML = f ? `${icon('crosshair')}${esc(t('out.outputSize', { w: f.W, h: f.H }))}`
      : `${icon('info')}${esc(framed ? t('out.outputShortSource') : t('out.outputSource'))}`;
    paintSummary();
  };
  const bindFrame = () => {
    const changed = () => { st.preset = 'custom'; paintFrame(); };
    body.querySelectorAll('#o-presets .preset').forEach((b) => (b.onclick = () => {
      syncFromDom();
      st = b.dataset.p === 'custom' ? { ...st, preset: 'custom' } : FORMATS.applyPreset(p.type, st, b.dataset.p);
      p.options = { ...p.options, [p.type]: st };
      paintOutput();
    }));
    body.querySelectorAll('#o-ar .ar-chip').forEach((b) => (b.onclick = () => { syncFromDom(); st.aspect = b.dataset.v; changed(); }));
    body.querySelectorAll('#o-fit button').forEach((b) => (b.onclick = () => { syncFromDom(); st.fit = b.dataset.v; changed(); }));
    for (const id of ['#o-res', '#o-size', '#o-rot', '#o-pad', '#o-cw', '#o-ch2', '#o-w', '#o-h', '#o-q', '#o-fps', '#o-ab', '#o-iq', '#o-speed']) {
      const el = q(id);
      if (el) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', changed);
    }
  };

  const paintOutput = () => {
    const el = q('[data-panel="output"]');
    const o = p.options;
    st = p.type === 'audio' ? null : { ...o[p.type] };
    if (p.type === 'video') {
      const v = o.video;
      el.innerHTML = `
        ${frameHtml('video', v)}
        <div class="section-title">${esc(t('out.qualitySection'))}</div>
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('out.quality'))}</label><select class="input" id="o-q">${optList(FORMATS.QUALITY.map((k) => [k, t(`out.q.${k}`)]), v.quality)}</select></div>
          <div class="field"><label>${esc(t('out.fps'))}</label><select class="input" id="o-fps">${optList(FORMATS.FPS.map((k) => [k, k === 'source' ? t('out.asSource') : `${k} fps`]), v.fps)}</select></div>
        </div>
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('out.codec'))}</label><select class="input" id="o-codec">${optList([['h264', t('out.h264')], ['h265', t('out.h265')]], v.codec)}</select>
            <small class="hint">${esc(t('out.codecHint'))}</small></div>
          <div class="field"><label>${esc(t('out.speed'))}</label><select class="input" id="o-speed">${optList(['veryfast', 'fast', 'medium', 'slow'].map((k) => [k, t(`out.speed.${k}`)]), v.speed)}</select></div>
        </div>
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('out.audioBitrate'))}</label><select class="input" id="o-ab">${optList(FORMATS.AUDIO_BITRATES.map((k) => [k, `${k} kbps`]), v.audioBitrate)}</select></div>
          <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" id="o-noa" ${v.noAudio ? 'checked' : ''}><span>${esc(t('out.noAudio'))}</span></label></div>
        </div>`;
      bindFrame();
      paintFrame();
    } else if (p.type === 'image') {
      const v = o.image;
      el.innerHTML = `
        ${frameHtml('image', v)}
        <div class="section-title">${esc(t('out.qualitySection'))}</div>
        <div class="field"><label>${esc(t('out.imgQuality'))}: <b id="o-iqv">${v.quality}</b></label><input type="range" id="o-iq" min="1" max="100" value="${esc(v.quality)}">
          <small class="hint">${esc(t('out.imgQualityHint'))}</small></div>
        <label class="check"><input type="checkbox" id="o-meta" ${v.keepMeta ? 'checked' : ''}><span>${esc(t('out.keepMeta'))}<small>${esc(t('out.keepMetaHint'))}</small></span></label>`;
      q('#o-iq').addEventListener('input', (e) => (q('#o-iqv').textContent = e.target.value));
      bindFrame();
      paintFrame();
    } else {
      const v = o.audio;
      el.innerHTML = `
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('out.bitrate'))}</label><select class="input" id="o-br">${optList(FORMATS.AUDIO_BITRATES.map((k) => [k, `${k} kbps`]), v.bitrate)}</select>
            <small class="hint">${esc(t('out.bitrateHint'))}</small></div>
          <div class="field"><label>${esc(t('out.sampleRate'))}</label><select class="input" id="o-sr">${optList(FORMATS.SAMPLE_RATES.map((k) => [k, k === 'source' ? t('out.asSource') : `${Number(k) / 1000} kHz`]), v.sampleRate)}</select></div>
        </div>
        <div class="field"><label>${esc(t('out.channels'))}</label><select class="input" id="o-ch">${optList([['source', t('out.asSource')], ['stereo', t('out.stereo')], ['mono', t('out.mono')]], v.channels)}</select></div>`;
      for (const id of ['#o-br', '#o-sr', '#o-ch']) q(id).addEventListener('change', paintSummary);
      paintSummary();
    }
  };

  // --- Tür, uzantılar, kaynak
  const T = () => FORMATS.TYPES[p.type];
  const paintType = () => {
    body.querySelectorAll('.type-card').forEach((b) => b.classList.toggle('on', b.dataset.type === p.type));
    body.style.setProperty('--c', T().color);
    const src = q('#pf-src');
    src.innerHTML = '';
    for (const x of T().source) {
      const b = h(`<button type="button" class="ext-chip ${p.sourceExts.includes(x) ? 'on' : ''}">${esc(x)}</button>`);
      b.onclick = () => {
        p.sourceExts = p.sourceExts.includes(x) ? p.sourceExts.filter((y) => y !== x) : [...p.sourceExts, x];
        b.classList.toggle('on');
        paintAll();
      };
      src.appendChild(b);
    }
    q('#pf-target').innerHTML = targetOptions(p.type, p.targetExt);
    // Video/seste konuşmadan metne, resimde OCR seçeneği sunulur (ikisi de isteğe bağlı)
    const speechOk = p.type !== 'image';
    q('#pf-speech-ask').classList.toggle('hidden', !speechOk);
    q('#pf-ocr-ask').classList.toggle('hidden', speechOk);
    body.querySelector('[data-tab="speech"]').classList.toggle('hidden', !speechOk);
    body.querySelector('[data-tab="ocr"]').classList.toggle('hidden', speechOk);
    paintAll();
    paintOutput();
  };
  const paintAll = () => {
    const all = p.sourceExts.length === T().source.length;
    q('#pf-all').textContent = all ? t('pf.selectNone') : t('pf.selectAll');
    const ao = p.type === 'video' && T().audioOnlyTargets.includes(q('#pf-target').value);
    q('#pf-target-hint').textContent = ao ? t('pf.audioOnlyHint') : q('#pf-target').value === 'gif' ? t('pf.gifHint') : '';
  };
  q('#pf-all').onclick = () => {
    p.sourceExts = p.sourceExts.length === T().source.length ? [] : [...T().source];
    paintType();
  };
  body.querySelectorAll('.type-card').forEach((b) => (b.onclick = () => {
    if (p.type === b.dataset.type) return;
    p.type = b.dataset.type;
    p.sourceExts = [...T().defaultSource];
    p.targetExt = T().defaultTarget;
    if (p.sourceMode === 'file' && sourcePath && !T().source.includes(FORMATS.extOf(sourcePath))) { sourcePath = ''; paintMode(); }
    paintType();
  }));
  q('#pf-target').onchange = (e) => { p.targetExt = e.target.value; paintAll(); };

  const paintMode = () => {
    body.querySelectorAll('#pf-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.sourceMode));
    q('#pf-path-label').textContent = p.sourceMode === 'file' ? t('pf.pathFile') : t('pf.pathFolder');
    q('#pf-path').value = sourcePath;
    q('#pf-path').placeholder = isNew || !sourcePath ? t('pf.pathNone') : '';
    q('#pf-sub-wrap').classList.toggle('hidden', p.sourceMode !== 'folder');
  };
  body.querySelectorAll('#pf-mode button').forEach((b) => (b.onclick = () => {
    if (p.sourceMode === b.dataset.v) return;
    p.sourceMode = b.dataset.v;
    sourcePath = '';
    paintMode();
  }));
  q('#pf-pick').onclick = async () => {
    const picked = await window.api.pickSource({ mode: p.sourceMode, type: p.type, exts: p.sourceExts, defaultPath: sourcePath || undefined });
    if (!picked) return;
    sourcePath = picked;
    q('#pf-path').classList.remove('invalid');
    if (p.sourceMode === 'file') {
      const ext = FORMATS.extOf(picked);
      if (T().source.includes(ext) && !p.sourceExts.includes(ext)) { p.sourceExts.push(ext); paintType(); }
    }
    if (!q('#pf-name').value.trim()) q('#pf-name').value = picked.split(/[\\/]/).filter(Boolean).pop().replace(/\.[^.]+$/, '');
    paintMode();
  };

  for (const n of [1, 2, 4, 8]) {
    const b = h(`<button type="button" class="chip">${n}</button>`);
    b.onclick = () => (q('#pf-conc').value = n);
    q('#pf-conc-chips').appendChild(b);
  }

  // İki onay kutusu (Genel ve Konuşma sekmesi) aynı değeri gösterir
  const setSpeech = (on) => {
    p.speech.enabled = on;
    q('#pf-speech').checked = on;
    q('#pf-speech2').checked = on;
    q('#pf-speech-ask').classList.toggle('on', on);
  };
  q('#pf-speech').onchange = (e) => setSpeech(e.target.checked);
  q('#pf-speech2').onchange = (e) => setSpeech(e.target.checked);
  setSpeech(!!p.speech.enabled);
  const setOcr = (on) => {
    p.ocr.enabled = on;
    q('#pf-ocr').checked = on;
    q('#pf-ocr2').checked = on;
    q('#pf-ocr-ask').classList.toggle('on', on);
  };
  q('#pf-ocr').onchange = (e) => setOcr(e.target.checked);
  q('#pf-ocr2').onchange = (e) => setOcr(e.target.checked);
  setOcr(!!p.ocr.enabled);

  paintType();
  paintMode();

  const res = await openModal({
    title: isNew ? t('pf.titleNew') : t('pf.titleEdit', { name: p.name }), iconName: isNew ? 'plus' : 'gear', width: 720, body,
    buttons: [
      { label: t('common.cancel'), value: null },
      {
        label: isNew ? t('pf.create') : t('common.save'), cls: 'primary',
        onClick: async () => {
          const name = q('#pf-name').value.trim();
          let bad = false;
          if (!name) { q('#pf-name').classList.add('invalid'); bad = true; }
          if (!p.sourceExts.length && p.sourceMode === 'folder') { toast(t('pf.errExt'), { type: 'err' }); bad = true; }
          if (isNew && !sourcePath) { q('#pf-path').classList.add('invalid'); bad = true; }
          if (bad) { showTab('general'); return false; }
          const form = {
            id: project ? project.id : undefined, name, type: p.type, sourceExts: p.sourceExts, targetExt: q('#pf-target').value,
            sourceMode: p.sourceMode, includeSubfolders: q('#pf-sub').checked,
            concurrency: Number(q('#pf-conc').value) || 2, folderId: folders ? q('#pf-folder').value || null : p.folderId,
            ocr: { enabled: p.type === 'image' && q('#pf-ocr').checked, languages: p.ocr.languages },
            speech: { enabled: p.type !== 'image' && q('#pf-speech').checked, model: q('#pf-model').value, language: q('#pf-lang').value, perWindow: q('#pf-window').checked },
            options: readOutput(), color: p.color, notes: p.notes || '', sourcePath,
          };
          return window.api.saveProject(form);
        },
      },
    ],
  });
  return res || null;
}
