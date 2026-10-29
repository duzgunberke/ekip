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

## Mesajınızla birlikte gelen bellek

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
- **Bellek sizin dilinizde kalır.** Ücretsiz bir modelin yanlış dilde yazdığı kayıtları her gece bir
  tarama yeniden yazar: metin, arama dizini ve vektör birlikte.

## Birbiriyle konuşan agent'lar

Kısa görevler arka planda çalışır ve sonuçlarını bildirir. Uzun süre çalışan agent'lar kendi terminallerinde **ekip üyeleri** olarak açılıp [hoptell](https://github.com/EminUZUN/hoptell) üzerinden birbirlerine mesaj atabilir: biri diğerinden bir dosyayı incelemesini ister ya da sıradaki adımı devreder. `ekip team up --open` komutuyla başlatabilirsiniz.

## Hızlı başlangıç

macOS, Node 22+, Docker ve [Claude Code](https://claude.com/claude-code) gerekir.

```bash
git clone https://github.com/duzgunberke/ekip.git && cd ekip
node plugin/bin/ekip.js init     # servisler, plugin, MCP sunucuları, worker CLI'ları, ücretsiz model anahtarları ve projeleriniz
ekip                             # lideri başlatın; ne isterseniz sorun
```

`ekip keys` her ücretsiz sağlayıcının anahtar sayfasını sırayla açar. Mac'iniz kapalıyken de belleği, ücretsiz havuzu ve iş kuyruğunu çalışır durumda tutmak için bir VPS bağlayın: [docs/install.md](docs/install.md).

Yapmadığı şey: ücretsiz modelleri Claude kadar iyi hâle getirmez. Daha yavaştırlar, yoğunlukta zaman aşımına uğrar ve limitlerine ulaşınca beklemeye geçerler. ekip bunları hesaba katar ve kararlar için Claude'u kullanır.

## v2'de geliyor: ortak bellek

<p align="center"><img src="docs/assets/team-memory.svg" alt="Kendi ekip'ine sahip birkaç kişi, kişisel, proje ve ekip katmanları olan ortak bir belleğe bilgi ekler ve bellekten bilgi alır" width="100%"></p>

Bugün ekip, tek kişi, bir Claude ve koca bir agent ekibi demek. Sırada **ortak bir bellek** kullanan koca bir insan ekibi var.

- Herkes kendi terminalini ve agent'larını kullanır; hepsi tek bir hub'a bağlanır.
- Birinin projede çözdüğü sorun, o projenin belleğine eklenir. Ertesi gün ekip arkadaşının agent'ı çözümü, işe yarayan testi ve işe yaramayanları bilir.
- Wiki'ler, kod grafikleri ve beceriler ortaktır; birinin öğrettiği yöntemi herkesin agent'ları kullanır.
- Kişisel notlar kişiye özel kalır. Ekip kuralları, her agent'ın okuyabildiği bir ekip katmanında tutulur.
- Yeni katılanlar ekibin deneyiminden yararlanır; biri ayrılsa da bildikleri ekipte kalır.

Temel zaten hazır: bellek, tek bir depoda proje ve agent bazında yalıtılmış durumda. v2 bunu roller ve gizlilik kurallarıyla birden fazla kişiye açacak. Gelişmeleri takip etmek için repo'yu izleyin.

## Daha fazla bilgi

| | |
|---|---|
| [Nasıl çalışır](docs/architecture.md) | İstek yaşam döngüsü, havuzlar arası yönlendirme, hangi bilgiyi nerede gördüğünüz |
| [Bellek](docs/memory.md) | Proje indeksleme, vektörler, wiki, kod grafiği, beceriler, nelerin saklandığı ve saklanmadığı |
| [Kurulum](docs/install.md) | Mac kurulumu, ücretsiz model anahtarları, VPS hub |
| [Komutlar ve havuzlar](docs/commands.md) | Tüm komutlar ve worker havuzları |
| [Operasyonlar](docs/operations.md) | Üst projelere yamalar, sorun giderme, veri ve gizlilik |
| [Marka](docs/brand.md) | Logo, renkler, kullanım |

## Üzerine kurulduğu projeler

[freellmapi](https://github.com/tashfeenahmed/freellmapi) ·
[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) ·
[codegraph](https://github.com/colbymchenry/codegraph) ·
[hoptell](https://github.com/EminUZUN/hoptell) ·
[shadcn-admin](https://github.com/satnaing/shadcn-admin) ·
ve Antigravity, Codex, Copilot, Qwen Code, OpenCode ve grok-cli agent CLI'ları.

MIT lisanslıdır. Üzerine kurulduğu projeler kendi lisanslarını korur.
