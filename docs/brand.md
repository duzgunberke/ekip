# ekip brand

**The mark.** A terminal prompt `❯` (the lead, amber) whose tip fans out into three lines that end in three
nodes (the team, teal): one terminal, one Claude, a whole team. It holds up from a 16 px favicon to the
README banner, and it is drawn the same way in the terminal (`plugin/lib/ui.js`).

**Colour has a meaning everywhere**: amber is the lead (Claude, your subscription), teal is the team
(work on other quotas). The README diagrams, the panel and the terminal use the same split.

| Role | Light | Dark |
|---|---|---|
| Lead (amber) | `#F08A3C` | `#FFA95E` |
| Team (teal), primary | `#0D9488` | `#2DD4BF` |
| Background | `#F6F7F9` | `#0E1014` |
| Card | `#FFFFFF` | `#15181E` |
| Text | `#12151B` | `#ECEEF2` |
| Muted text | `#667085` | `#98A1B0` |
| Border | `#E4E7EC` | `#252A33` |
| Done / failed / cancelled | `#16A34A` / `#DC3D43` / `#D97706` | `#3FCF7A` / `#F2555A` / `#F5A524` |

Type: the system sans stack (Inter where available) for UI and the wordmark, a system monospace for ids.

Files: `docs/brand/logo-mark.svg`, `logo-light.svg`, `logo-dark.svg`, `banner.svg`; the panel copies in
`hub/web/public/`. No eyebrow pills, no numbered section rules, no decorative gradients beyond the mark's own.
