# Third-party material

ekip's own code is under the licence in [LICENSE](LICENSE). The files below come from other projects
and keep their own licences.

## Provider and pool logos

The web panel (`hub/web/src/components/provider-logo.tsx`) and the terminal
(`plugin/assets/logos/`, PNGs rendered by `scripts/render-logos.mjs`) show the logos of the services a
pool runs on. One list says which logo stands for which pool or provider: `hub/web/src/lib/logos.json`.

| Source | Version | Licence | Used for |
| --- | --- | --- | --- |
| [@lobehub/icons-static-svg](https://github.com/lobehub/lobe-icons) | 1.101.0 | MIT, © LobeHub | OpenAI, Antigravity, Gemini, Zhipu, Groq, Mistral, Cohere, xAI, Cerebras |
| [simple-icons](https://github.com/simple-icons/simple-icons) | 16.36.0 | CC0 1.0 | Anthropic, GitHub Copilot, Google, Qwen, DeepSeek, NVIDIA, OpenRouter, OVH, Hugging Face, Cloudflare, ModelScope, Meta, Kimi, MiniMax, OpenCode |
| [lucide](https://github.com/lucide-icons/lucide) (`bot`) | lucide-react 1.8.0 | ISC, © Lucide contributors | a pool or provider without a logo |

The PNGs are the packages' SVGs drawn for a dark terminal: one-colour black marks in a light colour,
coloured marks in their brand colour (light when the brand colour is too dark to read). Nothing else
is changed.

The logos are trademarks of their owners. ekip shows them only to name the service a pool or
provider runs on; it implies no endorsement or affiliation. See the
[simple-icons legal disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md).
