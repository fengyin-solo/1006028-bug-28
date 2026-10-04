import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  ensureTowPositioningMigration,
  hydrateTowRow,
  listTowViews,
  resetTowMigration,
  runTowAction,
  TOW_KEY,
} from '@/data/tow-positioning'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 落位相关数据（牵引清单、机位台账）在任何一次读取前先保证存量回填已跑完，
// 这样清单页、详情弹窗、机位页拿到的都是同一份迁移后的权威数据。
function ensureReady(key: string): void {
  if (key === TOW_KEY || key === 'stand') {
    ensureTowPositioningMigration()
  }
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  ensureReady(key)
  // 牵引清单读的是「任务登记 + 机位台账反查」的合并视图，落位结果以台账为准，
  // 与详情弹窗、机位占用面板同源，杜绝已完成任务被继续算作占用。
  const source = key === TOW_KEY ? listTowViews() : listRows(key)
  const matched = filterRows(source, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 详情弹窗取单条：与清单走同一个 hydrate 口径，两处看到的占用必然一致。
export function getTowEntry(id: number): EntryRow | undefined {
  ensureReady(TOW_KEY)
  const all = allRows()
  const task = (all[TOW_KEY] ?? []).find((row) => Number(row.id) === id)
  return task ? hydrateTowRow(task, all.stand ?? []) : undefined
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === TOW_KEY) {
    ensureReady(key)
    // 牵引动作全部走落位领域：状态机校验、台账落位事务都在里面收口
    return runTowAction(id, action)
  }

  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  if (current === lastStatus) {
    return { ok: false, message: `${meta.entity}已处于终态「${lastStatus}」，不能再操作` }
  }
  // 通用前置态约束：登记了 actionSources 的模块必须从指定状态过来，跳步挡回
  const requiredSource = meta.actionSources?.[action]
  if (requiredSource && current !== requiredSource) {
    return {
      ok: false,
      message: `「${action}」要求${meta.entity}处于「${requiredSource}」，当前为「${current}」，不能跳步操作`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  // 牵引与机位台账同源：只重置一边会让台账占用和任务对不上，重置时两边一起回到示例数据。
  if (key === TOW_KEY || key === 'stand') {
    resetTowMigration()
    resetRows(TOW_KEY)
    resetRows('stand')
    return listEntries(key)
  }
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  ensureReady(key)
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listEntries(key).items) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  ensureTowPositioningMigration()
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
