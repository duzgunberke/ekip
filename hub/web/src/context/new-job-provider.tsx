import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { NewJobDialog } from '@/features/jobs/new-job-dialog'

type NewJobContextType = { openNewJob: (project?: string) => void }

const NewJobContext = createContext<NewJobContextType | null>(null)

export function NewJobProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState<string | undefined>()
  const openNewJob = useCallback((p?: string) => {
    setProject(p)
    setOpen(true)
  }, [])
  const value = useMemo(() => ({ openNewJob }), [openNewJob])
  return (
    <NewJobContext value={value}>
      {children}
      <NewJobDialog open={open} onOpenChange={setOpen} project={project} />
    </NewJobContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNewJob() {
  const ctx = useContext(NewJobContext)
  if (!ctx) throw new Error('useNewJob must be used within NewJobProvider')
  return ctx
}
