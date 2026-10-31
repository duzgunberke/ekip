// The hub's own setup gaps, next to the Mac's checklist on the panel: the CI folder ekip's fresh-install
// test writes to (EKIP_CI_DIR) and the commit this hub was built from (EKIP_HUB_COMMIT), without which
// the panel cannot say whether the hub runs the released code. No personal values: only whether
// they are set.
import fs from "node:fs";
import path from "node:path";

/** [{ id, title, why, command, done }] for the hub; titles are Turkish source strings the panel translates. */
export function hubSetup(cfg, { exists = fs.existsSync } = {}) {
  const ci = !!cfg.ciDir && exists(path.join(cfg.ciDir, "result.json"));
  return [
    { id: "hub-ci", title: "CI klasörü bağlı", why: "sıfırdan kurulum testinin sonucu ve yayın durumu panelde görünür", command: "EKIP_CI_DIR=<ci klasörü> (docker-compose.yml)", done: ci },
    { id: "hub-commit", title: "Hub sürümü biliniyor (EKIP_HUB_COMMIT)", why: "panel hub'ın yayınlanan kodla çalışıp çalışmadığını söyleyebilir", command: "EKIP_HUB_COMMIT=$(git rev-parse HEAD) docker compose up -d --build", done: !!cfg.commit },
    { id: "hub-free", title: "Ücretsiz havuz bağlı (FREELLMAPI_URL)", why: "hub işleri ve hafıza ücretsiz modellerle çalışır", command: "FREELLMAPI_URL / FREELLMAPI_KEY (.env)", done: !!(cfg.freellmapiUrl && cfg.freellmapiKey) },
    { id: "hub-memory", title: "Hafıza bağlı (TDAI_PROXY_URL)", why: "hub işleri projenin hafızası ve wiki'siyle başlar", command: "TDAI_PROXY_URL / TDAI_USER_KEY (.env)", done: !!(cfg.tdaiUrl && cfg.tdaiUserKey) },
  ];
}
