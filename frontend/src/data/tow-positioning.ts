import { allRows, saveAll } from './local-store'
import { MODULE_BY_KEY } from './modules'
import type { ActionResult, EntryRow } from './types'

/**
 * 航空器牵引落位领域：停机位占用台账（stand）是机位占用的唯一权威数据。
 *
 * 优先级依据：机位台账记录的是物理机位此刻停着哪架飞机，是现场安全事实；任务状态只是
 * 流程标签，可能因为漏点确认、重复确认、跳步操作而与现场不一致。因此机位占用与任务状态
 * 冲突时，一律以机位占用台账为准——落位以台账为准入（目标已被别的航班占用就拒绝落位），
 * 展示以台账为唯一来源（已完成任务若在台账上查不到本航班，不算占用，避免同一机位挂两趟航班）。
 */

export const TOW_KEY = 'tow'
export const STAND_KEY = 'stand'

export const TOW_PENDING = '待牵引'
export const TOW_TOWING = '牵引中'
export const TOW_UNCONFIRMED = '待确认'
export const TOW_DONE = '已完成'

export const STAND_FREE = '空闲'
export const STAND_OCCUPIED = '占用中'

// 台账字段
export const F_STAND_NO = '机位编号'
export const F_STAND_FLIGHT = '当前航班'
export const F_STAND_WINDOW = '占用时段'

// 牵引任务字段
export const F_NO = '任务编号'
export const F_FLIGHT = '航班号'
export const F_TRACTOR = '牵引车号'
export const F_ORIGIN = '起始机位'
export const F_TARGET = '目标机位'
export const F_DRIVER = '驾驶员'
export const F_ESCORT = '护送人员'
export const F_STARTED_AT = '开始时间'
export const F_LANDED_AT = '落位时间'

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value).trim()
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function findStandByNo(stands: EntryRow[], standNo: string): EntryRow | undefined {
  const wanted = standNo.trim()
  return stands.find((stand) => text(stand, F_STAND_NO) === wanted)
}

export function standsOccupiedBy(stands: EntryRow[], flight: string): EntryRow[] {
  const wanted = flight.trim()
  if (!wanted) {
    return []
  }
  return stands.filter((stand) => text(stand, F_STAND_FLIGHT) === wanted)
}

/** 机位当前是否可被指定航班落位占用；占用冲突时返回占用方航班号。 */
function standClaim(stand: EntryRow | undefined, flight: string): { ok: true } | { ok: false; reason: string } {
  if (!stand) {
    return { ok: false, reason: '目标机位在停机位台账中不存在，无法落位' }
  }
  const currentFlight = text(stand, F_STAND_FLIGHT)
  if (currentFlight && currentFlight !== flight.trim()) {
    // 台账优先：不覆盖新的占用
    return { ok: false, reason: `目标机位已被航班「${currentFlight}」占用（以机位台账为准），本任务不能覆盖落位` }
  }
  return { ok: true }
}

export type TowViewRow = EntryRow & {
  航班号: string
  牵引车号: string
  护送人员: string
  起始机位: string
  目标机位: string
  开始时间: string
  落位时间: string
  /** 权威机位占用：落位结果以机位台账实时反查，列表与详情弹窗取的是同一份值。 */
  权威机位: string
  当前占用航班: string
  占用冲突: boolean
  落位说明: string
}

/**
 * 落位视图的唯一取数口径：任务自身的登记字段 + 台账反查。
 * 牵引车、起始机位、护送人员三处登记展示的落位结果都从这里出，不允许各取一份。
 */
