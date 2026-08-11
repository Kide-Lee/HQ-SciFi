import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/index.css'

// 不使用 <React.StrictMode>：Vditor 为异步初始化（构造器内 addScript(...).then(init)，
// 返回时 this.vditor 尚未就绪），StrictMode 开发期双挂载会在同步阶段调用 destroy()
// 触发 TypeError 且两个实例并发渲染同一容器导致编辑器卡死（见 VditorEditor 注释）
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
