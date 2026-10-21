// Desteklenen türler ve uzantılar. Hem ana süreçte (require) hem pencerelerde (<script>) çalışır.
// "source": kaynak olarak seçilebilen uzantılar, "target": hedef uzantılar.
// "play": Chromium'un (Electron) doğrudan önizleyebildiği uzantılar; diğerleri için önizleme üretilir.
(function (root) {
  'use strict';

  const TYPES = {
    video: {
      color: '#a855f7',
      source: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv', 'vob'],
      // Hedefler: video kapları, animasyonlu GIF ve (yalnız ses çıkarma) ses biçimleri
      target: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', '3gp', 'ogv', 'gif', 'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'],
      audioOnlyTargets: ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'],
      play: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv'],
      defaultSource: ['mkv', 'avi', 'mov', 'wmv'],
      defaultTarget: 'mp4',
    },
    image: {
      color: '#34d399',
      source: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'svg', 'tga'],
      target: ['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'ico'],
      play: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'ico', 'svg'],
      defaultSource: ['png', 'bmp', 'tif', 'tiff'],
      defaultTarget: 'jpg',
    },
    audio: {
      color: '#f97316',
      source: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'amr', 'ac3', 'mka', 'ape', 'wv'],
      target: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'ac3'],
      play: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'oga', 'opus', 'webm'],
      defaultSource: ['wav', 'flac', 'wma', 'm4a'],
      defaultTarget: 'mp3',
    },
  };

  // Konuşmadan metne (whisper.cpp) modelleri: ilk kullanımda indirilir
  const SPEECH_MODELS = {
    // mb: yaklaşık indirme boyutu (yalnız bilgi amaçlı; doğrulama sunucunun Content-Length'iyle yapılır)
    tiny: { file: 'ggml-tiny.bin', mb: 75 },
    base: { file: 'ggml-base.bin', mb: 142 },
    small: { file: 'ggml-small.bin', mb: 466 },
    medium: { file: 'ggml-medium-q5_0.bin', mb: 514 },
    turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', mb: 547 },
  };

  // Whisper'ın tanıdığı dillerden sık kullanılanlar (konuşma dili seçimi için; "auto" = algıla)
  const SPEECH_LANGS = ['auto', 'tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'uk', 'ar', 'fa', 'az', 'el', 'bg', 'ro', 'pl', 'cs', 'hu',
    'sv', 'no', 'da', 'fi', 'zh', 'ja', 'ko', 'hi', 'ur', 'id', 'ms', 'th', 'vi', 'he'];

  // Resimden metin (OCR, Tesseract) dilleri — Tesseract kodları; ilk kullanımda indirilir
  const OCR_LANGS = ['tur', 'eng', 'deu', 'fra', 'spa', 'ita', 'por', 'nld', 'rus', 'ukr', 'ara', 'fas', 'heb', 'aze', 'ell', 'pol',
    'chi_sim', 'chi_tra', 'jpn', 'kor', 'hin'];
  // Tesseract kodu → ISO 639-1 (dil adını göstermek için)
  const OCR_ISO = { tur: 'tr', eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', rus: 'ru', ukr: 'uk', ara: 'ar',
    fas: 'fa', heb: 'he', aze: 'az', ell: 'el', pol: 'pl', chi_sim: 'zh-Hans', chi_tra: 'zh-Hant', jpn: 'ja', kor: 'ko', hin: 'hi' };

  const QUALITY = ['high', 'medium', 'low'];
  const RESOLUTIONS = ['source', '2160', '1440', '1080', '720', '480', '360'];
  const FPS = ['source', '60', '50', '30', '25', '24', '15'];
  const AUDIO_BITRATES = ['64', '96', '128', '160', '192', '256', '320'];
  const SAMPLE_RATES = ['source', '48000', '44100', '32000', '22050', '16000'];

  // Kalite ve boyut: en-boy oranı, sığdırma, döndürme ve hazır ayarlar (video ve resim)
  const ASPECTS = ['source', '16:9', '9:16', '1:1', '4:5', '4:3', '3:4', '21:9', 'custom'];
  const FITS = ['pad', 'crop', 'stretch'];
  const PAD_COLORS = ['black', 'white', 'blur', 'transparent']; // saydam yalnız resimde
  const ROTATIONS = ['0', '90', '270', '180'];
  const IMAGE_SIZES = ['source', '3840', '2160', '1440', '1080', '720', '480', '400'];

  // Çıktı karesi (W×H). aspect "source" ise null (yalnız sınırla/küçült). Kısa kenar: video'da resolution,
  // resimde size; "source" ise kaynağın kısa kenarı. even: video kodlayıcıları çift boyut ister.
  function frameSize(o, sw, sh, even) {
    if (!o || !o.aspect || o.aspect === 'source') return null;
    const rot = Number(o.rotate) || 0;
    if (rot === 90 || rot === 270) [sw, sh] = [sh, sw];
    const fix = (n) => (even ? Math.max(2, Math.round(n / 2) * 2) : Math.max(1, Math.round(n)));
    if (o.aspect === 'custom') {
      const W = Number(o.width) || 0;
      const H = Number(o.height) || 0;
      return W && H ? { W: fix(W), H: fix(H) } : null;
    }
    const [a, b] = o.aspect.split(':').map(Number);
    const key = o.resolution !== undefined ? o.resolution : o.size;
    let short = key && key !== 'source' ? Number(key) : Math.min(sw || 0, sh || 0);
    if (!short) short = 1080;
    return a >= b ? { W: fix(short * a / b), H: fix(short) } : { W: fix(short), H: fix(short * b / a) };
  }

  // Hazır ayarlar: seçilince ilgili alanları doldurur (sonra elle değiştirilebilir)
  const PRESET_BASE = {
    video: { aspect: 'source', fit: 'pad', padColor: 'black' },
    image: { aspect: 'source', size: 'source', fit: 'crop', padColor: 'white', maxWidth: 0, maxHeight: 0 },
  };
  const PRESETS = {
    video: [
      { id: 'youtube', o: { aspect: '16:9', resolution: '1080', fit: 'pad', padColor: 'black', quality: 'medium', fps: 'source' } },
      { id: 'youtube4k', o: { aspect: '16:9', resolution: '2160', fit: 'pad', padColor: 'black', quality: 'high', fps: 'source' } },
      { id: 'reels', o: { aspect: '9:16', resolution: '1080', fit: 'pad', padColor: 'blur', quality: 'medium', fps: '30' } },
      { id: 'igpost', o: { aspect: '4:5', resolution: '1080', fit: 'pad', padColor: 'blur', quality: 'medium', fps: '30' } },
      { id: 'square', o: { aspect: '1:1', resolution: '1080', fit: 'pad', padColor: 'blur', quality: 'medium', fps: '30' } },
      { id: 'whatsapp', o: { resolution: '720', quality: 'low', fps: '30', audioBitrate: '128' } },
      { id: 'email', o: { resolution: '480', quality: 'low', fps: '25', audioBitrate: '96' } },
      { id: 'archive', o: { resolution: 'source', quality: 'high', fps: 'source', speed: 'slow', audioBitrate: '256' } },
    ],
    image: [
      { id: 'igsquare', o: { aspect: '1:1', size: '1080', fit: 'crop', quality: 90 } },
      { id: 'igportrait', o: { aspect: '4:5', size: '1080', fit: 'crop', quality: 90 } },
      { id: 'story', o: { aspect: '9:16', size: '1080', fit: 'pad', padColor: 'blur', quality: 90 } },
      { id: 'ytthumb', o: { aspect: '16:9', size: '720', fit: 'crop', quality: 90 } },
      { id: 'profile', o: { aspect: '1:1', size: '400', fit: 'crop', quality: 90 } },
      { id: 'web', o: { maxWidth: 1920, quality: 80 } },
      { id: 'small', o: { maxWidth: 1280, maxHeight: 1280, quality: 70 } },
    ],
  };
  function applyPreset(type, cur, id) {
    const pr = (PRESETS[type] || []).find((x) => x.id === id);
    if (!pr) return { ...cur, preset: 'custom' };
    return { ...cur, ...PRESET_BASE[type], ...pr.o, preset: id };
  }

  const extOf = (p) => {
    const m = /\.([^./\\]+)$/.exec(String(p || ''));
    return m ? m[1].toLowerCase() : '';
  };

  function typeOfExt(ext) {
    for (const [k, v] of Object.entries(TYPES)) if (v.source.includes(ext)) return k;
    return null;
  }

  // Bir proje için varsayılan dönüştürme seçenekleri
  function defaultOptions() {
    return {
      video: { preset: 'custom', quality: 'medium', resolution: 'source', fps: 'source', codec: 'h264', speed: 'medium', audioBitrate: '192', noAudio: false,
        aspect: 'source', fit: 'pad', padColor: 'black', width: 1920, height: 1080, rotate: '0' },
      image: { preset: 'custom', quality: 85, maxWidth: 0, maxHeight: 0, keepMeta: false,
        aspect: 'source', size: 'source', fit: 'crop', padColor: 'white', width: 1080, height: 1080, rotate: '0' },
      audio: { bitrate: '192', sampleRate: 'source', channels: 'source' },
    };
  }

  function defaultSpeech() {
    return { enabled: false, model: 'base', language: 'auto', perWindow: false };
  }

  // Resim projelerinde OCR (varsayılan kapalı; istenirse açılır)
  function defaultOcr() {
    return { enabled: false, languages: ['tur', 'eng'] };
  }

  const api = { TYPES, SPEECH_MODELS, SPEECH_LANGS, OCR_LANGS, OCR_ISO, defaultOcr, QUALITY, RESOLUTIONS, FPS, AUDIO_BITRATES, ASPECTS, FITS, PAD_COLORS, ROTATIONS, IMAGE_SIZES, PRESETS, frameSize, applyPreset, SAMPLE_RATES, extOf, typeOfExt, defaultOptions, defaultSpeech };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FORMATS = api;
})(typeof self !== 'undefined' ? self : this);
