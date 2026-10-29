import { useMemo, useState } from 'react'
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Link, useNavigate } from '@tanstack/react-router'
import { GitBranch, ListChecks, Plus } from 'lucide-react'
import { statusLabel, viaLabel, duration, firstLine } from '@/lib/format'
import type { Job } from '@/lib/types'
import { useJobs } from '@/hooks/queries'
import { useNewJob } from '@/context/new-job-provider'
import { Button } from '@/components/ui/button'
import { DataTable, DataTableColumnHeader, DataTableToolbar } from '@/components/data-table'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { StatusBadge } from '@/components/ekip/status-badge'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'
import { translate, useLanguage, useT } from '@/lib/i18n'
import { ProviderLogo } from '@/components/provider-logo'
import { RunLogButton } from '@/components/run-log-button'

const inList = (row: { getValue: (id: string) => unknown }, id: string, value: string[]) =>
  !value?.length || value.includes(String(row.getValue(id)))

const columns: ColumnDef<Job>[] = [
  {
    accessorKey: 'status',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Durum' />,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: inList,
    meta: { className: 'w-28' },
  },
  {
    id: 'task',
    accessorFn: (j) => firstLine(j.task),
    header: ({ column }) => <DataTableColumnHeader column={column} title='Görev' />,
    cell: ({ row }) => (
      <div className='grid max-w-[16rem] min-w-0 gap-0.5 sm:max-w-md'>
        <Link
          to='/jobs/$id'
          params={{ id: row.original.id }}
          className='truncate font-medium hover:underline'
        >
          {firstLine(row.original.task) || row.original.id}
        </Link>
        <span className='truncate font-mono text-[11px] text-muted-foreground'>
          {row.original.id}
          {row.original.error && ` · ${row.original.error}`}
        </span>
      </div>
    ),
    enableHiding: false,
  },
  {
    accessorKey: 'project',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Proje' />,
    cell: ({ row }) => <span className='font-medium'>{row.original.project}</span>,
    filterFn: inList,
  },
  {
    id: 'via',
    accessorFn: (j) => j.ranVia ?? j.via,
    header: ({ column }) => <DataTableColumnHeader column={column} title='Yol' />,
    cell: ({ row }) => {
      const j = row.original
      return (
        <span className='inline-flex items-center gap-1.5 text-muted-foreground'>
          <ProviderLogo id={j.ranVia ?? j.via} modelId={j.model} />
          {viaLabel(j.ranVia ?? j.via)}
          {j.model && <span className='text-xs'>via · {j.model}</span>}
          {j.pool === 'tdai' && ` · ${translate('hafızalı')}`}
        </span>
      )
    },
    meta: { className: 'hidden lg:table-cell' },
  },
  {
    accessorKey: 'branch',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Dal' />,
    cell: ({ row }) =>
      row.original.branch ? (
        <span className='inline-flex max-w-48 items-center gap-1 font-mono text-xs'>
          <GitBranch className='size-3 shrink-0 text-muted-foreground' aria-hidden='true' />
          <span className='truncate'>{row.original.branch}</span>
        </span>
      ) : (
        <span className='text-muted-foreground'>{translate('Yok')}</span>
      ),
    meta: { className: 'hidden xl:table-cell' },
  },
  {
    accessorKey: 'createdAt',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Oluşturuldu' />,
    cell: ({ row }) => <TimeAgo iso={row.original.createdAt} className='whitespace-nowrap text-muted-foreground' />,
    meta: { className: 'hidden sm:table-cell' },
  },
  {
    id: 'duration',
    accessorFn: (j) =>
      j.startedAt ? (j.finishedAt ? Date.parse(j.finishedAt) : Date.now()) - Date.parse(j.startedAt) : -1,
    header: ({ column }) => <DataTableColumnHeader column={column} title='Süre' />,
    cell: ({ row }) => (
      <span className='whitespace-nowrap text-muted-foreground tabular-nums'>
        {row.original.startedAt ? duration(row.original.startedAt, row.original.finishedAt) : translate('Yok')}
      </span>
    ),
    meta: { className: 'hidden md:table-cell' },
  },
  {
    id: 'log',
    header: () => <span>{translate('Log')}</span>,
    cell: ({ row }) => <RunLogButton id={row.original.id} failed={row.original.status === 'failed'} />,
    enableSorting: false,
    enableHiding: false,
    meta: { className: 'w-24' },
  },
]

export function Jobs() {
  const t = useT()
  const language = useLanguage()
  const jobs = useJobs()
  const navigate = useNavigate()
  const { openNewJob } = useNewJob()
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')

  const data = useMemo(() => jobs.data ?? [], [jobs.data])
  const projectOptions = useMemo(
    () => [...new Set(data.map((j) => j.project))].sort().map((p) => ({ label: p, value: p })),
    [data]
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _id, value) => {
      const locale = language === 'tr' ? 'tr-TR' : 'en-US'
      const v = String(value).toLocaleLowerCase(locale)
      const j = row.original
      return [j.id, j.task, j.project, j.branch ?? ''].some((x) => x.toLocaleLowerCase(locale).includes(v))
    },
    getRowId: (j) => j.id,
    autoResetPageIndex: false,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    initialState: { pagination: { pageSize: 20 } },
  })

  return (
    <>
      <AppHeader />
      <Main>
        <PageTitle
          title={t('İşler')}
          description={t("Sunucuda `ekip job` ile kuyruğa eklenip çalışan işler; Mac kapalıyken de sürer. Mac'teki işçiler Çalıştırmalar sayfasında.")}
          actions={
            <Button onClick={() => openNewJob()}>
              <Plus /> {t('Yeni iş')}
            </Button>
          }
        />
        {jobs.isError ? (
          <QueryError error={jobs.error} onRetry={() => jobs.refetch()} />
        ) : !jobs.isLoading && data.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title={t('Henüz iş yok')}
            description={t('Bir projeye görev verin; hub ayrı bir dalda çalıştırıp sonucu raporlar.')}
            action={
              <Button onClick={() => openNewJob()}>
                <Plus /> {t('Yeni iş')}
              </Button>
            }
          />
        ) : (
          <div className='flex flex-col gap-4'>
            <DataTableToolbar
              table={table}
              searchPlaceholder={t('Görev, kimlik veya dal ara…')}
              filters={[
                {
                  columnId: 'status',
                  title: 'Durum',
                  options: ['queued', 'running', 'done', 'failed', 'cancelled'].map((value) => ({
                    value,
                    label: statusLabel(value),
                  })),
                },
                { columnId: 'project', title: 'Proje', options: projectOptions },
              ]}
            />
            <DataTable
              table={table}
              loading={jobs.isLoading}
              empty={t('Filtrelere uyan iş yok.')}
              onRowClick={(row) => navigate({ to: '/jobs/$id', params: { id: row.original.id } })}
            />
          </div>
        )}
      </Main>
    </>
  )
}