export function hydrateTowRow(task: EntryRow, stands: EntryRow[]): TowViewRow {
  const flight = text(task, F_FLIGHT)
  const origin = text(task, F_ORIGIN)
  const target = text(task, F_TARGET)
  const landedAt = text(task, F_LANDED_AT)
  const status = String(task.status)

  const holding = standsOccupiedBy(stands, flight)
  const ledgerStand = holding.length > 0 ? text(holding[0], F_STAND_NO) : ''

  let authoritative = ''
  let note = ''
  let conflict = false

  if (status === TOW_DONE) {
    if (holding.length > 1) {
      // 台账上同一航班占了多个机位，属于台账脏数据，照实展示
      authoritative = holding.map((stand) => text(stand, F_STAND_NO)).join('、')
      conflict = true
      note = '机位台账显示该航班同时占用多个机位，请现场核对台账'
    } else if (ledgerStand) {
      authoritative = ledgerStand
      if (target && ledgerStand !== target) {
        conflict = true
        note = `台账当前机位为「${ledgerStand}」，与登记的目标机位「${target}」不一致，以机位台账为准`
      } else {
        note = `已落位，占用以机位台账「${ledgerStand}」为准`
      }
    } else {
      // 已完成但台账无占用：任务状态不算占用，避免旧航班继续挂在机位上
      conflict = true
      note = '任务已完成，但机位台账上没有该航班的占用，落位结果缺失，请核对机位台账'
    }
  } else if (status === TOW_UNCONFIRMED) {
    authoritative = ledgerStand || target
    note = ledgerStand
      ? `待现场确认；台账已登记占用「${ledgerStand}」`
      : target
        ? `待确认，目标机位「${target}」尚未落位，当前不占用该机位`
        : '待确认，尚未登记目标机位'
  } else if (status === TOW_TOWING) {
    authoritative = ledgerStand || origin
    note = '牵引过程中，占用以机位台账为准'
  } else {
    authoritative = ledgerStand || origin
    note = origin ? `未开始牵引，按台账仍在起始机位「${origin}」` : '尚未开始牵引'
  }

  const targetStand = findStandByNo(stands, target)
  const targetFlight = targetStand ? text(targetStand, F_STAND_FLIGHT) : ''
  if (
    !conflict &&
    target &&
    targetFlight &&
    targetFlight !== flight &&
    (status === TOW_UNCONFIRMED || status === TOW_TOWING || status === TOW_PENDING)
  ) {
    conflict = true
    note = `目标机位「${target}」当前被航班「${targetFlight}」占用（以机位台账为准），确认完成将被挡回`
  }

  return {
    ...task,
    航班号: flight,
    牵引车号: text(task, F_TRACTOR),
    护送人员: text(task, F_ESCORT),
    起始机位: origin,
    目标机位: target,
    开始时间: text(task, F_STARTED_AT),
    落位时间: landedAt,
    权威机位: authoritative,
    当前占用航班: ledgerStand ? flight : '',
    占用冲突: conflict,
    落位说明: note,
  }
}

export function listTowViews(stands: EntryRow[] = allRows()[STAND_KEY] ?? []): TowViewRow[] {
  return (allRows()[TOW_KEY] ?? []).map((task) => hydrateTowRow(task, stands))
}

export type StandOccupancy = {
  机位编号: string
  机位状态: string
  当前航班: string
  占用时段: string
}

/** 落位视图的机位占用面板：只认台账，不统计任何任务状态。 */
export function listStandOccupancy(): StandOccupancy[] {
  return (allRows()[STAND_KEY] ?? []).map((stand) => ({
    机位编号: text(stand, F_STAND_NO),
    机位状态: String(stand.status),
    当前航班: text(stand, F_STAND_FLIGHT),
    占用时段: text(stand, F_STAND_WINDOW),
  }))
}

/**
 * 落位事务：牵引任务完成与机位台账占用更新在同一笔写入里完成。
 * - 重复确认完成只落位一次（已带落位时间或台账已是本航班时直接幂等返回成功，不覆盖新占用）；
 * - 目标机位被别的航班占用时，以台账为准拒绝落位，任务保持原状态；
 * - 起始机位当前确为本航班时同步释放，被别的航班占用则不动台账只给提示。
 */
