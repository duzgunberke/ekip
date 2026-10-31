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
  siAnthropic, siGithubcopilot, siGoogle, siDeepseek, siQwen, siNvidia, siOpenrouter, siOvh, siHuggingface,
  siCloudflare, siModelscope, siMeta, siKimi, siMinimax, siOpencode,
} from 'simple-icons'
// Which logo stands for which pool or provider: one list for the panel and the terminal (the terminal
// gets it with its PNGs from scripts/render-logos.mjs; plugin/lib/workers/logos.test.mjs keeps them equal).
import logos from '@/lib/logos.json'

const lobehub: Record<string, string> = {
  openai: openaiLogo, antigravity: antigravityLogo, zhipu: zhipuLogo, groq: groqLogo, mistral: mistralLogo,
  cohere: cohereLogo, xai: xaiLogo, cerebras: cerebrasLogo, gemini: geminiLogo,
}
const simpleIcons: Record<string, { path: string; hex: string }> = {
  anthropic: siAnthropic, githubcopilot: siGithubcopilot, google: siGoogle, deepseek: siDeepseek, qwen: siQwen, nvidia: siNvidia,
  openrouter: siOpenrouter, ovh: siOvh, huggingface: siHuggingface, cloudflare: siCloudflare, modelscope: siModelscope,
  meta: siMeta, kimi: siKimi, minimax: siMinimax, opencode: siOpencode,
}

const icons: Record<string, { title: string; path?: string; image?: string; color?: string }> = Object.fromEntries(
  Object.entries(logos.icons).map(([key, { title, logo }]) => {
    const [pkg, name] = logo.split(':')
    if (pkg === 'lobehub') return [key, { title, image: lobehub[name] }]
    const si = simpleIcons[name]
    return [key, { title, path: si?.path, color: si?.hex }]
  }),
)

// What a worker ran on, most telling first: the model family ("openrouter/deepseek-v4" is DeepSeek,
// "groq/openai/gpt-oss-120b" is OpenAI), then the host in front of the slash, then the pool itself.
const FAMILIES: [RegExp, string][] = logos.families.map(([re, key]) => [new RegExp(re), key])

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
