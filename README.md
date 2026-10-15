# Convert Master

Windows için video, resim ve ses dönüştürücü; isteğe bağlı olarak konuşmayı metne çevirir. Mastertool ailesinin ([SSH Master](https://github.com/goktalay/sshmasters), [FTP Masters](https://github.com/goktalay/ftpmasters), SQL Master, Notepad Master) ortak arayüz yapısıyla.

## İndirme

Derlenmiş exe'ler [Releases](https://github.com/goktalay/convertmaster/releases) sayfasındadır ve [convertmaster.app](https://convertmaster.app) hesabınızdan indirilir:

- `Convert-Master-Setup-x.y.z.exe` — kurulum (varsayılan klasör `C:\Program Files\Mastertool\Convert Master`, Başlat menüsü › Master Tool › Convert Master)
- `Convert-Master-Portable-x.y.z.exe` — kurulumsuz, tek dosya

## Özellikler

- **Ana ekran:** proje kartları (tür rengi, `MKV → MP4`, kaynak yolu, dönüştürülen/hatalı sayısı), proje klasörleri (sürükle-bırak, iç içe), arama (Ctrl+F). Sağ üstte Mastertool düğmesi.
- **Yeni (Ctrl+N):** Proje ismi → **Tür** (Video / Resim / Ses) → **kaynak** ve **hedef** dosya uzantısı (yalnız o türün uzantıları) → **Dosya** ya da **Klasör** (dosya seçiminde yalnız o türün / seçili uzantıların dosyaları; klasörde alt klasörleri dahil etme seçeneği) → **aynı anda kaç dosya çevrileceği** → video ve seste **"Konuşmayı metne çevir?"** → Kaydet.
  - *Dönüştürme ayarları:* video — kalite, çözünürlük (yalnız küçültür), kare hızı, H.264/H.265, kodlama hızı, ses bit hızı, sesi kaldır; resim — kalite, en fazla genişlik/yükseklik, meta veriler; ses — bit hızı, örnekleme hızı, kanallar.
- **Proje penceresi** (projeye çift tıklayınca ayrı pencere):
  - Üstte **önizleme**: solda orijinal, sağda dönüştürülmüş dosya. Video/ses oynatıcı, iki önizlemeyi birlikte oynatma, sesler için dalga biçimi, boyut/kodek/süre bilgisi ve boyut farkı (%). Chromium'un doğrudan açamadığı biçimler (WMV, AVI, TIFF, WMA…) için kare/dalga biçimi ve tek tıkla 480p önizleme kopyası.
  - **▶ Başlat / ■ Durdur** (Ctrl+Enter).
  - **Dosya** projesinde tek dosyanın büyük ilerleme çubuğu.
  - **Klasör** projesinde solda klasör ve alt klasörler **ağaç** halinde (onay kutularıyla); işaretlenen kaynak dosyalar sağdaki **listeye** girer. Listedeki her dosya ayrı **İlerleme** sütunuyla dönüştürülür; Durum, Boyut, Çıktı boyutu ve (açıksa) Metin ilerlemesi sütunları; arama, durum süzgeci, sıralama.
  - Sağ tık: yeniden dönüştür, metne çevir, aç, klasörde göster, başka klasöre kopyala, dönüştürülmüş dosyayı sil, listeden çıkar.
  - Durum çubuğunda toplam ilerleme, çıktı boyutu ve "aynı anda" ayarı (anında değiştirilebilir).
- **Konuşmadan metne:** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) ile bu bilgisayarda, çevrimdışı. **Metin** panelinde 1. sütunda cümlenin geçtiği **saniye**, 2. sütunda **dil**, 3. sütunda **metin**; satıra tıklayınca önizleme o saniyeye gider, oynatırken geçerli cümle vurgulanır. Dil otomatik algılanır (ya da seçilir); "her 30 saniyede dili yeniden algıla" çok dilli kayıtlar içindir. SRT, WebVTT, TXT, CSV, JSON olarak dışa aktarılır. Modeller ilk kullanımda indirilir: Çok küçük (~75 MB), Temel (~142 MB, önerilen), Küçük (~466 MB), Orta (~514 MB), Large v3 Turbo (~547 MB).
- **Resimden metin (OCR):** resim projelerinde isteğe bağlı **"Resimdeki metni oku (OCR)"** seçeneği (varsayılan kapalı; konuşmadan metne de aynı şekilde isteğe bağlıdır — istenmezse hiç çalışmaz, model/dil verisi bile indirilmez). [Tesseract](https://github.com/tesseract-ocr/tesseract) (tesseract.js) ile bu bilgisayarda, çevrimdışı. **Metin (OCR)** panelinde satır no, okuma güveni (%) ve metin; satıra tıklayınca satırın yeri orijinal ve dönüştürülmüş resimde vurgulanır; "Tümünü kopyala"; TXT, CSV, JSON dışa aktarım. 21 dil (Türkçe, İngilizce, Almanca, Fransızca, İspanyolca, Arapça, Rusça, Çince, Japonca, Korece…); projede en çok 6 dil seçilir, her dilin verisi (~2–15 MB) ilk kullanımda bir kez indirilir. Metinsiz resimler "Metin yok" olarak işaretlenir.
- **Depolama:** tüm dönüştürülmüş dosyalar `%APPDATA%\Convert Master\converted\<proje>\` altında (kaynak klasör yapısıyla) geçici olarak tutulur; kaynak dosyalarınıza dokunulmaz. Proje bazında ya da Ayarlar › Depolama'dan toplu **"Çevrilmiş dosyaları sil"** (isteğe bağlı metinlerle birlikte), önizleme önbelleğini temizleme, model indirme/silme.
- **Mastertool hesabı:** uygulama Mastertool hesabıyla açılır; "Beni hatırla" (Windows DPAPI), çevrimdışı çalışma, kayıt / şifremi unuttum / hesabım sayfaları.
- **Ortak oturum (tek giriş):** herhangi bir Mastertool uygulamasında (SSH Master, FTP Masters, SQL Master, Notepad Master, Master Tool) bir kez giriş yapıldıysa Convert Master şifre sormadan açılır; birinde çıkış yapılınca hepsinde çıkış yapılır (yerel projeler ve dönüştürülmüş dosyalar silinmez; süren dönüştürme varsa "şimdi" ya da "bitince" çıkış sorulur). Ortak kimlik Windows Kimlik Bilgisi Yöneticisi'nde (`Mastertool/sso`), durum işareti `%APPDATA%\Mastertool\sso-state.json` dosyasındadır.
- **Uçtan uca şifreli senkron:** proje tanımları (ad, tür, uzantılar, kaynak türü, ayarlar), proje klasörleri ve genel ayarlar AES-256-GCM ile şifrelenip hesaba yedeklenir; anahtar şifrenizden cihazda türetilir (PBKDF2 + HKDF), sunucu içeriği okuyamaz. Dosyalar, kaynak yolları, seçimler, çıktılar ve metinler her cihazda ayrı kalır; başka cihazda açılan projede kaynak yeniden seçilir.
- Gece / Gündüz / Sistem teması (varsayılan Sistem); 8 dil: Türkçe, English, Français, Deutsch, Español, العربية (sağdan sola), 中文, Русский; Windows oturumuyla başlatma ve sistem tepsisi; yeni sürüm bildirimi ve Ayarlar › Hakkında › Güncellemeleri denetle.

## Desteklenen biçimler

| Tür | Kaynak | Hedef |
|---|---|---|
| Video | mp4 mkv avi mov wmv webm flv m4v mpg mpeg ts mts m2ts 3gp ogv vob | mp4 mkv webm avi mov wmv flv m4v mpg 3gp ogv · animasyonlu gif · yalnız ses: mp3 m4a wav flac ogg opus |
| Resim | jpg jpeg png webp avif gif bmp tif tiff ico svg tga | jpg png webp avif gif bmp tiff ico |
| Ses | mp3 wav flac aac m4a ogg oga opus wma aiff aif amr ac3 mka ape wv | mp3 wav flac aac m4a ogg opus wma aiff ac3 |

Kodekler: MP4/MKV/MOV/M4V/FLV/3GP → H.264 (isteğe bağlı H.265) + AAC; WebM → VP9 + Opus; AVI → Xvid + MP3; WMV → WMV2 + WMA; MPG → MPEG-2 + MP2; OGV → Theora + Vorbis.

## Veriler

`%APPDATA%\Convert Master\`:

- `store.json` — projeler, klasörler, ayarlar; `local` bölümünde cihaza özgü kaynak yolları ve seçimler
- `account.json` — oturum (DPAPI ile şifreli)
- `converted\<projeId>\` — dönüştürülmüş dosyalar
- `work\<projeId>\state.json` — dosya durumları; `work\<projeId>\speech\` — metinler
- `cache\preview\` — önizleme kareleri, dalga biçimleri, önizleme kopyaları (14 gün kullanılmayan silinir)
- `models\` — konuşma modelleri; `ocr\` — OCR dil verileri; `engines\whisper\` — (kurulumla gelmediyse) indirilen whisper.cpp

## Geliştirme

```bash
npm install
npm start
```

Sahte hesap sunucusuyla (test@example.com / Test1234!):

```bash
node test/mock-server.js 8787
```

```bash
CVM_API=http://127.0.0.1:8787 npm start
```

Testler (dönüştürme motoru, senkron, ortak oturum, çalıştırıcı, konuşma modülü — whisper taklidiyle —, gerçek Tesseract ile OCR):

```bash
npm test
```

Ortam değişkenleri: `CVM_API` (hesap sunucusu), `CVM_OCR_LANG_BASE` (OCR dil verisi kaynağı; testlerde `node_modules/@tesseract.js-data`), `CVM_FFMPEG` (başka bir ffmpeg), `CVM_WHISPER_CLI` (yerel whisper-cli; Windows dışında konuşma için gerekir), `CVM_WHISPER_VERSION`.

## Exe derleme

```bash
npm run dist
```

`scripts/fetch-whisper.js` whisper.cpp'nin Windows ikilisini `vendor/whisper` altına indirir, electron-builder kurulumun içine koyar. İkonu değiştirmek için `build/icon.svg` dosyasını düzenleyip `npm run icon` çalıştırın.

## Sürüm yayınlama

Yeni sürüm için bir etiket göndermek yeterli. GitHub Actions testleri çalıştırır, exe'leri derleyip Release'e ekler:

```bash
git tag v1.0.0
```

```bash
git push origin v1.0.0
```

Sürüm numarası etiketten alınır. Etiketle yayınlanan sürüm ayrıca convertmaster.app'e yüklenir (`scripts/upload-convertmaster.sh`, parçalı; depo secret'ı `CONVERTM_RELEASE_KEY`).

## Lisanslar ve üçüncü taraf bileşenler

Convert Master MIT lisanslıdır. Birlikte dağıtılan bileşenler:

- **FFmpeg** — [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) üzerinden gelen derleme **GPL** lisanslıdır (libx264, libx265 gibi GPL bileşenleri içerir). FFmpeg ayrı bir program olarak çalıştırılır; kaynak kodu https://ffmpeg.org adresindedir. Dağıtımda FFmpeg lisansına (GPL v3) uyulmalıdır.
- **sharp / libvips** — Apache-2.0 / LGPL-3.0.
- **tesseract.js / Tesseract OCR** — Apache-2.0; dil verileri (tessdata) Apache-2.0.
- **whisper.cpp** — MIT. **Whisper modelleri** (OpenAI) — MIT; ggml dönüşümleri Hugging Face › ggerganov/whisper.cpp'den indirilir.
- **@napi-rs/keyring** — MIT (Windows Kimlik Bilgisi Yöneticisi erişimi, ortak oturum).
- **Electron / Chromium** — MIT ve Chromium lisansları.

## Bilinen sınırlar

- HEIC/HEIF resimler desteklenmez.
- Konuşmadan metne işlemci (CPU) ile çalışır; uzun kayıtlarda büyük modeller yavaştır.
- Durdurulan dönüştürmeler kaldığı yerden değil baştan başlar.