function landTowTask(
  task: EntryRow,
  tasks: EntryRow[],
  stands: EntryRow[],
  stamp: string,
): { tasks: EntryRow[]; stands: EntryRow[]; result: ActionResult } {
  const flight = text(task, F_FLIGHT)
  const target = text(task, F_TARGET)
  const origin = text(task, F_ORIGIN)

  if (!target) {
    return { tasks, stands, result: { ok: false, message: '该牵引任务未登记目标机位，无法落位' } }
  }
  const targetIndex = stands.findIndex((stand) => text(stand, F_STAND_NO) === target)
  const targetStand = targetIndex >= 0 ? stands[targetIndex] : undefined
  const claim = standClaim(targetStand, flight)
  if (!claim.ok) {
    return { tasks, stands, result: { ok: false, message: claim.reason } }
  }

  const nextStands = [...stands]

  // 目标台账已是本航班：视为已落位，幂等放行，不覆盖任何占用信息
  const alreadyLanded = targetStand !== undefined && text(targetStand, F_STAND_FLIGHT) === flight.trim()

  if (targetStand && !alreadyLanded) {
    nextStands[targetIndex] = {
      ...targetStand,
      status: STAND_OCCUPIED,
      [F_STAND_FLIGHT]: flight,
      [F_STAND_WINDOW]: text(targetStand, F_STAND_WINDOW) || stamp,
    }
  }

  let originNote = ''
  if (origin && origin !== target) {
    const originIndex = nextStands.findIndex((stand) => text(stand, F_STAND_NO) === origin)
    const originStand = originIndex >= 0 ? nextStands[originIndex] : undefined
    if (originStand && text(originStand, F_STAND_FLIGHT) === flight) {
      nextStands[originIndex] = {
        ...originStand,
        status: STAND_FREE,
        [F_STAND_FLIGHT]: '',
        [F_STAND_WINDOW]: '',
      }
    } else if (originStand && text(originStand, F_STAND_FLIGHT)) {
      originNote = `；起始机位「${origin}」被航班「${text(originStand, F_STAND_FLIGHT)}」占用，未释放`
    }
  }

  const taskIndex = tasks.findIndex((row) => Number(row.id) === Number(task.id))
  const nextTasks = [...tasks]
  const previousLandedAt = text(task, F_LANDED_AT)
  nextTasks[taskIndex] = {
    ...task,
    status: TOW_DONE,
    pending: false,
    abnormal: false,
    [F_LANDED_AT]: previousLandedAt || stamp,
  }

  return {
    tasks: nextTasks,
    stands: nextStands,
    result: {
      ok: true,
      message: alreadyLanded
        ? `落位已存在（目标机位「${target}」台账为本航班），未重复落位，任务标记已完成`
        : `牵引任务已确认完成，航班「${flight}」落位至「${target}」，台账已同步${originNote}`,
    },
  }
}

