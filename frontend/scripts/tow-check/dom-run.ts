import { listRows, allRows, resetRows } from '@/data/local-store'
import {
  ensureLegacyBackfill,
  runTowAction,
  enrichTows,
  occupancyBoard,
} from '@/data/tow-domain'

let failures = 0
function assert(name, cond, extra = '') {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures++
    console.error(`FAIL  ${name} ${extra}`)
  }
}
function byNo(no) {
  return listRows('tow').find((r) => r['任务编号'] === no)
}
function stand(code) {
  return listRows('stand').find((r) => r['机位编号'] === code)
}

// 1. 存量回填：三条已完成未落位任务按开始时间回放（05:40、06:00、次日08:10）
ensureLegacyBackfill()
const t7 = byNo('TOW-0007')
const t8 = byNo('TOW-0008')
const t11 = byNo('TOW-0011')
assert('回填1 TOW-0007 落位 201', t7['落位机位'] === '201' && stand('201')['当前航班'] === 'CA1001')
assert('回填2 TOW-0007 起始机位 204 已释放', stand('204').status === '空闲' && stand('204')['当前航班'] === '')
assert('回填3 TOW-0008 落位 202', t8['落位机位'] === '202' && stand('202')['当前航班'] === 'CA1002')
assert('回填4 207 被更新航班 CA1888 占用，老任务不覆盖', stand('207')['当前航班'] === 'CA1888' && t11['回填冲突'] === true && !t11['落位机位'])
assert('回填5 落位时间取任务开始时间', t7['落位时间'] === '2026-09-01 05:40')
assert('回填6 幂等：再跑一次不产生变化', (() => {
  const before = JSON.stringify(allRows())
  ensureLegacyBackfill()
  return JSON.stringify(allRows()) === before
})())

// 2. 落位视图只认台账：7 块机位一行一个，占用来源能对到已完成任务；任务状态不凑数
const board = occupancyBoard()
assert('视图1 落位视图行数=台账机位数', board.length === 7)
const occupiedCodes = board.filter((b) => b.occupied).map((b) => b.stand['机位编号']).sort()
assert('视图2 占用机位集合与台账一致', JSON.stringify(occupiedCodes) === JSON.stringify(['201', '202', '203', '207']))
const b201 = board.find((b) => b.stand['机位编号'] === '201')
assert('视图3 占用来源关联到已完成牵引任务', b201.sourceTask === 'TOW-0007')
assert('视图4 空闲机位不挂航班', board.find((b) => b.stand['机位编号'] === '204').currentFlight === '')

// 3. 状态机：待牵引不许直接确认完成（跳步挡回，数据不动）
const t1Id = byNo('TOW-0101').id
const blocked = runTowAction(t1Id, '确认完成')
assert('挡回1 待牵引直接确认完成被拒', blocked.ok === false && byNo('TOW-0101').status === '待牵引')
const skipped = runTowAction(t1Id, '提交确认')
assert('挡回2 待牵引直接提交确认被拒', skipped.ok === false)

// 正常推进 待牵引 -> 牵引中 -> 待确认
assert('推进1 开始牵引', runTowAction(t1Id, '开始牵引').ok && byNo('TOW-0101').status === '牵引中')
assert('推进2 提交确认', runTowAction(t1Id, '提交确认').ok && byNo('TOW-0101').status === '待确认')

// 4. 已完成不能回到待确认（此时还没法演示，先确认 待确认->开始牵引 这类逆向也挡）
const reverse = runTowAction(t1Id, '开始牵引')
assert('挡回3 待确认不能再开始牵引', reverse.ok === false && byNo('TOW-0101').status === '待确认')

// 5. 确认完成落位：目标 204 空闲，落位后同一笔写台账，起始 203 释放
const done = runTowAction(t1Id, '确认完成')
const t1 = byNo('TOW-0101')
assert(
  '落位1 确认完成成功并写回目标机位',
  done.ok && t1.status === '已完成' && t1['落位机位'] === '204' && stand('204')['当前航班'] === 'CA1305' && stand('204').status === '占用中',
  done.message,
)
assert('落位2 起始机位 203 同笔释放', stand('203').status === '空闲' && stand('203')['当前航班'] === '')
assert('落位3 落位时间已登记', !!t1['落位时间'])
assert('落位4 任务状态字段同步', t1['任务状态'] === '已完成')

