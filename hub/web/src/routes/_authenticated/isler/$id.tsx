import { createFileRoute } from '@tanstack/react-router'
import { JobDetail } from '@/features/jobs/job-detail'

export const Route = createFileRoute('/_authenticated/isler/$id')({ component: JobDetail })
