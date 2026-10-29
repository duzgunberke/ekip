import { type SVGProps, useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * The ekip mark: a terminal prompt (the lead, amber) that fans out to three workers (teal).
 * Self-contained tile, so it reads the same on light and dark surfaces.
 */
export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const id = useId().replace(/:/g, '')
  return (
    <svg
      viewBox='0 0 64 64'
      xmlns='http://www.w3.org/2000/svg'
      aria-hidden='true'
      className={cn('size-8 shrink-0', className)}
      {...props}
    >
      <defs>
        <linearGradient id={`${id}bg`} x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stopColor='#1A1D24' />
          <stop offset='1' stopColor='#0E1014' />
        </linearGradient>
        <linearGradient id={`${id}lead`} x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stopColor='#FFB45C' />
          <stop offset='1' stopColor='#F07B3F' />
        </linearGradient>
        <linearGradient id={`${id}team`} x1='0' y1='0' x2='1' y2='0'>
          <stop offset='0' stopColor='#5EEAD4' />
          <stop offset='1' stopColor='#2DD4BF' />
        </linearGradient>
      </defs>
      <rect width='64' height='64' rx='16' fill={`url(#${id}bg)`} />
      <rect x='.75' y='.75' width='62.5' height='62.5' rx='15.25' fill='none' stroke='#fff' strokeOpacity='.08' strokeWidth='1.5' />
      <path d='M14 20 26 32 14 44' fill='none' stroke={`url(#${id}lead)`} strokeWidth='6' strokeLinecap='round' strokeLinejoin='round' />
      <g fill='none' stroke={`url(#${id}team)`} strokeWidth='3' strokeLinecap='round' opacity='.9'>
        <path d='M30 32c8 0 10-13 17-13' />
        <path d='M30 32h17' />
        <path d='M30 32c8 0 10 13 17 13' />
      </g>
      <g fill='#5EEAD4'>
        <circle cx='49.5' cy='19' r='4' />
        <circle cx='49.5' cy='32' r='4' />
        <circle cx='49.5' cy='45' r='4' />
      </g>
    </svg>
  )
}