// 6. 重复确认完成：幂等，不再落位，且台账被新航班占用时绝不覆盖
stand('204') // ensure loaded
// 模拟台账后来被更新航班占据
const s204 = listRows('stand').find((r) => r['机位编号'] === '204')
s204['当前航班'] = 'CA9999'
s204.status = '占用中'
s204['机位状态'] = '占用中'
const { saveRows } = await import('@/data/local-store')
saveRows('stand', listRows('stand'))
const repeat = runTowAction(t1Id, '确认完成')
assert('幂等1 重复确认不覆盖新占用', repeat.ok === false && stand('204')['当前航班'] === 'CA9999' && byNo('TOW-0101')['落位机位'] === '204', repeat.message)
// 已完成点别的动作必须挡回（不能回到待确认）
assert('挡回4 已完成不能再提交确认', runTowAction(t1Id, '提交确认').ok === false)
assert('挡回5 已完成不能再开始牵引', runTowAction(t1Id, '开始牵引').ok === false)

// 7. 台账优先：待确认任务目标机位被别的航班占着，确认完成挡回且两表不动
const t3Id = byNo('TOW-0103').id // 201 -> 205；201 现为 CA1001，205 空闲
assert('冲突前 任务处于待确认', byNo('TOW-0103').status === '待确认')
// 让 205 被别的航班占用
const s205 = listRows('stand').find((r) => r['机位编号'] === '205')
s205['当前航班'] = 'MU0000'
s205.status = '占用中'
s205['机位状态'] = '占用中'
saveRows('stand', listRows('stand'))
const conflict = runTowAction(t3Id, '确认完成')
assert(
  '台账优先1 目标被占则挡回',
  conflict.ok === false && conflict.message.includes('MU0000') && byNo('TOW-0103').status === '待确认',
  conflict.message,
)
assert('台账优先2 台账不被动（201/205 不变）', stand('201')['当前航班'] === 'CA1001' && stand('205')['当前航班'] === 'MU0000')

// 释放冲突后可正常落位；起始机位 201 挂的不是自己（CA1001），不得误释放
s205['当前航班'] = ''
s205.status = '空闲'
s205['机位状态'] = '空闲'
saveRows('stand', listRows('stand'))
const done3 = runTowAction(t3Id, '确认完成')
assert('台账优先3 冲突解除后落位成功', done3.ok && stand('205')['当前航班'] === 'CZ3101', done3.message)
assert('台账优先4 起始机位挂着别的航班时不误释放', stand('201')['当前航班'] === 'CA1001' && stand('201').status === '占用中')

// 8. 列表派生与详情同源：enrichTows 是唯一取数口
const rows = enrichTows(listRows('tow'))
const findRow = (no) => rows.find((r) => r['任务编号'] === no)
assert('同源1 已完成且台账一致=已落位', findRow('TOW-0008')['落位结果'].startsWith('已落位'))
assert('同源2 老任务冲突=台账冲突提示', findRow('TOW-0011')['落位结果'].includes('历史未落位'))
assert('同源3 牵引中任务=未落位（任务状态不当占用）', findRow('TOW-0102')['落位结果'].includes('未落位'))
assert('同源4 允许动作只给下一步', JSON.stringify(findRow('TOW-0102')['允许动作']) === JSON.stringify(['提交确认']))
assert('同源5 已完成无后续动作', JSON.stringify(findRow('TOW-0103')['允许动作']) === '[]')
assert('同源6 台账当前航班字段来自台账', findRow('TOW-0008')['台账当前航班'] === 'CA1002')

// 9. 目标机位未登记挡回
const t2 = byNo('TOW-0102')
t2['目标机位'] = '999'
saveRows('tow', listRows('tow'))
runTowAction(t2.id, '提交确认')
const missing = runTowAction(t2.id, '确认完成')
assert('挡回6 目标机位不在台账中挡回', missing.ok === false && byNo('TOW-0102').status === '待确认', missing.message)

if (failures) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
