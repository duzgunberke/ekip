// Masks credentials in text that leaves the hub for a chat app (Telegram): tokens, API keys,
// passwords, bearer strings, private keys and URLs that carry a user and password. The same rules as
// plugin/lib/core/redact.js (the hub image does not include the plugin), plus generic URL credentials.
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[REDACTED]");
  return out
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE[ ]KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE[ ]KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    // scheme://user:password@host (databases, git remotes, any private URL with credentials)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@/\s]+)@([^/\s]+)/gi, "$1[REDACTED]@$4")
    // https://token@host (a git remote with only a token)
    .replace(/\b(https?:\/\/)([A-Za-z0-9_-]{20,})@([^/\s]+)/gi, "$1[REDACTED]@$3")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|token|secret|password|passwd|pwd)s?)(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    // query strings: ?token=…, &key=…, &sig=…
    .replace(/([?&](?:access_token|token|key|api_key|apikey|sig|signature|password|secret)=)[^&\s#]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9_-]{12,}|nvapi-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    // a Telegram bot token (digits:35 chars)
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED]")
    // JSON web tokens
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}
