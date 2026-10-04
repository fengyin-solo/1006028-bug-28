<template>
  <section class="page" data-module="tow">
    <header class="page-head">
      <div>
        <h2>航空器牵引管理</h2>
        <p class="page-desc">
          牵引任务围绕任务编号、航班号、牵引车号、起始机位做登记与流转；落位结果统一以停机位占用台账为权威数据，
          清单与落位详情同源展示。
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

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 机位占用台账：落位视图的权威面板，只列台账当前值，不按任务状态推算占用 -->
    <section class="ledger-panel">
      <h3 class="ledger-title">停机位占用台账（权威数据）</h3>
      <p class="ledger-hint">当前占用只取自机位台账；已完成的牵引任务不会被重复算作占用，同一机位不会出现两趟航班。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>机位编号</th>
            <th>当前航班</th>
            <th>机位状态</th>
            <th>占用时段</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="stand in occupancy" :key="stand.机位编号">
            <td>{{ stand.机位编号 || '—' }}</td>
            <td>{{ stand.当前航班 || '—' }}</td>
            <td>{{ stand.机位状态 }}</td>
            <td>{{ stand.占用时段 || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '任务编号'" class="link" type="button" @click="openDetail(Number(row.id))">
              {{ row[column] ?? '—' }}
            </button>
            <template v-else>
              <span v-if="column === '权威机位' && row.占用冲突" class="conflict-text">
                {{ row[column] || '—' }}（冲突）
              </span>
              <span v-else>{{ row[column] || '—' }}</span>
            </template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(Number(row.id))">落位详情</button>
            <button
              v-for="action in nextActions(String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无航空器牵引数据，可先登记牵引任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航空器牵引记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 落位详情弹窗：牵引车、起始机位、护送人员三处登记看到的落位结果是同一份台账数据 -->
    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="牵引落位详情">
        <header class="modal-head">
          <h3>牵引落位详情 · {{ detail.任务编号 }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <div class="modal-body">
          <section class="detail-section">
            <h4>任务登记</h4>
            <dl class="detail-grid">
              <div v-for="item in taskFields" :key="item.label" class="detail-item">
                <dt>{{ item.label }}</dt>
                <dd>{{ detail[item.key] || '—' }}</dd>
              </div>
              <div class="detail-item">
                <dt>任务状态</dt>
                <dd>{{ detail.status }}</dd>
              </div>
            </dl>
          </section>

          <section class="detail-section">
            <h4>台账权威落位结果（三处登记同源）</h4>
            <p class="ledger-hint">
              牵引车登记、起始机位登记、护送人员登记三处的落位结果统一读机位占用台账，不允许各取一份。
            </p>
            <div class="register-row">
              <article class="register-card">
                <h5>牵引车登记（{{ detail.牵引车号 }}）</h5>
                <p>落位机位：<strong>{{ detail.权威机位 || '—' }}</strong></p>
                <p>当前占用航班：{{ detail.当前占用航班 || '—' }}</p>
              </article>
              <article class="register-card">
                <h5>起始机位登记（{{ detail.起始机位 }}）</h5>
                <p>落位机位：<strong>{{ detail.权威机位 || '—' }}</strong></p>
                <p>当前占用航班：{{ detail.当前占用航班 || '—' }}</p>
              </article>
              <article class="register-card">
                <h5>护送人员登记（{{ detail.护送人员 }}）</h5>
                <p>落位机位：<strong>{{ detail.权威机位 || '—' }}</strong></p>
                <p>当前占用航班：{{ detail.当前占用航班 || '—' }}</p>
              </article>
            </div>
            <p :class="detail.占用冲突 ? 'conflict-text' : 'ok-text'">{{ detail.落位说明 }}</p>
          </section>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getTowEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listStandOccupancy, type StandOccupancy, type TowViewRow } from '@/data/tow-positioning'

const meta = moduleMeta('tow')
// 落位列读台账反查值，原始的目标机位/落位时间保留对照，列表与详情共用同一份 hydrate 结果。
const columns = [
  '任务编号',
  '航班号',
  '牵引车号',
  '起始机位',
  '目标机位',
  '护送人员',
  '开始时间',
  '落位时间',
  '权威机位',
]
const forwardActions: Record<string, string[]> = {
  待牵引: ['开始牵引'],
  牵引中: ['提交确认'],
  待确认: ['确认完成'],
  已完成: [],
}
const statuses = ['待牵引', '牵引中', '待确认', '已完成']

const rows = ref<TowViewRow[]>([])
const occupancy = ref<StandOccupancy[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['任务编号', '航班号', '牵引车号']
const detail = ref<TowViewRow | null>(null)

const taskFields = [
  { label: '任务编号', key: '任务编号' },
  { label: '航班号', key: '航班号' },
  { label: '牵引车号', key: '牵引车号' },
  { label: '起始机位', key: '起始机位' },
  { label: '目标机位', key: '目标机位' },
  { label: '驾驶员', key: '驾驶员' },
  { label: '护送人员', key: '护送人员' },
  { label: '开始时间', key: '开始时间' },
  { label: '落位时间', key: '落位时间' },
] as const

const stats = computed(() => [
  { label: '今日牵引任务', value: rows.value.length },
  { label: '牵引中任务', value: rows.value.filter((row) => row.status === '牵引中').length },
  { label: '待确认任务', value: rows.value.filter((row) => row.status === '待确认').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function nextActions(status: string): string[] {
  return forwardActions[status] ?? []
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

function openDetail(id: number) {
  const entry = getTowEntry(id)
  detail.value = entry ? (entry as TowViewRow) : null
}

function closeDetail() {
  detail.value = null
}

function runAction(action: string, row: TowViewRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
  // 详情弹窗开着时同步刷新，保证弹窗与台账是同一笔数据
  if (detail.value && Number(detail.value.id) === Number(row.id)) {
    openDetail(Number(row.id))
  }
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items as TowViewRow[]
    total.value = payload.total
    occupancy.value = listStandOccupancy()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航空器牵引列表读取失败'
  }
}

onMounted(reload)
</script>
