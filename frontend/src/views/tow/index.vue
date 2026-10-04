<template>
  <section class="page" data-module="tow">
    <header class="page-head">
      <div>
        <h2>航空器牵引管理</h2>
        <p class="page-desc">
          维护牵引任务，围绕任务编号、航班号、牵引车号、起始机位做登记、筛选与状态流转。
          落位结果与机位占用一律以停机位占用台账为唯一权威数据。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记牵引任务</button>
        <button class="btn" type="button" @click="exportRows">导出航空器牵引清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <h3 class="board-head">机位落位视图（数据源：停机位占用台账）</h3>
    <table class="data-table board-table">
      <thead>
        <tr>
          <th>机位编号</th>
          <th>机位状态</th>
          <th>当前航班</th>
          <th>占用时段</th>
          <th>占用来源</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in board" :key="String(item.stand['机位编号'])">
          <td>{{ item.stand['机位编号'] }}</td>
          <td>{{ item.stand.status }}</td>
          <td>{{ item.currentFlight || '—' }}</td>
          <td>{{ item.stand['占用时段'] || '—' }}</td>
          <td>{{ item.sourceTask || '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p class="board-note">
      占用只认台账的「占用中 + 当前航班」；已完成的牵引任务不再重复计入占用，同一机位不会出现两趟航班并挂。
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>落位结果</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td :class="{ 'conflict-cell': isConflictRow(row) }">{{ row['落位结果'] }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in row['允许动作']"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无航空器牵引数据，可先登记牵引任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航空器牵引记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detailRow" class="modal-mask" @click.self="closeDetail">
      <div class="modal-card">
        <header class="modal-head">
          <h3>牵引任务详情 · {{ detailRow['任务编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="column in detailColumns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detailRow.status }}</dd>
          <dt>落位结果</dt>
          <dd :class="{ 'conflict-cell': isConflictRow(detailRow) }">{{ detailRow['落位结果'] }}</dd>
          <dt>目标机位台账状态</dt>
          <dd>{{ detailRow['台账机位状态'] }}</dd>
          <dt>台账当前航班</dt>
          <dd>{{ detailRow['台账当前航班'] }}</dd>
          <dt v-if="detailRow['落位时间']">落位时间</dt>
          <dd v-if="detailRow['落位时间']">{{ detailRow['落位时间'] }}</dd>
        </dl>
        <p v-if="detailRow['回填冲突']" class="error-text conflict-tip">
          存量任务回填时目标机位已被更新航班占用：按「台账优先、不覆盖新占用」规则未自动落位，请人工核实。
        </p>
        <p class="detail-note">
          本弹窗与清单表格读的是同一份台账派发行数据；牵引车号、驾驶员、护送人员登记看到的落位结果一致。
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listTowEntries,
  moduleMeta,
  runAction as applyAction,
  standOccupancyBoard,
  towStatCards,
} from '@/api/local-service'
import type { EnrichedTow, OccupancyBoardRow } from '@/data/tow-domain'

const meta = moduleMeta('tow')
const columns = ["任务编号", "航班号", "牵引车号", "起始机位", "目标机位", "驾驶员", "护送人员", "开始时间", "任务状态"]
const detailColumns = columns
const statuses = ["待牵引", "牵引中", "待确认", "已完成"]

const rows = ref<EnrichedTow[]>([])
const board = ref<OccupancyBoardRow[]>([])
const stats = ref(towStatCards())
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detailRow = ref<EnrichedTow | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isConflictRow(row: EnrichedTow): boolean {
  return String(row['落位结果'] ?? '').includes('冲突') || Boolean(row['回填冲突'])
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '牵引任务登记入口尚未接入审批流'
}

function openDetail(row: EnrichedTow) {
  // 直接引用 rows 里的同一对象：列表行与详情弹窗不可能读到两份不同的值。
  detailRow.value = rows.value.find((item) => Number(item.id) === Number(row.id)) ?? row
}

function closeDetail() {
  detailRow.value = null
}

function runAction(action: string, row: { id: number }) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listTowEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    board.value = standOccupancyBoard()
    stats.value = towStatCards()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航空器牵引列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.board-head {
  margin: 4px 0 8px;
  font-size: 15px;
}
.board-table {
  margin-bottom: 4px;
}
.board-note {
  margin: 6px 0 14px;
  font-size: 12px;
  color: var(--muted);
}
.conflict-cell {
  color: #b42318;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 10px;
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: auto;
  padding: 16px 20px;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.modal-head h3 {
  margin: 0;
  font-size: 16px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 6px 12px;
  margin: 12px 0;
  font-size: 13px;
}
.detail-grid dt {
  color: var(--muted);
}
.detail-grid dd {
  margin: 0;
}
.conflict-tip {
  margin: 8px 0;
  font-size: 12px;
}
.detail-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
</style>
