<p align="center">
  <img src="docs/brand/banner.svg" alt="ekip: tek terminal, bir Claude, koca bir ekip" width="100%">
</p>

<p align="center">
  <b>Tek bir Claude Code oturumunu ekip liderine dönüştürün.</b><br>
  Claude planlar ve inceler. Diğer kotalardaki agent'lar işleri yapar; her biri projenin kendi belleğiyle başlar.
</p>

<p align="center">
  <a href="README.md">English</a> · <b>Türkçe</b>
</p>

<p align="center">
  <img src="docs/demo/panel-demo.gif" alt="ekip paneli: adımları ve takılmalarıyla canlı görevler, projeler arasında çalışmalar, kotalarıyla worker havuzları ve kod haritası" width="100%">
</p>

> [!NOTE]
> **Durum:** v1.1; yazarı tarafından 15 projede her gün kullanılıyor. Öncelik macOS'ta; hub, Docker ile herhangi bir Linux VPS'te çalışır.

## Neden?

Claude Code kotasının çoğu **okumaya** gider: dosyalar, loglar, geçmiş ve her oturumda aynı bağlamı yeniden okumak. ekip, işleri kimin yaptığını değiştirir:

- **Kararları yalnızca Claude verir.** İsteği anlar, parçalara ayırır, her parça için bir worker seçer ve sonucu inceler. Okuma ve yazma işlerini **başka kotalardaki** agent'lar üstlenir: Antigravity, Codex, Copilot ve tek bir uç noktanın arkasındaki yaklaşık 60 ücretsiz model.
- **Bağlam bir kez hazırlanır.** Her projenin bir belleği olur: vektör veritabanındaki geçmiş oturumlar, dokümanlarından oluşturulmuş bir LLM wiki'si, kod grafiği ve projeye özel beceriler. Worker'lar repo'yu yeniden okumak yerine bunlarla işe başlar.
- **Her şeyi görürsünüz.** Her worker'a bir terminal paneli ayrılır, her istek canlı adımları olan bir göreve dönüşür; web panelinde çalışmaları, kotaları ve yeni bir görevin hangi modele yönlendirileceğini görürsünüz.

<p align="center"><img src="docs/assets/savings.svg" alt="ekip savings ile ölçülen, Claude dışında yürüyen iş payı: iki günlük kurulumda %58, ertesi gün %81" width="100%"></p>

> [!TIP]
> **%58 en kötü durumdu:** ekip'in kendisini geliştirmek ve 15 projeyi ilk kez indekslemekle geçen iki gün; bu işleri yalnızca lider yapabilirdi. **Ertesi gün oran %81 oldu.**
> Kendi işinde `ekip savings` ile ölç: Claude oturumlarını, worker loglarını ve ücretsiz havuzu gün gün okur.

## Nasıl çalışır?

<p align="center"><img src="docs/assets/how-it-works.svg" alt="Tek bir Claude liderine konuşursunuz. İşin her parçasını Antigravity, Codex, Copilot veya ücretsiz havuza yönlendirir. Her worker proje belleğinden başlar: bilgiler, wiki, kod grafiği ve beceriler. İsteğe bağlı VPS hub belleği, ücretsiz havuzu ve iş kuyruğunu çalışır durumda tutar." width="100%"></p>

```text
sen   › iki tanıtım videosu hazırla, storefront-web'de kalanları düzelt, payments-api'ye passkey ekle
lider › 3 görev · videolar → Antigravity + film becerisi · storefront düzeltmesi → Codex + proje belleği · passkey'ler → Copilot
        diff'leri ve render'ları inceler, nelerin teslim edildiğini, doğrulandığını ve kaldığını bildirir
```

## Devam eden projelere katılır

Sıfırdan başlamazsınız. ekip bir projeyi kaydettiğinde o projeye ait **eski Claude Code oturumlarınızı** içe aktarır, kodu bir grafiğe indeksler, dokümanlarından bir **wiki** oluşturur ve **becerileri** çıkarır (projenin nasıl derlendiği, yayınlandığı ve sık karşılaşılan sorunların nasıl çözüldüğü). Verdiğiniz ilk görev bile daha önce aldığınız tüm kararları hesaba katar.

Tekrarlanan işler proje için gerçek bir Claude Code skill'ine dönüşebilir: `ekip skill learn PROJE`
çalıştırma geçmişini inceler ve `SKILL.md` adaylarını kaydeder. `ekip skill candidates` ile gözden
geçirin, `ekip skill accept PROJE AD` ile açıkça projeye ekleyin. `ekip skill prune PROJE` yalnızca
eskimiş TencentDB skill'lerini raporlar; yerel skill dosyalarını silmez.

