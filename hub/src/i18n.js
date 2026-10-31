// The hub's own user-facing texts (the Telegram bot). Turkish source strings with their English
// entry, as in plugin/lib/core/i18n.js; the hub image does not carry the plugin, so its few strings
// live here. The language: EKIP_LANG on the hub, else what the Mac sent with `ekip phone link`.
const en = {
  "Telefon bağlandı. Görevler buraya gelecek; yazdığın her mesaj lead'e gider. Komutlar: /help": "Phone linked. Tasks will show up here; every message you write goes to the lead. Commands: /help",
  "Bu sohbet zaten bağlı.": "This chat is already linked.",
  "Komutlar": "Commands",
  "çalışan ve bekleyen görevlerin özeti": "summary of running and waiting tasks",
  "son görevler": "recent tasks",
  "bir görevin adımları, işçileri ve notları": "a task's steps, workers and notes",
  "görevi iptal et (onay ister)": "cancel a task (asks to confirm)",
  "lead'in çalışan turunu durdur (Esc)": "interrupt the lead's running turn (Esc)",
  "projede yeni bir lead oturumu aç": "open a new lead session in a project",
  "açık lead oturumları, birini seç": "live lead sessions, pick one",
  "bu yardım": "this help",
  "telefonu bağla": "link this phone",
  "telefon modu: on, off, verbose on|off": "phone mode: on, off, verbose on|off",
  "Düz metin yeni bir istektir; bir soruya düğmeyle ya da yanıtlayarak cevap verirsin.": "Plain text is a new request; answer a question with its buttons or by replying to it.",
  "Mac çevrimiçi": "Mac online",
  "Mac çevrimdışı (istekler VPS kuyruğuna gider)": "Mac offline (requests go to the VPS queue)",
  "çalışıyor": "running", "senden bekleniyor": "waiting for you", "takıldı": "stuck", "son 24 saatte biten": "done in the last 24 h",
  "Çalışan görev yok.": "No running tasks.",
  "Görev yok.": "No tasks.",
  "Böyle bir görev yok: {id}": "No such task: {id}",
  "kullanım: {usage}": "usage: {usage}",
  "Adımlar": "Steps", "İşçiler": "Workers", "Son notlar": "Last notes", "Sonuç": "Result",
  "Bu görev iptal edilsin mi?": "Cancel this task?",
  "Evet, iptal et": "Yes, cancel", "Hayır": "No",
  "İptal Mac'e iletildi.": "Cancel sent to the Mac.",
  "İptal kaydedildi; Mac açılınca uygulanır.": "Cancel saved; it is applied when the Mac is back.",
  "Vazgeçildi.": "Kept.",
  "Esc lead'e gönderiliyor.": "Sending Esc to the lead.",
  "Mac çevrimdışı; durdurulacak bir tur yok.": "The Mac is offline; there is no turn to stop.",
  "Hangi projede?": "Which project?",
  "Hub'da kayıtlı proje yok (ekip project sync).": "No project registered on the hub (ekip project sync).",
  "Böyle bir proje yok: {name}": "No such project: {name}",
  "{project} için yeni lead açılıyor; sonraki mesajlar ona gider.": "Opening a new lead for {project}; the next messages go to it.",
  "Mac çevrimdışı; yeni oturum açılamaz.": "The Mac is offline; no new session can be opened.",
  "Açık lead oturumu yok.": "No live lead session.",
  "Lead oturumları (mesajların gideceğini seç):": "Lead sessions (pick where your messages go):",
  "Mesajlar artık bu oturuma gidiyor: {name}": "Messages now go to this session: {name}",
  "boşta": "idle", "çalışıyor…": "working…",
  "Lead'e iletildi.": "Sent to the lead.",
  "Mac çevrimdışı; dosya Mac açılınca lead'e gider.": "The Mac is offline; the file goes to the lead when the Mac is back.",
  "Mac çevrimdışı; iş VPS kuyruğuna gitti: {project} · {id}": "The Mac is offline; the job went to the VPS queue: {project} · {id}",
  "Lead açık değil; iş VPS kuyruğuna gitti: {project} · {id}": "No lead is open; the job went to the VPS queue: {project} · {id}",
  "İş kuyruğa alınamadı: {error}": "Could not queue the job: {error}",
  "Mac çevrimdışı. Bu iş hangi projede çalışsın?": "The Mac is offline. Which project should this job run in?",
  "Diğer…": "Other…",
  "Cevabını yaz:": "Type your answer:",
  "Cevap Mac'e iletildi: {choice}": "Answer sent to the Mac: {choice}",
  "Cevap kaydedildi; Mac açılınca uygulanır: {choice}": "Answer saved; it is applied when the Mac is back: {choice}",
  "Bu soru artık geçerli değil.": "This question is no longer open.",
  "Bilinmeyen komut. /help": "Unknown command. /help",
  "Telefon modu: açık (her turun cevabı buraya gelir)": "Phone mode: on (every turn's reply comes here)",
  "Telefon modu: kapalı (yalnız telefondan başlayan turlar)": "Phone mode: off (only turns started from the phone)",
  "Ayrıntılı mod: açık (araç çağrıları canlı mesajda)": "Verbose: on (tool calls in the live message)",
  "Ayrıntılı mod: kapalı": "Verbose: off",
  "Görev bitti": "Task done", "Görev başarısız": "Task failed", "Görev iptal edildi": "Task cancelled",
  "Takıldı": "Blocked", "Çalışan işçi yok, görev ilerlemiyor": "No live worker; the task is not moving",
  "Senden bir karar bekleniyor": "A decision is waiting for you",
  "İnceleme düştü ({n} bulgu)": "Review failed ({n} findings)",
  "adım {n}/{total}": "step {n}/{total}", "tahmini bitiş {time}": "est. finish {time}",
  "bitti": "done", "başarısız": "failed", "iptal": "cancelled", "bekliyor": "waiting", "duraklatıldı": "paused",
  "Yayın: {version} hazır": "Release: {version} is out",
  "CI düştü ({step}) · {sha}": "CI failed ({step}) · {sha}",
  "CI geçti · {sha}": "CI passed · {sha}",
  "çalışıyor ({n} araç)": "working ({n} tools)",
  "tur bitti": "turn finished",
  "(boş cevap)": "(empty reply)",
};
const dictionaries = { en, tr: Object.fromEntries(Object.keys(en).map((k) => [k, k])) };
export { dictionaries };

let current = null;
/** The bot's language: "en" or "tr". */
export const getLang = () => (["en", "tr"].includes(process.env.EKIP_LANG) ? process.env.EKIP_LANG : current ?? "en");
export const setLang = (l) => { if (["en", "tr"].includes(l)) current = l; };
export function t(key, vars = {}) {
  const value = dictionaries[getLang()][key] ?? key;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
}
