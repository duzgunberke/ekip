<p align="center">
  <img src="docs/brand/banner.svg" alt="ekip: tek terminal, bir Claude, koca bir ekip" width="100%">
</p>

<p align="center">
  <b>Tek bir Claude Code oturumunu ekip liderine dönüştürün.</b><br>
  Claude planlar ve inceler. Diğer kotalardaki agent'lar işi yapar; her biri projenin kendi belleği ve skill'leriyle başlar.
</p>

<p align="center">
  <a href="https://github.com/duzgunberke/ekip/releases"><img src="https://img.shields.io/github/v/release/duzgunberke/ekip?style=flat-square&label=release&color=2DD4BF" alt="Son sürüm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-FFA95E?style=flat-square" alt="MIT lisansı"></a>
  <img src="https://img.shields.io/badge/macOS-Node%2022%2B-6B7280?style=flat-square" alt="macOS, Node 22+">
  <img src="https://img.shields.io/badge/hub-any%20Linux%20VPS-6B7280?style=flat-square" alt="Hub: Docker'lı herhangi bir Linux VPS">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>Türkçe</b>
</p>

<p align="center">
  <img src="docs/demo/terminal-wezterm.gif" alt="ekip yazınca lider WezTerm'de açılır: solda Claude oturumu, sağda loglarını yazan iki worker, altta çalışan, sırada, engelli, sizi bekleyen ve biten görevlerle görev paneli" width="100%"><br>
  <sub><code>ekip</code> yazın: solda lider, sağda worker'lar, altta canlı görevler (<a href="docs/demo/terminal-wezterm.mp4">MP4</a>)</sub>
</p>

## Neden: Claude'un limiti okumaya değil karar vermeye gider

Claude Code limitinin çoğu **okumaya** gider: dosyalar, loglar, geçmiş, her oturumda aynı bağlam yeniden.
ekip bu işi Claude'un üstünden alır:

- **Claude yalnız karar verir.** İsteği anlar, böler, her parça için bir işçi seçer ve sonucu inceler.
  Okuma ve yazma **başka kotalarda** yürür: Antigravity, Codex, Copilot, Qwen, OpenCode, grok ve tek
  uç noktanın arkasındaki 60 kadar ücretsiz model.
- **Bağlam bir kez hazırlanır.** Her projenin hafızası var: vektör veritabanında geçmiş oturumlar,
  belgelerinden bir LLM wiki, kod grafiği ve kendi skill'leri. İşçiler repoyu baştan okumak yerine
  buradan başlar, lead'e de mesaja gereken birkaç bilgi gider.
- **Söz değil ölçüm.** `ekip savings` işin ne kadarının Claude dışında yürüdüğünü gösterir.

<p align="center"><img src="docs/assets/savings.svg" alt="ekip savings ile ölçülen, Claude dışında yürüyen iş payı: iki günlük kurulumda %58, ertesi gün %81" width="100%"></p>

## Hızlı başlangıç