## Mesajınızla birlikte gelen bellek

`ekip review [--project NAME] [--base REF]` ilgili proje kontrollerini ve değişen dosyalar için iki salt okunur incelemeyi çalıştırır. Yalnızca kontroller için `--checks-only`, proje inceleme profilini yenilemek için `ekip review profile NAME --refresh` kullanın.

Herhangi bir klasörde Claude'u açıp bir projeden söz edin, yazım hatası olsa bile ekip projeyi bulur, mesajınız için o projenin belleğinde arama yapar ve gerekli bilgileri yaklaşık bir saniyede ekler.

<p align="center"><img src="docs/assets/memory-follows.svg" alt="ios-ap diye yazım hatasıyla yazıyorsun; ekip ios-app projesini buluyor, belleğinde yaklaşık bir saniyede arıyor ve ilgili bilgileri ve skill'leri Claude'un bağlamına ekliyor" width="100%"></p>

Belleğin nasıl çalıştığını ve vektörlerin neden önemli olduğunu ayrıntılı öğrenmek için: [docs/memory.md](docs/memory.md) ve yazarın 2023 tarihli [Vektörel Database nedir, ne işe yarar?](https://medium.com/@duzgunberke/vekt%C3%B6rel-database-nedir-ne-i%C5%9Fe-yarar-f832b30421ac) yazısı.

## Görün

<p align="center"><img src="docs/screenshots/panel-tasks-dark.png" alt="Tasks page" width="100%"><br><sub><b>Görevler</b> · her istek canlı adımlarla; ilerlemeyen adım işaretlenir</sub></p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/panel-pools-dark.png" alt="Pools page"><br><sub><b>Havuzlar</b> · hangisi limitte, yeni bir görev nereye gider</sub></td>
    <td width="50%"><img src="docs/screenshots/panel-codemap-dark.png" alt="Code map page"><br><sub><b>Kod haritası</b> · her proje bir grafiğe indekslenmiş</sub></td>
  </tr>
</table>

<p align="center"><img src="docs/screenshots/terminal-tasks-wide.png" alt="Task pane in the terminal" width="100%"><br><sub><b>Terminal</b> · aynı görevler, Claude oturumunun yanındaki panelde</sub></p>

## Takılmamak için tasarlandı

Uzun agent işleri sessizce bozulur: bir CLI donar, ücretsiz bir model cevap vermeyi keser, bir görev
bütün gece "sürüyor" der. ekip bunları kendisi yakalar; peşinden koşmanız gerekmez.

- **Her worker'ın bir bekçisi var.** 15 dakika çıktı yoksa ya da toplam 90 dakika aşıldıysa durdurulur;
  nedeni göreve yazılır ve `auto` işi sıradaki havuza taşır.
- **Görevler kendiliğinden kapanır:** adımlar bitince ya da son worker bitince. 6 saat kimsenin
  dokunmadığı görev "takıldı" olarak kapanır. Panel ve terminal dünkü işi canlı göstermez.
- **Tahminler ölçülür, uydurulmaz.** Bitiş zamanı gerçek ilerleme hızından hesaplanır; dayanak yoksa
  sahte bir sayı yerine hiç tahmin gösterilmez.
- **Arka plan işleri tek kopya çalışır**, iki içe aktarma aynı kota için yarışmaz.
- **Her worker projenin bilgisiyle başlar.** `ekip run --project`, brief'le projenin becerilerini ve
  belleğini arar ve eşleşenleri ekler; lider bakmayı unutsa bile.
- **Hiçbir şey gözden uzakta çalışmaz.** Worker'lar bir bölmede açılır; liderin kendi başlattığı
  uzun işler de (`ekip show <log>`).
- **Kotası biten havuz sıradan çıkar**, sıfırlanana kadar her işi oraya gönderip düşmez; `ekip agents`
  ne zaman geri geleceğini gösterir.
- **Panel doğruyu söyler.** Hub'a ulaşmayan güncellemeler yeniden gönderilir, biten her çalıştırma
  logunu getirir, gerçek iş ölçüldükçe uzun bir adım "canlı" kalır ve terminal paneli ekip
  güncellenince kendini yeniler.
- **Bellek sizin dilinizde kalır.** Ücretsiz bir modelin yanlış dilde yazdığı kayıtları her gece bir
  tarama yeniden yazar: metin, arama dizini ve vektör birlikte.

## Her projeye uyan inceleme ve beceriler

Her projenin kendi kontrolleri ve kendi tuzakları var. ekip her şeye aynı genel incelemeyi uygulamak
yerine bunları öğrenir.

- **`ekip review`** neyin değiştiğine bakar, projenin o dosyalara dokunan kendi kontrol script'lerini
  seçer (canlı servislere yazanları atlar), çalıştırır ve farklı havuzlardaki iki inceleyiciye farkı
  projenin inceleme profiliyle okutur: `CLAUDE.md` kuralları, bilinen tuzaklar ve onları yakalayan
  kontroller.
- **Dersler kalır.** Bir worker başarısız olup sonraki deneme işe yarayınca lider, farkı yaratan şeyi
  projenin belleğine yazar.
- **Tekrarlanan iş beceriye dönüşür.** Aynı türden iş defalarca gelince ekip, gerçek çalıştırmalardan o
  projeye özel düzgün bir `SKILL.md` taslağı çıkarır; tek komutla kabul edersiniz ve o andan itibaren
  her agent kullanır.

## Projeyle birlikte gezen ayarlar

`ekip project config <ad>` bir kez çalıştırılınca projeye kodla birlikte commit edilen bir `.ekip/`
klasörü gelir; o projede ekip ile çalışan herkes aynı ayarları kullanır:

- `rules.md`: projenin kuralları; her worker'ın brief'ine ve liderin bağlamına eklenir.
- `review.md`: `ekip review`'un değişiklikleri okuduğu inceleme profili.
- `checks/`: projenin kendi kontrol script'leri; `ekip review` her değişiklikte çalıştırır.
- `dev.json`: geliştirme veritabanı eşlemesi (şifre asla).

Süreç becerileri Claude Code'un okuduğu `.claude/skills/` içinde kalır.

## Kendi ortamlarınızda çalışır (isteğe bağlı)

Testler ve migration'lar hiçbir zaman production'a dokunmamalı. ekip'in worker'larının gerçek veri
depolarıyla çalışmasını istiyorsanız, onlara bozulması sorun olmayan bir ortam verin:

- **Kendi geliştirme ortamlarınız.** Şirketinizin zaten dev, test ya da UAT sistemleri varsa, onları
  Claude Code'a herhangi bir aracı bağladığınız gibi bağlayın: veritabanı ya da servis için bir MCP
  sunucusu veya projenin ortam değişkenlerindeki bağlantı ayarları. Worker'lar bunları kullanır,
  production erişim dışında kalır.
- **Ya da ekip barındırsın.** `ekip dev`, kendi sunucunuzda tek bir geliştirme Postgres'i ve Redis'i
  tutar, her projeye ayrı bir veritabanı verir ve hazır bir `.env.ekip-dev` ile yerel tünel açar.
  Geliştirme hedefi olmayan hiçbir şeye izin vermez. VPS hub'ında kuyruğa alınan işler de aynı
  ortamı, sunucuya göre adreslenmiş olarak alır.

## Birbiriyle konuşan agent'lar

Kısa görevler arka planda çalışır ve sonuçlarını bildirir. Uzun süre çalışan agent'lar kendi terminallerinde **ekip üyeleri** olarak açılıp [hoptell](https://github.com/EminUZUN/hoptell) üzerinden birbirlerine mesaj atabilir: biri diğerinden bir dosyayı incelemesini ister ya da sıradaki adımı devreder. `ekip team up --open` komutuyla başlatabilirsiniz.

## Hızlı başlangıç

macOS, Node 22+, Docker ve [Claude Code](https://claude.com/claude-code) gerekir.

```bash
git clone https://github.com/duzgunberke/ekip.git && cd ekip
node plugin/bin/ekip.js init     # servisler, plugin, MCP sunucuları, worker CLI'ları, ücretsiz model anahtarları ve projeleriniz
ekip                             # lideri başlatın; ne isterseniz sorun
```

ekip ilk açılışta sizi karşılar ve her açılışta neyin eksik kaldığına bakar: daha yeni bir ekip
sürümü, indekslenmemiş bir proje, eksik kod grafiği ya da wiki, belleğe aktarılmamış Claude
geçmişi, vektörsüz kayıtlar, bağlanmamış worker havuzları ya da ücretsiz model anahtarları. Claude
en faydalı adımı bir kez, tek cümleyle önerir ve "evet" derseniz yapar. Yeni sürümler kendiliğinden kurulur: sürüm çıktığında ve kurulumunuzda yerel değişiklik yoksa ekip
kendini günceller ve bir kez haber verir (`data/config.json` içinde `"autoUpdate": false` kapatır,
`ekip update` elle yapar).

`ekip keys` her ücretsiz sağlayıcının anahtar sayfasını sırayla açar. Mac'iniz kapalıyken de belleği, ücretsiz havuzu ve iş kuyruğunu çalışır durumda tutmak için bir VPS bağlayın: [docs/install.md](docs/install.md).

Yapmadığı şey: ücretsiz modelleri Claude kadar iyi hâle getirmez. Daha yavaştırlar, yoğunlukta zaman aşımına uğrar ve limitlerine ulaşınca beklemeye geçerler. ekip bunları hesaba katar ve kararlar için Claude'u kullanır.

## Sırada ne var

### v2: koca bir ekip için tek ortak bellek

<p align="center"><img src="docs/assets/team-memory.svg" alt="Kendi ekip'ine sahip birkaç kişi, kişisel, proje ve ekip katmanları olan ortak bir belleğe bilgi ekler ve bellekten bilgi alır" width="100%"></p>

Bugün ekip, tek kişi, bir Claude ve koca bir agent ekibi demek. Sırada **ortak bir bellek** kullanan koca bir insan ekibi var.

- Herkes kendi terminalini ve agent'larını kullanır; hepsi tek bir hub'a bağlanır.
- Birinin projede çözdüğü sorun, o projenin belleğine eklenir. Ertesi gün ekip arkadaşının agent'ı çözümü, işe yarayan testi ve işe yaramayanları bilir.
- Wiki'ler, kod grafikleri ve beceriler ortaktır; birinin öğrettiği yöntemi herkesin agent'ları kullanır.
- Kişisel notlar kişiye özel kalır. Ekip kuralları, her agent'ın okuyabildiği bir ekip katmanında tutulur.
- Yeni katılanlar ekibin deneyiminden yararlanır; biri ayrılsa da bildikleri ekipte kalır.

Temel zaten hazır: bellek, tek bir depoda proje ve agent bazında yalıtılmış durumda. v2 bunu roller ve gizlilik kurallarıyla birden fazla kişiye açacak. Gelişmeleri takip etmek için repo'yu izleyin.

### v3: entegrasyonlar, sizin yerinize bağlanır

Projelerin koddan fazlasına ihtiyacı var: hata takibi, uptime kontrolleri, analitik, metrikler,
loglar. Çoğu ekip bu araçları zaten çalıştırıyor, çoğu zaman uygulamalarıyla aynı sunucuda. v3 ile
ekip bunları bulur, eksikse kurar ve her projeye bağlar.

```bash
ekip integrate my-app errors     # hata takibi: kendi sunucunuzda GlitchTip ya da bir Sentry hesabı
ekip integrate my-app uptime     # projenin her açık adresi için bir kontrol
ekip integrate --all errors --dry-run
```

Her entegrasyon aynı beş adımı izler: zaten çalışanı **tespit et**, yoksa ve onay verirseniz sunucunuza
**kur**, aracın içinde projeyi **bağla**, SDK'yı incelenen bir değişiklikle koda **ekle** ve bir test
olayının ulaştığını **doğrula**. Sonra döngü kapanır: yeni hatalar ve başarısız kontroller, yığın
iziyle birlikte ekip görevine dönüşür; tekrarlayan hataların düzeltmeleri ders ve beceri olur.
Ayrıntılar: [yol haritası](docs/roadmap.md).

## Daha fazla bilgi

| | |
|---|---|
| [Nasıl çalışır](docs/architecture.md) | İstek yaşam döngüsü, havuzlar arası yönlendirme, hangi bilgiyi nerede gördüğünüz |
| [Bellek](docs/memory.md) | Proje indeksleme, vektörler, wiki, kod grafiği, beceriler, nelerin saklandığı ve saklanmadığı |
| [Kurulum](docs/install.md) | Mac kurulumu, ücretsiz model anahtarları, VPS hub |
| [Komutlar ve havuzlar](docs/commands.md) | Tüm komutlar ve worker havuzları |
| [Operasyonlar](docs/operations.md) | Üst projelere yamalar, sorun giderme, veri ve gizlilik |
| [Yol haritası](docs/roadmap.md) | v2 ortak hafıza ve ekip çalışması, v3 entegrasyonlar (hata takibi, uptime, analitik, metrikler) |
| [Marka](docs/brand.md) | Logo, renkler, kullanım |

## Üzerine kurulduğu projeler

[freellmapi](https://github.com/tashfeenahmed/freellmapi) ·
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) ·
[codegraph](https://github.com/colbymchenry/codegraph) ·
[hoptell](https://github.com/EminUZUN/hoptell) ·
[shadcn-admin](https://github.com/satnaing/shadcn-admin) ·
ve Antigravity, Codex, Copilot, Qwen Code, OpenCode ve grok-cli agent CLI'ları.

MIT lisanslıdır. Üzerine kurulduğu projeler kendi lisanslarını korur.

Pull request açmadan önce [Katkıda bulunma rehberini](CONTRIBUTING.md) okuyun.