/** 牵引模块动作入口：状态机校验 + 「确认完成」落位事务，全部收口在这里。 */
export function runTowAction(id: number, action: string): ActionResult {
  const meta = MODULE_BY_KEY.get(TOW_KEY)!
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const data = allRows()
  const tasks = [...(data[TOW_KEY] ?? [])]
  const stands = [...(data[STAND_KEY] ?? [])]
  const index = tasks.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const task = tasks[index]
  const current = String(task.status)
  const requiredSource = meta.actionSources?.[action]

  if (current === TOW_DONE) {
    return { ok: false, message: '牵引任务已完成，终态不可再操作，不能回到待确认或重复落位' }
  }
  if (requiredSource && current !== requiredSource) {
    return {
      ok: false,
      message: `「${action}」要求任务处于「${requiredSource}」，当前为「${current}」，不能跳步操作`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  if (action === '确认完成') {
    const landed = text(task, F_LANDED_AT)
    if (landed) {
      // 重复确认完成：只落位一次，不覆盖新占用
      return { ok: false, message: `该任务已于 ${landed} 完成落位，重复确认不会再次落位或覆盖台账占用` }
    }
    const tx = landTowTask(task, tasks, stands, nowStamp())
    if (!tx.result.ok) {
      return tx.result
    }
    saveAll({ ...data, [TOW_KEY]: tx.tasks, [STAND_KEY]: tx.stands })
    return tx.result
  }

  // 开始牵引 / 提交确认：仅推进状态；开始牵引时补记开始时间，作为存量回填之外的排序依据
  const stamp = nowStamp()
  const updated: EntryRow = {
    ...task,
    status: target,
    pending: target !== TOW_DONE,
    ...(action === '开始牵引' && !text(task, F_STARTED_AT) ? { [F_STARTED_AT]: stamp } : {}),
  }
  tasks[index] = updated
  saveAll({ ...data, [TOW_KEY]: tasks })
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---- 存量数据迁移：已完成却没落位的任务，按开始时间回填机位台账 -------------------

const MIGRATION_FLAG = 'airport-ground-ops:tow-positioning-migrated'
let migrated = false

export function isTowMigrated(): boolean {
  if (migrated) {
    return true
  }
  if (typeof window !== 'undefined' && window.localStorage?.getItem(MIGRATION_FLAG) === '1') {
    migrated = true
    return true
  }
  return false
}

export function resetTowMigration(): void {
  migrated = false
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(MIGRATION_FLAG)
  }
}

function comparableTime(value: string): number {
  const t = Date.parse(value.replace(' ', 'T'))
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

/**
 * 回填老记录：任务状态=已完成但没有落位时间（即历史版本「确认完成只改状态、不写台账」留下的数据）。
 * 按开始时间升序逐条落位，模拟真实发生顺序：
 * - 目标机位台账为空或已被本航班占用 → 落位（本航班占用时幂等，不覆盖）；
 * - 目标机位已被另一趟航班占用 → 不覆盖新占用，任务保留落位缺失并打异常标记；
 * - 起始机位仍登记为本航班 → 同步释放。
 */
export function ensureTowPositioningMigration(): void {
  if (isTowMigrated()) {
    return
  }
  const data = allRows()
  let tasks = [...(data[TOW_KEY] ?? [])]
  let stands = [...(data[STAND_KEY] ?? [])]
  let changed = false

  const pendingBackfill = tasks
    .map((task, originalIndex) => ({ task, originalIndex }))
    .filter(({ task }) => String(task.status) === TOW_DONE && !text(task, F_LANDED_AT))
    .sort(
      (a, b) =>
        comparableTime(text(a.task, F_STARTED_AT)) - comparableTime(text(b.task, F_STARTED_AT)) ||
        Number(a.task.id) - Number(b.task.id),
    )

  for (const { task } of pendingBackfill) {
    const flight = text(task, F_FLIGHT)
    const target = text(task, F_TARGET)
    const origin = text(task, F_ORIGIN)
    const startedAt = text(task, F_STARTED_AT)
    const stamp = startedAt || nowStamp()
    const targetStand = findStandByNo(stands, target)

    if (!target || !targetStand) {
      changed = true
      markTaskMissing(tasks, task, stamp, '目标机位未登记或不在台账中，无法回填落位')
      continue
    }

    const currentFlight = text(targetStand, F_STAND_FLIGHT)
    if (currentFlight && currentFlight !== flight) {
      // 台账优先：老任务不允许覆盖新占用
      changed = true
      markTaskMissing(
        tasks,
        task,
        stamp,
        `回填时目标机位已被航班「${currentFlight}」占用，以机位台账为准，未覆盖`,
      )
      continue
    }

    const tx = landTowTask(task, tasks, stands, stamp)
    if (tx.result.ok) {
      // landTowTask 已把落位时间补成开始时间（stamp），任务与台账一并落到下一轮输入
      tasks = tx.tasks
      stands = tx.stands
      changed = true
    } else {
      markTaskMissing(tasks, task, stamp, tx.result.message)
      changed = true
    }
  }

  migrated = true
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(MIGRATION_FLAG, '1')
  }
  if (changed) {
    saveAll({ ...data, [TOW_KEY]: tasks, [STAND_KEY]: stands })
  }
}

function markTaskMissing(tasks: EntryRow[], task: EntryRow, stamp: string, reason: string): void {
  const idx = tasks.findIndex((row) => Number(row.id) === Number(task.id))
  if (idx < 0) {
    return
  }
  tasks[idx] = {
    ...tasks[idx],
    pending: false,
    abnormal: true,
    [F_LANDED_AT]: '',
    落位异常: reason,
    回填时间: stamp,
  }
}
