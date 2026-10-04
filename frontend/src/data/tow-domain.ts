import { allRows, commitAll, listRows } from './local-store'
import type { ActionResult, EntryRow } from './types'

/**
 * 航空器牵引领域：落位的唯一写入口与唯一取数口径。
 *
 * 权威约定（冲突时谁优先的依据）：
 * 停机位占用台账（stand 模块）描述的是「这块机位此刻物理上是谁占着」，是现场事实；
 * 牵引任务状态只描述流程进度。物理安全上一块机位不可能同时落两架机，因此
 *   1) 一切「当前占用 / 落位结果」只读机位占用台账，不得用任务状态反推占用；
 *   2) 台账与任务状态冲突时台账优先：任务确认完成不得把别的航班从目标机位上盖掉，
 *      冲突一律挡回待人工核对，而不是拿流程状态覆盖物理事实。
 * 任务落位与台账更新必须走 commitAll 同一笔提交：要么一起生效，要么都不动。
 */

export const TOW_KEY = 'tow'
export const STAND_KEY = 'stand'

export const TOW_STATUSES = ['待牵引', '牵引中', '待确认', '已完成'] as const
export const TOW_DONE = '已完成'
// 每个状态只允许一个下一步动作：跳步（含从已完成往回走）在这里和入口侧各挡一遍。
export const NEXT_ACTION: Record<string, { action: string; status: string }> = {
  待牵引: { action: '开始牵引', status: '牵引中' },
  牵引中: { action: '提交确认', status: '待确认' },
  待确认: { action: '确认完成', status: '已完成' },
}

const FIELD_NO = '任务编号'
const FIELD_FLIGHT = '航班号'
const FIELD_TRACTOR = '牵引车号'
const FIELD_FROM = '起始机位'
const FIELD_TO = '目标机位'
const FIELD_DRIVER = '驾驶员'
const FIELD_ESCORT = '护送人员'
const FIELD_START = '开始时间'
const FIELD_TASK_STATUS = '任务状态'
const FIELD_PARKED_AT = '落位机位'
const FIELD_PARKED_TIME = '落位时间'
const FIELD_BACKFILL_CONFLICT = '回填冲突'

const STAND_CODE = '机位编号'
const STAND_FLIGHT = '当前航班'
const STAND_SLOT = '占用时段'
const STAND_STATE_FIELD = '机位状态'
const STAND_BUSY = '占用中'
const STAND_FREE = '空闲'

function text(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value).trim()
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function standMap(stands: EntryRow[]): Map<string, EntryRow> {
  return new Map(stands.map((row) => [text(row, STAND_CODE), row]))
}

/** 机位是否被实际占用：只认台账的「占用中 + 当前航班」，任务状态不参与判断。 */
export function standOccupied(stand: EntryRow | undefined): boolean {
  return !!stand && String(stand.status) === STAND_BUSY && text(stand, STAND_FLIGHT) !== ''
}

type ParkCheck = { ok: boolean; reason?: string }

