import { Bot } from 'lucide-react'
import type { CSSProperties } from 'react'
import openaiLogo from '@lobehub/icons-static-svg/icons/openai.svg?url'
import antigravityLogo from '@lobehub/icons-static-svg/icons/antigravity.svg?url'
import zhipuLogo from '@lobehub/icons-static-svg/icons/zhipu.svg?url'
import groqLogo from '@lobehub/icons-static-svg/icons/groq.svg?url'
import mistralLogo from '@lobehub/icons-static-svg/icons/mistral.svg?url'
import cohereLogo from '@lobehub/icons-static-svg/icons/cohere.svg?url'
import xaiLogo from '@lobehub/icons-static-svg/icons/xai.svg?url'
import cerebrasLogo from '@lobehub/icons-static-svg/icons/cerebras.svg?url'
import geminiLogo from '@lobehub/icons-static-svg/icons/gemini.svg?url'
import {
  siAnthropic, siGithubcopilot, siGoogle, siDeepseek, siQwen, siNvidia,
  siOpenrouter, siOvh, siHuggingface, siMeta, siKimi, siMinimax, siOpencode,
} from 'simple-icons'

const icons: Record<string, { title: string; path?: string; image?: string; color?: string }> = {
  claude: { title: 'Anthropic', path: siAnthropic.path, color: siAnthropic.hex }, anthropic: { title: 'Anthropic', path: siAnthropic.path, color: siAnthropic.hex },
  codex: { title: 'OpenAI', image: openaiLogo }, openai: { title: 'OpenAI', image: openaiLogo },
  copilot: { title: 'GitHub Copilot', path: siGithubcopilot.path, color: siGithubcopilot.hex },
  agy: { title: 'Google Antigravity', image: antigravityLogo }, gemini: { title: 'Google Gemini', image: geminiLogo }, google: { title: 'Google AI Studio', path: siGoogle.path, color: siGoogle.hex },
  qwen: { title: 'Qwen', path: siQwen.path, color: siQwen.hex }, deepseek: { title: 'DeepSeek', path: siDeepseek.path, color: siDeepseek.hex }, nvidia: { title: 'NVIDIA', path: siNvidia.path, color: siNvidia.hex },
  openrouter: { title: 'OpenRouter', path: siOpenrouter.path, color: siOpenrouter.hex }, ovh: { title: 'OVHcloud', path: siOvh.path, color: siOvh.hex }, huggingface: { title: 'Hugging Face', path: siHuggingface.path, color: siHuggingface.hex },
  meta: { title: 'Meta Llama', path: siMeta.path, color: siMeta.hex }, llama: { title: 'Meta Llama', path: siMeta.path, color: siMeta.hex }, kimi: { title: 'Moonshot Kimi', path: siKimi.path, color: siKimi.hex }, moonshot: { title: 'Moonshot Kimi', path: siKimi.path, color: siKimi.hex }, minimax: { title: 'MiniMax', path: siMinimax.path, color: siMinimax.hex }, opencode: { title: 'OpenCode', path: siOpencode.path, color: siOpencode.hex },
  zhipu: { title: 'Zhipu GLM', image: zhipuLogo }, groq: { title: 'Groq', image: groqLogo }, mistral: { title: 'Mistral', image: mistralLogo }, cohere: { title: 'Cohere', image: cohereLogo }, xai: { title: 'xAI', image: xaiLogo }, grok: { title: 'xAI Grok', image: xaiLogo }, cerebras: { title: 'Cerebras', image: cerebrasLogo },
}

// What a worker ran on, most telling first: the model family ("openrouter/deepseek-v4" is DeepSeek,
// "groq/openai/gpt-oss-120b" is OpenAI), then the host in front of the slash, then the pool itself.
const FAMILIES: [RegExp, string][] = [
  [/claude|anthropic/, 'anthropic'], [/gpt|openai|o[134]-/, 'openai'], [/gemini|gemma/, 'gemini'], [/deepseek/, 'deepseek'],
  [/qwen|qwq/, 'qwen'], [/glm|zhipu|chatglm/, 'zhipu'], [/llama|meta/, 'meta'], [/kimi|moonshot/, 'kimi'], [/minimax/, 'minimax'],
  [/mistral|mixtral|codestral|devstral/, 'mistral'], [/command|cohere/, 'cohere'], [/grok|xai/, 'xai'], [/nemotron|nvidia/, 'nvidia'],
]

export function logoFor(id?: string | null, modelId?: string | null) {
  const key = (id ?? '').toLowerCase()
  const model = (modelId ?? (key.includes('/') ? key : '')).toLowerCase()
  const family = model && FAMILIES.find(([re]) => re.test(model.split('/').pop() ?? model))?.[1]
  if (family) return family
  const host = model.includes('/') ? model.split('/')[0] : ''
  if (host && icons[host]) return host
  return icons[key] ? key : 'unknown'
}

export function ProviderLogo({ id, modelId, className = 'size-4' }: { id: string; modelId?: string | null; className?: string }) {
  const key = logoFor(id, modelId)
  const icon = icons[key]
  const title = icon?.title ?? (id === 'free' ? 'Free pool' : id || 'Worker')
  return icon?.image ? <img className={`${className} dark:brightness-0 dark:invert`} src={icon.image} alt={title} title={title} /> : icon?.path ? <svg className={`${className} dark:brightness-0 dark:invert`} viewBox='0 0 24 24' role='img' aria-label={title} fill='currentColor' style={{ color: `#${icon.color ?? '64748b'}` } as CSSProperties}><title>{title}</title><path d={icon.path} /></svg> : <Bot className={`${className} dark:text-white`} aria-label={title} />
}