macOS, Node 22+, Docker ve [Claude Code](https://claude.com/claude-code) gerekir.

```bash
git clone https://github.com/duzgunberke/ekip.git && cd ekip && node plugin/bin/ekip.js init
ekip kurulum   # adım adım: ücretsiz model anahtarları, worker girişleri, projeleriniz (ekip setup)
ekip           # lideri başlatın ve Claude'la konuştuğunuz gibi konuşun
```

`ekip init` servisleri, eklentiyi, MCP sunucularını, worker CLI'larını ve ekip'in kendi terminalini
(WezTerm, Dock'ta bir `ekip.app` ile) kurar. `ekip kurulum` eksik kalanları gösterir ve ertelediklerinizi
hatırlar; her açılışta en faydalı sonraki adım bir kez hatırlatılır. Dili `ekip dil tr` ya da
`ekip dil en` seçer. Yeni sürümler kendiliğinden kurulur.

## Neler sunar

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/terminal-wezterm-hero.png" alt="WezTerm'de ekip: solda lider, sağda iki worker, altta her görev için bir kartla görev paneli"><br><br>
      <b>Başka kotalarda bir ekip.</b> Claude her isteği böler ve parçaları Antigravity, Codex, Copilot, Qwen, OpenCode, grok ve yaklaşık 60 ücretsiz modele verir. <code>ekip mesai on</code> her havuzu çalıştırır.
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/panel-tasks-dark.png" alt="Panelin görevler sayfası: canlı görevlerin üstünde sizi bekleyen, takılan, çalışan ve biten işlerin özet kartı"><br><br>
      <b>Her şey göz önünde.</b> Her istek canlı adımları olan bir görevdir; oturumun altındaki panelde ve web panelinde görünür. Size sorulanlar kırmızıyla, takılanlar turuncuyla en üstte durur.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/demo/terminal-status.gif" alt="ekip durum: şu an çalışanlar, sizi bekleyenler, takılanlar, sonuç ve bağlantılarıyla bitenler ve sürüm satırı"><br><br>
      <b>"Ne oluyor?" sorusuna tek cevap.</b> <code>ekip durum</code> ne çalıştığını, sizden ne beklendiğini, neyin takıldığını ve neyin bittiğini sonuç, bağlantı ve sürüm satırıyla gösterir.
    </td>
    <td width="50%" valign="top">
      <img src="docs/demo/terminal-track.gif" alt="ekip track: yüzde, hız ve bitiş zamanıyla tamamlanan bir yükleme ve beklenenden yavaş olduğunu hemen bildiren bir kopyalama"><br><br>
      <b>Takılmamak için tasarlandı.</b> Bekçiler, ölü worker'ları kapatan bir toplayıcı, havuz değiştirme, kuyruklar (<code>--after</code>, <code>--when</code>), <code>--resume</code> ve uzun işler için <code>ekip track</code>.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/panel-codemap-dark.png" alt="Panelin kod haritası: bir projenin depoları, klasörleri ve bir dosyanın sembolleri"><br><br>
      <b>Proje başına bellek.</b> Vektör veritabanında geçmiş oturumlar, dokümanlardan bir LLM wiki, kod grafiği, skill'ler ve dersler. Bir projeden söz edin, bilgileri bir saniyede gelir. <a href="#mesajınızı-izleyen-bellek">Ayrıntı ↓</a>
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/skill-loop-mini.svg" alt="Skill döngüsü, küçük: çalıştırmalar kaydedilir, tekrarlar gruplanır, skill learn, siz kabul edersiniz, .claude/skills, her brief; dersler her brief'in ve liderin en üstünde"><br><br>
      <b>Öğrendiği skill'ler.</b> Bir projede tekrar eden iş, sizin onayladığınız bir <code>SKILL.md</code> olur ve o projedeki sonraki her worker brief'i onu kullanır. <a href="#skill-kendi-işinizden-öğrenilen-prosedürler">Nasıl çalışır ↓</a>
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <img src="docs/demo/panel-demo.gif" alt="Koyu temada ekip web paneli: canlı görevlerin üstünde durum özeti, komut menüsü, kod haritası, projeler arası çalıştırmalar, proje kartları ve kotalarıyla worker havuzları" width="100%"><br><br>
      <b>Web paneli.</b> Bir hub bağlıysa aynı görevler, projeler arası çalıştırmalar, kotalarıyla worker havuzları ve her projenin kod haritası tarayıcıda, her cihazdan, parola ve passkey ile açılır. <a href="docs/demo/panel-demo.mp4">MP4</a> · <a href="docs/architecture.md#seeing-what-is-going-on">Ayrıntı</a>
    </td>
  </tr>
</table>

## Mesajınızı izleyen bellek

Kayıtlı her projenin bir kez kurulan ve güncel tutulan kendi belleği vardır; her worker sıfırdan değil
ondan başlar:

- **Vektör veritabanı:** geçmiş Claude oturumları, kararlar ve worker raporları, anlamına göre aranır.
- **LLM wiki** projenin dokümanlarından yazılır; **kod grafiği** dosyalarını ve sembollerini tutar.
- **Skill'ler** projenin kendi işinden öğrenilir; **dersler** düzelttiğiniz hatalardan gelir.

Bir projeden söz edin, yazım hatasıyla bile; ekip önemli olanı yaklaşık bir saniyede Claude'un
bağlamına ekler. `ekip stats` bu bilginin gerçekten kullanılıp kullanılmadığını gösterir: aramalar,
isabet oranı, worker'ların açtığı skill'ler.

<p align="center"><img src="docs/assets/memory-follows.svg" alt="ios-ap diye yazım hatasıyla yazarsınız; ekip ios-app projesini bulur, belleğini yaklaşık bir saniyede arar ve ilgili bilgileri ve skill'leri Claude'un bağlamına ekler" width="100%"></p>

Belleğin nasıl çalıştığı ve vektörlerin neden önemli olduğu: [docs/memory.md](docs/memory.md) (İngilizce)
ve yazarın 2023 tarihli yazısı [Vektörel Database nedir, ne işe yarar?](https://medium.com/@duzgunberke/vekt%C3%B6rel-database-nedir-ne-i%C5%9Fe-yarar-f832b30421ac).

## Skill: kendi işinizden öğrenilen prosedürler

Her projenin kimsenin yazmadığı prosedürleri vardır: nasıl yayınlandığı, alışıldık hatayı hangi
kontrolün yakaladığı, asla unutulmaması gereken o tek bayrak. ekip bunları zaten yaptığınız işte bulur
ve sıradan Claude Code skill'lerine dönüştürür.

<p align="center"><img src="docs/assets/skill-loop.svg" alt="Skill döngüsü: çalıştırmalar kaydedilir, tekrarlar gruplanır, ekip skill learn bir SKILL.md taslağı yazar, siz kabul edersiniz, .claude/skills içine girer, sonraki her worker brief'i ve lider onu kullanır; düzelttiğiniz hatalar her brief'in ve liderin bağlamının başına giren derslere dönüşür" width="100%"></p>

- **Gerçek çalıştırmalardan.** Her worker brief'i ve raporu proje başına kaydedilir. Aynı etiketli ya
  da birbirine benzeyen brief'ler gruplanır; üç ve daha fazla çalıştırmalık bir grup için prosedür,
  dosyalar, kontroller, tuzaklar ve "bitti" tanımıyla bir `SKILL.md` taslağı yazılır. Komutlar yalnızca
  çalıştırmalardan ve projenin kendi dokümanlarından alınır.
- **Siz onaylarsınız.** Taslaklar aday olarak bekler. Kabul edilen, projenin `.claude/skills/` klasörüne
  girer ve kodla birlikte commit'lenir; reddedilen bir daha önerilmez. `ekip doctor` günde bir kez
  kendiliğinden taslak çıkarır.
- **Sormadan kullanılır.** `ekip run` brief'i projenin skill'leriyle karşılaştırır ve uyanları ekler;
  liderin istem kancası da aynısını yapar. Belleğin geçmiş oturumlardan çıkardığı skill'ler de aynı
  yolla ve `skill_search`, `skill_get` araçlarıyla bulunur.
- **Dersler en üstte.** Bir hatayı düzelttiğinizde `ekip project lesson` onu yazar ve o projedeki sonraki
  her brief, konusu ne olursa olsun, onunla başlar.

Bir video düzenleme projesi "9:16 kesimi render et, ses yüksekliğini kontrol et, yükle" işini üç kez
çalıştırdı. ekip render edilecek kompozisyonu, ses kontrolünü ve bir çalıştırmayı bozan tuzağı içeren
`flow-production-unit` taslağını çıkardı. Tek bir `accept`'ten sonra bir sonraki render brief'i onu
listeledi ve worker ona göre çalıştı.

```bash
ekip skill learn my-app                    # tekrar eden çalıştırmaları grupla, SKILL.md adayları yaz
ekip skill candidates                      # yazılan taslakları oku
ekip skill accept my-app release-ios       # my-app/.claude/skills içine kur
```

Ayrıntı: [docs/skills.md](docs/skills.md) (adım adım döngü, dersler, proje incelemeleri, `.ekip/` ayarları; İngilizce).

## Nasıl çalışır?

<p align="center"><img src="docs/assets/how-it-works.svg" alt="Tek bir Claude liderine konuşursunuz. İşin her parçasını Antigravity, Codex, Copilot veya ücretsiz havuza yönlendirir. Her worker proje belleğinden başlar: bilgiler, wiki, kod grafiği ve skill'ler. İsteğe bağlı VPS hub belleği, ücretsiz havuzu ve iş kuyruğunu çalışır durumda tutar." width="100%"></p>

Tek bir Claude oturumuyla konuşursunuz. Bir görev açar, her parçayı kotası olan ve son sonuçları en iyi
havuza yönlendirir, dönenleri `ekip review` ile inceler. Claude'un kotası karar vermeye gider; okuma ve
yazma başka yerde yürür. `ekip savings` bu payı ölçer: yazarın sıradan bir gününde işin %81'i Claude
dışında yürüdü, soğuk kurulum sırasında %58 ([rakamlar](docs/architecture.md#why), İngilizce).

<details>
<summary><b>Kısaca daha fazlası</b></summary>

- **Proje kaydı** (`ekip project add`) projenin geçmiş Claude oturumlarını içe aktarır, kod grafiği ve
  wiki oluşturur, bir proje kartı yazar. [Bellek](docs/memory.md)
- **Havuz seçimi** test edilmiş havuzlara, son başarıya ve algılanan kota sınırlarına bakar; ücretsiz
  havuz en sondadır. [Nasıl çalışır](docs/architecture.md)
- **Takılan iş** bulunur ve ele alınır: sessiz worker'lar durdurulur, ölüler nedeniyle kapatılır, uzun
  işler gerçek yüzde ve bitiş zamanıyla izlenir. [Güvenilirlik](docs/reliability.md)
- **Agent'lar** hoptell üzerinden birbiriyle konuşabilir ve güvenli geliştirme veritabanlarında
  (`ekip dev`) çalışabilir. [Nasıl çalışır](docs/architecture.md#agents-that-talk-to-each-other)
- **Bir VPS hub**, Mac kapalıyken belleği, ücretsiz havuzu ve iş kuyruğunu çalışır tutar ve web panelini
  sunar. [Kurulum](docs/install.md#optional-vps-hub)
- **Gizli hub:** `ekip hub private` hub'ı Tailscale ağınıza alır; panel ve API yalnız kendi
  cihazlarınızdan açılır, alan adı ve DNS kaydı gerekmez. [Kurulum](docs/install.md#private-hub-with-tailscale)
- **Telefonun** (hub'daki bir Telegram botu) her görevi canlı izler, lead'in sorularını düğmeyle cevaplar
  ve yeni işi açık lead'e yazar; Mac kapalıyken iş hub'ın kuyruğuna gider. `ekip phone setup` bağlar.
  [Telefon](docs/install.md#optional-your-phone-telegram)

</details>

Yapmadığı şey: ücretsiz modelleri Claude kadar iyi yapmaz. Daha yavaştırlar, yük altında zaman aşımına
düşerler ve sınırlarında soğumaya girerler. ekip bunların etrafından dolaşır ve Claude'u kararlara
saklar.

## Daha fazla bilgi

Belgeler İngilizcedir.

| | |
|---|---|
| [Nasıl çalışır](docs/architecture.md) | isteğin yaşam döngüsü, havuz seçimi, mesai modu, neyi nerede görürsünüz |
| [Bellek](docs/memory.md) | proje indeksleme, vektörler, wiki, kod grafiği, neyin saklandığı |
| [Skill'ler](docs/skills.md) | öğrenme döngüsü, dersler, proje incelemeleri, `.ekip/` ayarları |
| [Güvenilirlik](docs/reliability.md) | bekçiler, kuyruklar, izlenen işler, görev durumları |
| [Kurulum](docs/install.md) | Mac kurulumu, adım adım kurulum, terminal, sağlayıcı anahtarları, VPS hub |
| [Komutlar](docs/commands.md) | tüm komutlar, tüm worker havuzları |
| [İşletim](docs/operations.md) | upstream yamaları, sorun giderme, veri ve gizlilik |
| [Yol haritası](docs/roadmap.md) | v2 paylaşılan ekip belleği, v3 entegrasyonlar (hata, erişilebilirlik, analitik) |

## Üzerine kurulduğu projeler

[freellmapi](https://github.com/tashfeenahmed/freellmapi) ·
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) ·
[codegraph](https://github.com/colbymchenry/codegraph) ·
[hoptell](https://github.com/EminUZUN/hoptell) ·
[shadcn-admin](https://github.com/satnaing/shadcn-admin) ·
[WezTerm](https://wezterm.org) ·
ve Antigravity, Codex, Copilot, Qwen Code, OpenCode ile grok-cli'nin agent CLI'ları.

MIT lisanslıdır; üzerine kurulduğu projeler kendi lisanslarını korur. Pull request açmadan önce
[Katkı rehberine](CONTRIBUTING.md) bakın.