/** 落位前置校验：目标机位必须在台账里、非维护/封闭，且不能压在别的航班上。 */
function checkParkable(target: EntryRow | undefined, flight: string, standCode: string): ParkCheck {
  if (!target) {
    return { ok: false, reason: `目标机位 ${standCode} 不在停机位占用台账中，无法落位，请先登记机位` }
  }
  const state = String(target.status)
  if (state === '维护中' || state === '已封闭') {
    return { ok: false, reason: `目标机位 ${standCode} 当前「${state}」，不能落位` }
  }
  if (standOccupied(target) && text(target, STAND_FLIGHT) !== flight) {
    return {
      ok: false,
      reason: `目标机位 ${standCode} 已被航班 ${text(target, STAND_FLIGHT)} 占用（机位台账优先），不能覆盖新的占用，请先核实机位分配`,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 读侧：派生字段。清单表格行与详情弹窗拿的是同一个 enrich 结果，不可能对不上。
// ---------------------------------------------------------------------------

export type EnrichedTow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | string[]
  落位结果: string
  台账机位状态: string
  台账当前航班: string
  允许动作: string[]
}

export function enrichTow(row: EntryRow, stands: Map<string, EntryRow>): EnrichedTow {
  const flight = text(row, FIELD_FLIGHT)
  const targetCode = text(row, FIELD_TO)
  const target = stands.get(targetCode)
  const ledgerFlight = target ? text(target, STAND_FLIGHT) : ''
  let result: string

  if (!target) {
    result = `未落位：目标机位 ${targetCode || '（空）'} 未登记`
  } else if (String(row.status) !== TOW_DONE) {
    result = `未落位（任务${String(row.status)}）`
  } else if (standOccupied(target) && ledgerFlight === flight) {
    result = `已落位 · ${targetCode}`
  } else if (String(row.status) === TOW_DONE && row[FIELD_BACKFILL_CONFLICT]) {
    result = `历史未落位 · ${targetCode} 现为 ${ledgerFlight || '空闲'}`
  } else if (standOccupied(target)) {
    result = `台账冲突 · ${targetCode} 现为 ${ledgerFlight}`
  } else if (text(row, FIELD_PARKED_AT)) {
    result = `台账已释放 · ${targetCode}`
  } else {
    result = '未落位'
  }

  return {
    ...row,
    落位结果: result,
    台账机位状态: target ? String(target.status) : '未登记',
    台账当前航班: ledgerFlight || (target ? '空闲' : '—'),
    允许动作: NEXT_ACTION[String(row.status)] ? [NEXT_ACTION[String(row.status)].action] : [],
  }
}

export function enrichTows(rows: EntryRow[]): EnrichedTow[] {
  const stands = standMap(listRows(STAND_KEY))
  return rows.map((row) => enrichTow(row, stands))
}

export type OccupancyBoardRow = {
  stand: EntryRow
  currentFlight: string
  occupied: boolean
  /** 占用来源只用来做核对展示：占用本身仍然只来自台账，绝不拿任务凑数。 */
  sourceTask: string
}

/** 机位落位视图：一块台账机位一行，已完成的牵引任务不会再制造第二条占用。 */
export function occupancyBoard(): OccupancyBoardRow[] {
  const stands = listRows(STAND_KEY)
  const tows = listRows(TOW_KEY)
  return stands.map((stand) => {
    const code = text(stand, STAND_CODE)
    const flight = text(stand, STAND_FLIGHT)
    const occupied = standOccupied(stand)
    const matched = occupied
      ? tows.find(
          (task) =>
            String(task.status) === TOW_DONE &&
            text(task, FIELD_TO) === code &&
            text(task, FIELD_FLIGHT) === flight,
        )
      : undefined
    return {
      stand,
      currentFlight: occupied ? flight : '',
      occupied,
      sourceTask: matched ? text(matched, FIELD_NO) : occupied ? '台账直接占用' : '',
    }
  })
}

// ---------------------------------------------------------------------------
// 写侧：状态机 + 落位事务
// ---------------------------------------------------------------------------

export function runTowAction(id: number, action: string): ActionResult {
  const tows = listRows(TOW_KEY)
  const index = tows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的牵引任务` }
  }
  const row = tows[index]
  const current = String(row.status)
  const step = NEXT_ACTION[current]

  // 已完成封板：不允许回到待确认；重复点「确认完成」走幂等分支，不再落一次位。
  if (current === TOW_DONE) {
    if (action !== '确认完成') {
      return { ok: false, message: `任务已完成，不能回到「${action}」对应的状态` }
    }
    return repeatComplete(row)
  }

  // 跳步挡回：只接受当前状态的唯一下一步（待牵引直接确认完成、牵引中直接确认等都在这里拦）。
  if (!step || step.action !== action) {
    const expect = step ? `请先执行「${step.action}」` : '当前状态没有可执行动作'
    return {
      ok: false,
      message: `牵引任务需按 待牵引 → 牵引中 → 待确认 → 已完成 顺序流转，当前「${current}」不能「${action}」，${expect}`,
    }
  }

  if (action !== '确认完成') {
    const updated: EntryRow = {
      ...row,
      status: step.status,
      pending: true,
      [FIELD_TASK_STATUS]: step.status,
      ...(action === '开始牵引' && !text(row, FIELD_START) ? { [FIELD_START]: nowText() } : {}),
    }
    const nextTows = [...tows]
    nextTows[index] = updated
    commitAll({ [TOW_KEY]: nextTows })
    return { ok: true, message: `牵引任务已${action}，当前状态「${step.status}」` }
  }

  return completePark(index, tows)
}

/** 重复确认完成：只读台账给结论，绝不写第二遍、绝不覆盖台账上的新占用。 */
function repeatComplete(row: EntryRow): ActionResult {
  const stands = listRows(STAND_KEY)
  const targetCode = text(row, FIELD_TO)
  const flight = text(row, FIELD_FLIGHT)
  const target = standMap(stands).get(targetCode)

  if (standOccupied(target) && text(target!, STAND_FLIGHT) !== flight) {
    return {
      ok: false,
      message: `落位只执行过一次，不允许重复落位：${targetCode} 现已被新航班 ${text(target!, STAND_FLIGHT)} 占用（台账优先，不覆盖新的占用）`,
    }
  }
  if (standOccupied(target)) {
    return { ok: true, message: `落位已完成（${targetCode} 当前为 ${flight}），重复确认不再重复落位` }
  }
  return { ok: true, message: `落位已执行过（落位时间 ${text(row, FIELD_PARKED_TIME) || '—'}），重复确认不再重复落位` }
}

/** 确认完成 = 落位：任务状态、落位登记、目标/起始机位台账在同一笔 commitAll 里落库。 */
function completePark(index: number, tows: EntryRow[]): ActionResult {
  const row = tows[index]
  const flight = text(row, FIELD_FLIGHT)
  const fromCode = text(row, FIELD_FROM)
  const toCode = text(row, FIELD_TO)

  const stands = listRows(STAND_KEY)
  const standsByCode = standMap(stands)
  const target = standsByCode.get(toCode)
  const guard = checkParkable(target, flight, toCode)
  if (!guard.ok) {
    // 挡回：任务留在「待确认」，台账一笔不动。
    return { ok: false, message: guard.reason! }
  }

  const parkedAt = nowText()
  const nextStands = stands.map((stand) => {
    const code = text(stand, STAND_CODE)
    if (code === toCode) {
      return {
        ...stand,
        status: STAND_BUSY,
        pending: true,
        [STAND_FLIGHT]: flight,
        [STAND_SLOT]: `${text(row, FIELD_START) || parkedAt} 起`,
        [STAND_STATE_FIELD]: STAND_BUSY,
      }
    }
    // 起始机位只有仍挂着本航班才释放；若已被新航班占用（台账优先），绝不能顺手清掉。
    if (code === fromCode && standOccupied(stand) && text(stand, STAND_FLIGHT) === flight) {
      return {
        ...stand,
        status: STAND_FREE,
        pending: false,
        [STAND_FLIGHT]: '',
        [STAND_SLOT]: '',
        [STAND_STATE_FIELD]: STAND_FREE,
      }
    }
    return stand
  })

  // 牵引车号、驾驶员、护送人员看到的是同一条任务记录上的同一份落位登记，不存在两份结果。
  const parked: EntryRow = {
    ...row,
    status: TOW_DONE,
    pending: false,
    [FIELD_TASK_STATUS]: TOW_DONE,
    [FIELD_PARKED_AT]: toCode,
    [FIELD_PARKED_TIME]: parkedAt,
  }
  const nextTows = [...tows]
  nextTows[index] = parked
  commitAll({ [TOW_KEY]: nextTows, [STAND_KEY]: nextStands })

  const source = standsByCode.get(fromCode)
  const released = source && standOccupied(source) && text(source, STAND_FLIGHT) === flight
  return {
    ok: true,
    message: `已落位：${flight} 落 ${toCode}${released ? `，起始机位 ${fromCode} 已同步释放` : ''}；任务与机位占用台账同一笔更新`,
  }
}

// ---------------------------------------------------------------------------
// 存量修复：已完成却没落位的老任务，按开始时间回放同一条落位规则
// ---------------------------------------------------------------------------

let backfillDone = false

// 清单重置（resetModule）后老种子数据会回来，守卫要重新跑一遍。
export function resetBackfillGuard(): void {
  backfillDone = false
}

export function ensureLegacyBackfill(): void {
  if (backfillDone) {
    return
  }
  backfillDone = true

  const tows = listRows(TOW_KEY)
  const pendingLegacy = tows.filter(
    (row) =>
      String(row.status) === TOW_DONE &&
      !text(row, FIELD_PARKED_AT) &&
      !row[FIELD_BACKFILL_CONFLICT],
  )
  if (pendingLegacy.length === 0) {
    return
  }

  // 早开始的先落位，尽量还原当时现场；同开始时间按任务编号稳定排序。
  const ordered = [...pendingLegacy].sort((a, b) => {
    const sa = text(a, FIELD_START)
    const sb = text(b, FIELD_START)
    if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
    return text(a, FIELD_NO) < text(b, FIELD_NO) ? -1 : 1
  })

  // 在副本上逐条回放，整批改动最后只提交一笔。
  const towById = new Map(listRows(TOW_KEY).map((item) => [Number(item.id), { ...item }]))
  let stands = listRows(STAND_KEY).map((item) => ({ ...item }))
  let changed = false

  for (const legacy of ordered) {
    const task = towById.get(Number(legacy.id))!
    const flight = text(task, FIELD_FLIGHT)
    const fromCode = text(task, FIELD_FROM)
    const toCode = text(task, FIELD_TO)
    const byCode = standMap(stands)
    const target = byCode.get(toCode)
    const parkedAt = text(task, FIELD_START) || '历史时间'

    if (!checkParkable(target, flight, toCode).ok) {
      // 台账已被（更新的）占用占据：台账优先，老任务不许覆盖，标记冲突交人工核对。
      task[FIELD_BACKFILL_CONFLICT] = true
      changed = true
      continue
    }

    stands = stands.map((stand) => {
      const code = text(stand, STAND_CODE)
      if (code === toCode) {
        return {
          ...stand,
          status: STAND_BUSY,
          pending: true,
          [STAND_FLIGHT]: flight,
          [STAND_SLOT]: `${parkedAt} 起（存量回填）`,
          [STAND_STATE_FIELD]: STAND_BUSY,
        }
      }
      if (code === fromCode && standOccupied(stand) && text(stand, STAND_FLIGHT) === flight) {
        return {
          ...stand,
          status: STAND_FREE,
          pending: false,
          [STAND_FLIGHT]: '',
          [STAND_SLOT]: '',
          [STAND_STATE_FIELD]: STAND_FREE,
        }
      }
      return stand
    })
    task[FIELD_PARKED_AT] = toCode
    task[FIELD_PARKED_TIME] = parkedAt
    changed = true
  }

  if (changed) {
    commitAll({
      [TOW_KEY]: listRows(TOW_KEY).map((item) => towById.get(Number(item.id)) ?? item),
      [STAND_KEY]: stands,
    })
  }
}

export function towStats(): { label: string; value: number }[] {
  const tows = listRows(TOW_KEY)
  const today = nowText().slice(0, 10)
  return [
    { label: '今日牵引任务', value: tows.filter((row) => text(row, FIELD_START).startsWith(today)).length },
    { label: '牵引中任务', value: tows.filter((row) => String(row.status) === '牵引中').length },
    { label: '待确认任务', value: tows.filter((row) => String(row.status) === '待确认').length },
  ]
}

// 仅供读侧快速取一份自洽快照（清单与详情同源）。
export function towSnapshot(): { tows: ReturnType<typeof enrichTows>; board: ReturnType<typeof occupancyBoard> } {
  ensureLegacyBackfill()
  return { tows: enrichTows(allRows()[TOW_KEY] ?? []), board: occupancyBoard() }
}
