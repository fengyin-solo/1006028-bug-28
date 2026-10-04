import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { ensureTowPositioningMigration } from './data/tow-positioning'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)

// 存量老记录（已完成却没落位的牵引任务）在启动时按开始时间回填，入口侧读到的数据即权威数据。
ensureTowPositioningMigration()

app.mount('#app')
