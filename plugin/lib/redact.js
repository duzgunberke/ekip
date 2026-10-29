// Mask common credentials before text leaves local storage or reaches a model.
export function redact(text) {
  return String(text)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b((?:postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?):\/\/)([^:/@\s]+):([^@/\s]+)@([^/\s]+)/gi, "$1[REDACTED]@$4")
    .replace(/\b(?:Bearer\s+)([^\s,;]+)/gi, "Bearer [REDACTED]")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*(?:"[^"\n]+"|'[^'\n]+'|[^\s,;]+)/gi, (m) => `${m.split(/\s*[:=]/)[0]}=[REDACTED]`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9_-]{12,}|nvapi-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[A-Za-z0-9-]{10,})\b/gi, "[REDACTED]");
}
