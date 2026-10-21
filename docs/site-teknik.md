# Convert Master — teknik bilgi föyü

Bu föydeki her bilgi uygulamanın kaynak kodundan ve derleme çıktısından doğrulanmıştır (sürüm 1.0.0 ve sonrası, `main` dalı). Yayınlanmamış özellikler "Sürüm geçmişi"nde ayrıca belirtilir.

## Sistem gereksinimleri

- **İşletim sistemi:** Windows 10 veya 11, 64 bit (x64). Derlemeler yalnız x64 için üretilir.
- **Kurulum:** `Convert-Master-Setup-<sürüm>.exe` (~112 MB) ya da kurulumsuz `Convert-Master-Portable-<sürüm>.exe` (~112 MB).
  - Tüm kullanıcılar: `C:\Program Files\Mastertool\Convert Master`
  - Yalnız bu kullanıcı: `%LOCALAPPDATA%\Programs\Mastertool\Convert Master`
  - Başlat menüsü: **Master Tool › Convert Master**; masaüstü kısayolu.
- **Ek disk:** konuşma modelleri (75–547 MB, istenen model) ve OCR dil verileri (dil başına birkaç MB) yalnız kullanılırsa indirilir. Dönüştürülmüş dosyalar `%APPDATA%\Convert Master` altında tutulur.
- **Hesap:** Mastertool hesabı (giriş zorunlu). İlk girişten sonra "Beni hatırla" ile çevrimdışı da açılır.

## Teknoloji

| Bileşen | Sürüm | Görevi |
|---|---|---|
| Electron | 33.4.11 (Chromium 130.0.6723.191, Node.js 20.18.3) | Masaüstü uygulama, önizleme oynatıcısı |
| FFmpeg (ffmpeg-static) | 6.1.1 (Windows, GPL derlemesi) | Video ve ses dönüştürme, önizleme kareleri, dalga biçimi, konuşma için 16 kHz WAV |
| sharp / libvips | 0.33.5 / 8.15.3 | Resim dönüştürme (JPG, PNG, WEBP, AVIF, GIF, TIFF; SVG okuma) |
| whisper.cpp | 1.7.6 (`whisper-cli`, CPU) | Konuşmadan metne, çevrimdışı |
| Whisper modelleri (ggml) | tiny · base · small · medium-q5_0 · large-v3-turbo-q5_0 | Konuşma tanıma modeli (seçilen indirilir) |
| tesseract.js | 7.0.0 (Tesseract, WebAssembly, LSTM) | Resimden metin (OCR), çevrimdışı |

Tüm işleme bu bilgisayarda yapılır. Dönüştürme ve konuşma tanıma işlemciyle (CPU) çalışır; **GPU hızlandırma yoktur**. Önizlemede videoyu Chromium oynatır.

## Biçimler

### Video

- **Giriş (16):** mp4, mkv, avi, mov, wmv, webm, flv, m4v, mpg, mpeg, ts, mts, m2ts, 3gp, ogv, vob
- **Çıkış (18):** mp4, mkv, webm, avi, mov, wmv, flv, m4v, mpg, 3gp, ogv · animasyonlu **gif** · yalnız ses: mp3, m4a, wav, flac, ogg, opus

| Hedef | Video kodeği | Ses kodeği |
|---|---|---|
| MP4, MKV, MOV, M4V | H.264 (libx264) ya da isteğe bağlı H.265/HEVC (libx265) | AAC |
| FLV | H.264 | AAC, 44,1 kHz |
| 3GP | H.264 (baseline profil) | AAC |
| WEBM | VP9 (libvpx-vp9) | Opus |
| AVI | Xvid (MPEG-4 Part 2) | MP3 |
| WMV | WMV2 | WMA (wmav2) |
| MPG | MPEG-2 | MP2 |
| OGV | Theora | Vorbis |
| GIF | Palet üretimli animasyon (palettegen/paletteuse) | — |

Video ayarları:

- **Kalite:** Yüksek / Orta (önerilen) / Düşük — H.264 CRF 18 / 23 / 28, H.265 CRF 22 / 28 / 32, VP9 CRF 24 / 32 / 40; Xvid/MPEG-2/WMV2 `-q:v` 2 / 4 / 7; Theora 9 / 7 / 5.
- **Çözünürlük:** kaynakla aynı, 2160p, 1440p, 1080p, 720p, 480p, 360p — yalnız küçültür (kısa kenar sınırlanır, dikey videolar dahil), boyutlar çift sayıya yuvarlanır.
- **Kare hızı:** kaynakla aynı, 60, 50, 30, 25, 24, 15 fps.
- **Kodlama hızı:** çok hızlı, hızlı, dengeli, yavaş.
- **Ses bit hızı:** 64–320 kbps (64, 96, 128, 160, 192, 256, 320). **Sesi kaldır** seçeneği.
- MP4/MOV/M4V çıktılarında hızlı başlatma (`+faststart`); meta veriler kopyalanır; ilk video ve ilk ses akışı alınır.
- **GIF:** 15 / 12 / 10 kare/sn (kaliteye göre; en çok 30), genişlik varsayılan 480 px ya da seçilen çözünürlük.

