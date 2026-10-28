import { type SVGProps, useId } from 'react'
import { cn } from '@/lib/utils'

/** ekip mark: same artwork as /favicon.svg. */
export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const id = useId()
  return (
    <svg
      viewBox='0 0 32 32'
      xmlns='http://www.w3.org/2000/svg'
      aria-hidden='true'
      className={cn('size-8 shrink-0', className)}
      {...props}
    >
      <defs>
        <linearGradient id={id} x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stopColor='#3b5bdb' />
          <stop offset='1' stopColor='#1971c2' />
        </linearGradient>
      </defs>
      <rect width='32' height='32' rx='8' fill={`url(#${id})`} />
      <circle cx='11' cy='13' r='3.2' fill='#fff' />
      <circle cx='21' cy='13' r='3.2' fill='#fff' />
      <path
        d='M6 25c1-4 3.5-6 5-6s4 2 5 6M16 25c1-4 3.5-6 5-6s4 2 5 6'
        stroke='#fff'
        strokeWidth='2'
        fill='none'
        strokeLinecap='round'
      />
    </svg>
  )
}
