import { useMemo, useState } from 'react'
import {
  type ColumnDef,
  type ColumnFiltersState,
  type ExpandedState,
  type SortingState,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { ChevronRight, History } from 'lucide-react'
import { STATUS_LABEL, duration, firstLine, normalizeRunStatus } from '@/lib/format'
import type { Run } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useRuns } from '@/hooks/queries'
import { Button } from '@/components/ui/button'
import { DataTable, DataTableColumnHeader, DataTableToolbar } from '@/components/data-table'
import { AppHeader, PageTitle } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { Md } from '@/components/ekip/markdown'
import { StatusBadge } from '@/components/ekip/status-badge'
import { EmptyState, QueryError } from '@/components/ekip/states'
import { TimeAgo } from '@/components/ekip/time-ago'

const when = (r: Run) => r.finishedAt ?? r.startedAt ?? r.receivedAt
const inList = (row: { getValue: (id: string) => unknown }, id: string, value: string[]) =>
  !value?.length || value.includes(String(row.getValue(id)))

const columns: ColumnDef<Run>[] = [
  {
    id: 'expand',
    header: () => <span className='sr-only'>Aç/kapat</span>,
    cell: ({ row }) => (
      <Button
        variant='ghost'
        size='icon'
        className='size-7'
        aria-expanded={row.getIsExpanded()}
        aria-label={row.getIsExpanded() ? 'Raporu gizle' : 'Raporu göster'}
        onClick={() => row.toggleExpanded()}
      >
        <ChevronRight className={cn('transition-transform', row.getIsExpanded() && 'rotate-90')} />
      </Button>
    ),
    enableSorting: false,
    enableHiding: false,
    meta: { className: 'w-10 pe-0' },
  },
  {
    id: 'status',
    accessorFn: (r) => normalizeRunStatus(r.status),
    header: ({ column }) => <DataTableColumnHeader column={column} title='Durum' />,
    cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
    filterFn: inList,
    meta: { className: 'w-28' },
  },
  {
    id: 'task',
    accessorFn: (r) => firstLine(r.task) || r.id,
    header: ({ column }) => <DataTableColumnHeader column={column} title='Görev' />,
    cell: ({ row, getValue }) => (
      <div className='grid max-w-[14rem] min-w-0 gap-0.5 sm:max-w-md'>
        <span className='truncate font-medium'>{getValue<string>()}</span>
        <span className='truncate font-mono text-[11px] text-muted-foreground'>{row.original.id}</span>
      </div>
    ),
    enableHiding: false,
  },
  {
    id: 'project',
    accessorFn: (r) => r.project ?? '—',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Proje' />,
    filterFn: inList,
    meta: { className: 'hidden sm:table-cell' },
  },
  {
    id: 'via',
    accessorFn: (r) => r.via ?? '—',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Yol' />,
    cell: ({ getValue }) => <span className='text-muted-foreground'>{getValue<string>()}</span>,
    meta: { className: 'hidden md:table-cell' },
  },
  {
    id: 'host',
    accessorFn: (r) => r.host ?? '—',
    header: ({ column }) => <DataTableColumnHeader column={column} title='Makine' />,
    cell: ({ getValue }) => <span className='font-mono text-xs text-muted-foreground'>{getValue<string>()}</span>,
    meta: { className: 'hidden lg:table-cell' },
  },
  {
    id: 'when',
    accessorFn: (r) => when(r),
    header: ({ column }) => <DataTableColumnHeader column={column} title='Zaman' />,
    cell: ({ row }) => (
      <div className='grid text-xs whitespace-nowrap'>
        <TimeAgo iso={when(row.original)} />
        {row.original.startedAt && (
          <span className='text-muted-foreground tabular-nums'>
            {duration(row.original.startedAt, row.original.finishedAt)}
          </span>
        )}
      </div>
    ),
  },
]

export function Runs() {
  const runs = useRuns()
  const [sorting, setSorting] = useState<SortingState>([{ id: 'when', desc: true }])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [expanded, setExpanded] = useState<ExpandedState>({})
  const data = useMemo(() => runs.data ?? [], [runs.data])

  const projectOptions = useMemo(
    () => [...new Set(data.map((r) => r.project ?? '—'))].sort().map((p) => ({ label: p, value: p })),
    [data]
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnFilters, globalFilter, expanded },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
    getRowId: (r) => r.id,
    autoResetPageIndex: false,
    autoResetExpanded: false,
    globalFilterFn: (row, _id, value) => {
      const v = String(value).toLocaleLowerCase('tr')
      const r = row.original
      return [r.id, r.task, r.project ?? '', r.via ?? '', r.host ?? ''].some((x) => x.toLocaleLowerCase('tr').includes(v))
    },
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
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
          title='Çalıştırmalar'
          description="Mac'teki ekip'in yerel olarak çalıştırıp hub'a bildirdiği görevler."
        />
        {runs.isError ? (
          <QueryError error={runs.error} onRetry={() => runs.refetch()} />
        ) : !runs.isLoading && data.length === 0 ? (
          <EmptyState
            icon={History}
            title='Bildirilen çalıştırma yok'
            description="Mac'teki ekip bitirdiği işleri POST /api/runs ile buraya gönderir."
          />
        ) : (
          <div className='flex flex-col gap-4'>
            <DataTableToolbar
              table={table}
              searchPlaceholder='Görev, proje veya makine ara…'
              filters={[
                {
                  columnId: 'status',
                  title: 'Durum',
                  options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
                },
                { columnId: 'project', title: 'Proje', options: projectOptions },
              ]}
            />
            <DataTable
              table={table}
              loading={runs.isLoading}
              empty='Filtrelere uyan çalıştırma yok.'
              onRowClick={(row) => row.toggleExpanded()}
              renderExpanded={(row) => <RunDetail run={row.original} />}
            />
          </div>
        )}
      </Main>
    </>
  )
}

function RunDetail({ run: r }: { run: Run }) {
  return (
    <div className='grid gap-4 px-4 py-4 sm:px-6 lg:grid-cols-5'>
      <section className='lg:col-span-2'>
        <h3 className='mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase'>Görev</h3>
        <pre className='max-h-80 overflow-auto rounded-md border bg-background p-3 font-sans text-sm whitespace-pre-wrap'>
          {r.task || '—'}
        </pre>
        <dl className='mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs'>
          <dt className='text-muted-foreground'>Proje</dt>
          <dd>{r.project ?? '—'}</dd>
          <dt className='text-muted-foreground'>Yol</dt>
          <dd>{r.via ?? '—'}</dd>
          <dt className='text-muted-foreground'>Makine</dt>
          <dd className='font-mono'>{r.host ?? '—'}</dd>
          <dt className='text-muted-foreground'>Durum (ham)</dt>
          <dd className='font-mono'>{r.status ?? '—'}</dd>
        </dl>
      </section>
      <section className='min-w-0 lg:col-span-3'>
        <h3 className='mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase'>Rapor</h3>
        <div className='max-h-[28rem] overflow-auto rounded-md border bg-background p-4'>
          {r.report?.trim() ? <Md>{r.report}</Md> : <p className='text-sm text-muted-foreground'>Rapor yok.</p>}
        </div>
      </section>
    </div>
  )
}