### Resim

- **Giriş (12):** jpg, jpeg, png, webp, avif, gif, bmp, tif, tiff, ico, svg, tga
- **Çıkış (8):** jpg, png, webp, avif, gif, bmp, tiff, ico
- **Ayarlar:** kalite 1–100 (JPG mozjpeg, WEBP, AVIF, TIFF; PNG kayıpsız, 80 altı renk paleti), en fazla genişlik / yükseklik (en-boy oranı korunur, büyütme yok), meta verileri koru (EXIF, renk profili; varsayılan kapalı).
- Animasyonlu GIF ↔ WEBP animasyonu korunur. EXIF yönü otomatik uygulanır. SVG 300 dpi ile işlenir. ICO en çok 256×256. BMP, ICO, TGA gibi sharp'ın okuyamadığı ya da yazamadığı biçimler FFmpeg ile işlenir.
- HEIC/HEIF desteklenmez.

### Ses

- **Giriş (16):** mp3, wav, flac, aac, m4a, ogg, oga, opus, wma, aiff, aif, amr, ac3, mka, ape, wv
- **Çıkış (10):** mp3 (LAME), wav (PCM 16 bit), flac, aac (ADTS), m4a (AAC), ogg (Vorbis), opus, wma, aiff (PCM 16 bit), ac3
- **Ayarlar:** bit hızı 64–320 kbps (WAV, FLAC, AIFF kayıpsız), örnekleme hızı (kaynak, 48 / 44,1 / 32 / 22,05 / 16 kHz; Opus uyumsuz hızları 48 kHz'e çeker), kanallar (kaynak, stereo, mono).

## Konuşmadan metne

- **İsteğe bağlıdır** (video ve ses projelerinde "Konuşmayı metne çevir"; varsayılan kapalı). Kapalıysa çalışmaz, model indirilmez.
- **Motor:** whisper.cpp 1.7.6, çevrimdışı; ses hiçbir sunucuya gönderilmez. Girdi FFmpeg ile 16 kHz mono WAV'a çevrilir. İş parçacığı sayısı: işlemci çekirdeği − 1 (en çok 8).
- **Modeller** (ilk kullanımda indirilir, Ayarlar'dan önceden indirilip silinebilir):

  | Model | Dosya | Yaklaşık boyut |
  |---|---|---|
  | Çok küçük (en hızlı) | ggml-tiny.bin | 75 MB |
  | Temel (önerilen) | ggml-base.bin | 142 MB |
  | Küçük | ggml-small.bin | 466 MB |
  | Orta | ggml-medium-q5_0.bin | 514 MB |
  | Large v3 Turbo (en doğru) | ggml-large-v3-turbo-q5_0.bin | 547 MB |

- **Dil:** otomatik algılama ya da listeden seçim — Türkçe, İngilizce, Almanca, Fransızca, İspanyolca, İtalyanca, Portekizce, Felemenkçe, Rusça, Ukraynaca, Arapça, Farsça, Azerbaycanca, Yunanca, Bulgarca, Romence, Lehçe, Çekçe, Macarca, İsveççe, Norveççe, Danca, Fince, Çince, Japonca, Korece, Hintçe, Urduca, Endonezce, Malayca, Tayca, Vietnamca, İbranice (33 dil + otomatik).
- **Her 30 saniyede dili yeniden algıla:** çok dilli kayıtlar için; kayıt 30 sn'lik pencerelere bölünür, her pencerenin dili ayrı algılanır.
- **Metin paneli:** 1. sütun cümlenin geçtiği saniye, 2. sütun dil, 3. sütun metin. Satıra tıklayınca önizleme o saniyeye sarılır; oynatırken geçerli cümle vurgulanır.
- **Dışa aktarım:** SRT, WebVTT, TXT, CSV (UTF-8 BOM, `;` ayraçlı), JSON.
- Sessiz dosyalar "Ses yok" olarak işaretlenir.

## Resimden metin (OCR)

- **İsteğe bağlıdır** (resim projelerinde "Resimdeki metni oku (OCR)"; varsayılan kapalı). Kapalıysa çalışmaz, dil verisi indirilmez.
- **Motor:** tesseract.js 7 (Tesseract LSTM, WebAssembly), çevrimdışı; resimler hiçbir sunucuya gönderilmez. Her biçim önce PNG'ye çevrilir (SVG, AVIF, ICO, TGA dahil).
- **21 dil:** Türkçe, İngilizce, Almanca, Fransızca, İspanyolca, İtalyanca, Portekizce, Felemenkçe, Rusça, Ukraynaca, Arapça, Farsça, İbranice, Azerbaycanca, Yunanca, Lehçe, Basitleştirilmiş Çince, Geleneksel Çince, Japonca, Korece, Hintçe. Bir projede **en çok 6 dil** birlikte okunur (varsayılan Türkçe + İngilizce).
- **Dil verisi:** her dil ilk kullanımda bir kez indirilir (Tesseract "best_int" verisi; örneğin Türkçe ~2,1 MB, İngilizce ~3,0 MB indirme) ve `%APPDATA%\Convert Master\ocr` altına açılır; Ayarlar › Resimden metin (OCR) bölümünden indirilip silinebilir.
- **Metin (OCR) paneli:** satır no, okuma güveni (%) ve metin. Satıra tıklayınca satırın yeri orijinal ve dönüştürülmüş resimde vurgulanır. "Tümünü kopyala".
- **Dışa aktarım:** TXT, CSV, JSON (JSON satır koordinatlarını da içerir).
- Metin bulunmayan resimler "Metin yok" olarak işaretlenir.

## Performans ve sınırlar

- **Aynı anda çevrilecek dosya:** proje başına 1–32 (yeni projelerde varsayılan 2; Ayarlar'dan değiştirilir). Proje penceresinin durum çubuğundan anında değiştirilebilir.
- **Aynı anda metne çevrilecek dosya** (konuşma ya da OCR): 1–4, varsayılan 1.
- Büyük klasörler: ağaç ve liste yalnız görünen satırları çizer (binlerce dosya). Gizli dosyalar (`.` ya da `$` ile başlayan) taranmaz.
- **Durdur:** süren işlemler hemen sonlandırılır, yarım çıktı silinir; durdurulan dosya bir sonraki Başlat'ta baştan dönüştürülür (kaldığı yerden devam yok).
- Kaynak dosya değişirse (boyut ya da tarih) sonucu geçersiz sayılır ve yeniden dönüştürülür.
- Aynı klasörde yalnız uzantısı farklı iki kaynak (ör. `a.mkv`, `a.avi`) çıktıda çakışmaz: `a_mkv.mp4`, `a_avi.mp4`.
- Önizleme: Chromium'un doğrudan oynatamadığı biçimler için kare ve tek tıkla 480p H.264 önizleme kopyası; ses için dalga biçimi ve gerekirse MP3 kopyası; TIFF/TGA gibi resimler için PNG önizleme (en çok 2400 px).
- GPU hızlandırma yoktur; dönüştürme ve konuşma tanıma işlemciyle yapılır.

## Depolama

`%APPDATA%\Convert Master\`:

| Yol | İçerik |
|---|---|
| `converted\<proje>\` | Dönüştürülmüş dosyalar (kaynak klasör yapısıyla) |
| `work\<proje>\state.json` | Dosya durumları |
| `work\<proje>\speech\`, `work\<proje>\ocr\` | Konuşma metinleri, OCR sonuçları |
| `cache\preview\` | Önizleme kareleri, dalga biçimleri, önizleme kopyaları (14 gün kullanılmayan silinir) |
| `models\` | Konuşma modelleri |
| `ocr\` | OCR dil verileri |
| `engines\whisper\` | Kurulumla gelmediyse indirilen whisper.cpp |
| `store.json`, `account.json` | Projeler ve ayarlar; oturum (Windows DPAPI ile şifreli) |

Kaynak dosyalarınıza hiç dokunulmaz. Temizleme: proje kartında ya da proje penceresinde **Çevrilmiş dosyaları sil**, Ayarlar › Depolama'da tüm projeler için toplu silme (isteğe bağlı metinlerle birlikte) ve önizleme önbelleğini temizleme; boyutlar orada görünür. Dönüştürülmüş dosyalar istenirse başka bir klasöre kopyalanabilir (klasör yapısıyla).

## Güvenlik ve gizlilik

- Dönüştürme, konuşmadan metne ve OCR **tamamen bu bilgisayarda** yapılır; dosyalar, sesler ve resimler hiçbir sunucuya gönderilmez.
- Ağ yalnız şu durumlarda kullanılır:
  - Mastertool hesabına giriş, uçtan uca şifreli senkron ve yeni sürüm denetimi (convertmaster.app; ulaşılamazsa mastertool.download),
  - konuşma modeli indirme (Hugging Face › ggerganov/whisper.cpp) ve kurulumda yoksa whisper.cpp indirme (GitHub),
  - OCR dil verisi indirme (jsDelivr › @tesseract.js-data),
  - hesap sayfaları ve Mastertool düğmesi (varsayılan tarayıcıda açılır).
  İndirmeler Windows proxy ayarlarına uyar.
- **Senkron:** yalnız proje tanımları (ad, tür, uzantılar, ayarlar), proje klasörleri ve genel ayarlar gönderilir; dosyalar, kaynak yolları, seçimler, çıktılar ve metinler gönderilmez. Veriler gönderilmeden önce şifrelenir: anahtar şifrenizden cihazda türetilir (PBKDF2-SHA256, 310 000 tur + HKDF-SHA256), içerik AES-256-GCM ile şifrelenir; sunucu içeriği okuyamaz. Senkron kapatılabilir ve sunucudaki kopya silinebilir.
- Oturum bilgisi Windows DPAPI (Electron safeStorage) ile şifrelenir. Pencereler bağlam yalıtımıyla (contextIsolation) çalışır; yerel dosyalar önizlemeye yalnız ana sürecin kaydettiği adreslerle (cvm://) açılır.

## Klavye kısayolları

| Kısayol | Pencere | İşlev |
|---|---|---|
| Ctrl+N | Ana | Yeni proje |
| Ctrl+F | Ana | Projelerde ara |
| Enter | Ana | Seçili projeyi aç |
| F2 | Ana | Proje ayarları |
| Delete | Ana | Projeyi sil |
| Backspace | Ana | Üst klasöre dön |
| Esc | Ana | Aramayı temizle |
| Ctrl+Enter | Proje | Başlat / Durdur |
| F5 | Proje | Kaynağı yeniden tara |
| ↑ / ↓ | Proje | Listede önceki / sonraki dosya |
| Enter | Proje | Dosyayı aç (dönüştürüldüyse çıktıyı) |
| Enter / Esc | Pencereler | Onayla / kapat |

## Diller ve görünüm

- **Arayüz dilleri (8):** Türkçe, English, Français, Deutsch, Español, العربية (sağdan sola), 中文, Русский. İlk açılışta Windows dili listedeyse o, değilse İngilizce.
- Arapçada pencere sağdan sola; dosya yolları, uzantılar ve metin tabloları soldan sağa kalır.
- **Tema:** Gece / Gündüz / Sistem tercihi (varsayılan Sistem).
- **Başlangıç:** Windows oturumu açılınca başlat, küçültünce sistem tepsisi, kapatınca tepsiye gizle (isteğe bağlı).

## Sürüm geçmişi

### Yayınlanmamış (main)

- **Kalite ve boyut** (video ve resim): platform hazır ayarları (YouTube 16:9, Reels/TikTok/Shorts 9:16 1080×1920, Instagram 4:5 ve 1:1, WhatsApp, e-posta, arşiv; resimde Instagram, hikâye, YouTube küçük resmi, profil fotoğrafı, web), en-boy oranı (16:9, 9:16, 1:1, 4:5, 4:3, 3:4, 21:9, özel), sığdır (siyah/beyaz/bulanık/saydam dolgu) / kırp / uzat, 90°/180° döndürme, canlı çıktı boyutu.

### 1.1.0 — 16 Ekim 2026

- **Ortak oturum (tek giriş):** herhangi bir Mastertool uygulamasında bir kez giriş yapıldıysa Convert Master şifre sormadan açılır; birinde çıkış yapılınca hepsinde çıkış yapılır (yerel veriler korunur; süren dönüştürmede "şimdi / bitince" sorulur). Ortak kimlik Windows Kimlik Bilgisi Yöneticisi'nde. İkinci kez çalıştırma (Master Tool tepsisi) gizli pencereyi gösterir.
- **Resimden metin (OCR)**, isteğe bağlı: tesseract.js 7, 21 dil, projede en çok 6 dil; satır · güven · metin paneli, satırın resimde vurgulanması, Tümünü kopyala, TXT/CSV/JSON.
- Konuşmadan metne ve OCR seçenekleri ayrı ayrı; ikisi de varsayılan kapalı.
- Önizleme: büyük resim ve videolar alana sığdırılıyor (önceden kırpılabiliyordu).

### 1.0.0 — 15 Ekim 2026

- İlk sürüm: video (16 giriş / 18 çıkış), resim (12 / 8), ses (16 / 10) dönüştürme; dosya ve klasör projeleri, klasör ağacı ve satır başına ilerleme, aynı anda 1–32 dosya.
- Yan yana önizleme (orijinal | dönüştürülmüş), birlikte oynatma, önizleme kopyası.
- Çevrimdışı konuşmadan metne (whisper.cpp), 30 sn'de dil algılama, SRT/VTT/TXT/CSV/JSON.
- Mastertool hesabı, uçtan uca şifreli senkron, 8 dil, gece/gündüz/sistem teması, tepsi ve oturumla başlatma, güncelleme denetimi.
