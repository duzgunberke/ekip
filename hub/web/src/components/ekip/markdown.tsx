import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/** GitHub-flavoured markdown; raw HTML is not rendered (react-markdown's default). */
export function Md({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none dark:prose-invert',
        'prose-headings:scroll-mt-20 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-lg prose-h3:text-base',
        'prose-a:text-primary prose-a:underline-offset-4',
        'prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none',
        'prose-pre:border prose-pre:bg-muted/60 prose-pre:text-foreground',
        'prose-table:block prose-table:overflow-x-auto prose-th:text-start',
        'break-words',
        className
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target='_blank' rel='noopener noreferrer' />,
          img: ({ node: _n, alt }) => <span className='text-muted-foreground'>[görsel: {alt}]</span>,
        }}
      >
        {children}
      </Markdown>
    </div>
  )
}
