#!/usr/bin/env node
/**
 * code-to-diagram Skill 渲染脚本
 *
 * 将 Mermaid 图表源码渲染为 PNG 图片，并生成包含 Mermaid 源码的 Markdown 文档。
 * 设计为由 Claude 在完成代码分析、生成 Mermaid 源码后调用。
 *
 * 子命令
 * ------
 *   render   渲染 Mermaid 源码为 PNG，并生成 .md 文档
 *   help     显示帮助信息
 *
 * 用法示例
 * --------
 *   node code_to_diagram.js render \
 *     --file     <已有 .mmd 文件路径>        （推荐方式）
 *     --name     <输出文件基础名>              （默认：diagram）
 *     --output-dir <保存目录>                 （默认：当前工作目录）
 *     --theme    default|forest|dark|neutral  （默认：dark）
 *     --width    <像素>                       （默认：2400）
 *     --height   <像素>                       （默认：4000）
 *     --scale    <倍数>                       （默认：3）
 *     --bg       <背景色>                     （默认：#0d1117）
 *
 * 输出文件
 * --------
 *   <name>.md   —— 包含 Mermaid 源码的 Markdown 文档
 *   <name>.png  —— 高清渲染图片
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync, spawnSync } = require('child_process')

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 在系统中查找 mmdc 可执行文件路径。
 * 查找顺序：PATH → 本地 node_modules/.bin → npm 全局 bin
 * @returns {string|null} mmdc 路径，未找到返回 null
 */
function resolveMmdc() {
  // 1. 优先从 PATH 中查找
  try {
    const p = execSync('which mmdc', { encoding: 'utf8' }).trim()
    if (p) return p
  } catch (_) { /* 未找到，继续下一步 */ }

  // 2. 查找本地 node_modules
  const local = path.resolve(__dirname, 'node_modules', '.bin', 'mmdc')
  if (fs.existsSync(local)) return local

  // 3. 查找 npm 全局安装目录
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim()
    const p = path.join(prefix, 'bin', 'mmdc')
    if (fs.existsSync(p)) return p
  } catch (_) { /* 忽略 */ }

  return null
}

/**
 * 生成临时 Puppeteer 配置文件。
 * 禁用沙箱，确保在 Docker / 无根容器中正常运行。
 * @returns {string} 配置文件的临时路径
 */
function writePuppeteerConfig() {
  const cfg = { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  const file = path.join(os.tmpdir(), 'code_to_diagram_puppeteer.json')
  fs.writeFileSync(file, JSON.stringify(cfg))
  return file
}

// ─── 参数解析 ─────────────────────────────────────────────────────────────────

/**
 * 解析命令行参数。
 * @param {string[]} argv - process.argv
 * @returns {object} 解析后的参数对象
 */
function parseArgs(argv) {
  const args = {
    command:   null,
    content:   null,   // Mermaid 源码字符串
    file:      null,   // 已有的 .mmd 文件路径
    name:      'diagram',
    outputDir: null,
    theme:     'dark',
    width:     2400,
    height:    4000,
    scale:     3,
    bg:        '#0d1117',
  }

  let i = 2 // 跳过 'node' 和脚本名
  if (argv.length > i && !argv[i].startsWith('-')) {
    args.command = argv[i++]
  }

  while (i < argv.length) {
    const flag = argv[i]
    switch (flag) {
      case '--content':    case '-c': args.content   = argv[++i]; break
      case '--file':       case '-f': args.file       = argv[++i]; break
      case '--name':       case '-n': args.name       = argv[++i]; break
      case '--output-dir': case '-o': args.outputDir  = argv[++i]; break
      case '--theme':      case '-t': args.theme      = argv[++i]; break
      case '--width':      case '-W': args.width      = parseInt(argv[++i], 10); break
      case '--height':     case '-H': args.height     = parseInt(argv[++i], 10); break
      case '--scale':      case '-s': args.scale      = parseFloat(argv[++i]);   break
      case '--bg':         case '-b': args.bg         = argv[++i]; break
      case '--help':       case '-h': args.command    = 'help'; break
      default:
        console.error(`未知参数：${flag}`)
        process.exit(1)
    }
    i++
  }
  return args
}

// ─── 子命令实现 ───────────────────────────────────────────────────────────────

/** 打印帮助信息 */
function printHelp() {
  console.log(`
code-to-diagram Skill —— 从代码分析结果生成 Markdown 文档（含 Mermaid 源码）和 PNG 图片

用法：
  node code_to_diagram.js render [选项]

选项：
  --content,    -c  <字符串>   Mermaid 源码（与 --file 二选一）
  --file,       -f  <路径>     已有的 .mmd 文件路径（与 --content 二选一，推荐）
  --name,       -n  <字符串>   输出文件基础名，不含扩展名（默认：diagram）
  --output-dir, -o  <路径>     输出目录（默认：当前工作目录）
  --theme,      -t  <主题>     default | forest | dark | neutral（默认：dark）
  --width,      -W  <像素>     画布宽度（默认：2400）
  --height,     -H  <像素>     画布高度（默认：4000）
  --scale,      -s  <倍数>     Puppeteer 缩放系数（默认：3）
  --bg,         -b  <颜色>     背景颜色（默认：#0d1117）
  --help,       -h             显示本帮助信息

示例：
  # 推荐方式：从已有 .mmd 文件渲染
  node code_to_diagram.js render \\
    --file /workspace/project/diagram.mmd \\
    --output-dir /workspace/project

  # 从内联源码渲染
  node code_to_diagram.js render \\
    --content "flowchart TD\\n  A --> B" \\
    --name task_flow \\
    --output-dir /workspace/project

输出：
  <输出目录>/<名称>.md    —— 包含 Mermaid 源码的 Markdown 文档
  <输出目录>/<名称>.png   —— 渲染后的图片
`)
}

/**
 * 执行 render 子命令：渲染 PNG 并生成包含 Mermaid 源码的 Markdown 文档。
 * @param {object} args - 解析后的参数对象
 * @returns {Promise<number>} 退出码（0 表示成功）
 */
async function cmdRender(args) {
  // ── 1. 确定输出目录 ───────────────────────────────────────────────────────
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : process.cwd()

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
    console.log(`📁  输出目录已创建：${outputDir}`)
  }

  // ── 2. 获取 Mermaid 源码 ──────────────────────────────────────────────────
  let mmdContent
  let inputMmdPath   // mmdc 渲染用的 .mmd 文件路径
  let cleanupMmd = false // 是否需要清理临时 .mmd 文件

  if (args.file) {
    // 从已有文件读取，直接用原文件作为 mmdc 输入
    const src = path.resolve(args.file)
    if (!fs.existsSync(src)) {
      console.error(`❌  文件不存在：${src}`)
      process.exit(1)
    }
    mmdContent = fs.readFileSync(src, 'utf-8')
    inputMmdPath = src
    console.log(`📄  已从文件加载 Mermaid 源码：${src}`)
  } else if (args.content) {
    // 直接使用传入的字符串，将字面 \n 转换为真正的换行符
    mmdContent = args.content.replace(/\\n/g, '\n')
    // 写入临时 .mmd 文件供 mmdc 使用
    inputMmdPath = path.join(os.tmpdir(), `code_to_diagram_${Date.now()}.mmd`)
    fs.writeFileSync(inputMmdPath, mmdContent, 'utf-8')
    cleanupMmd = true
  } else {
    console.error('❌  --content 或 --file 必须提供其中一个。')
    process.exit(1)
  }

  // ── 3. 定位 mmdc（优先直接路径，找不到则回退到 npx）─────────────────────
  let mmdc = resolveMmdc()
  let useNpx = false
  if (!mmdc) {
    console.log('⚙️  未直接找到 mmdc，将通过 npx 调用 @mermaid-js/mermaid-cli …')
    useNpx = true
  } else {
    console.log(`🔧  使用 mmdc：${mmdc}`)
  }

  // ── 4. 生成 Puppeteer 配置（禁用沙箱，兼容容器环境）─────────────────────
  const puppeteerCfg = writePuppeteerConfig()

  // ── 5. 调用 mmdc 渲染 PNG ─────────────────────────────────────────────────
  const pngPath = path.join(outputDir, `${args.name}.png`)

  const mmdcArgs = [
    ...(useNpx ? ['mmdc'] : []),
    '-i', inputMmdPath,
    '-o', pngPath,
    '-t', args.theme,
    '-b', args.bg,
    '-w', String(args.width),
    '-H', String(args.height),
    '-s', String(args.scale),
    '-p', puppeteerCfg,
  ]

  const cmd = useNpx ? 'npx' : mmdc
  console.log(`🎨  正在渲染 PNG …`)
  console.log(`    ${cmd} ${mmdcArgs.join(' ')}`)

  const result = spawnSync(cmd, mmdcArgs, { stdio: 'inherit', shell: false })

  // 清理临时文件
  try { fs.unlinkSync(puppeteerCfg) } catch (_) { /* 忽略 */ }
  if (cleanupMmd) {
    try { fs.unlinkSync(inputMmdPath) } catch (_) { /* 忽略 */ }
  }

  if (result.status !== 0) {
    console.error(`❌  mmdc 退出码：${result.status}`)
    process.exit(result.status ?? 1)
  }

  if (!fs.existsSync(pngPath)) {
    console.error(`❌  渲染完成但未找到 PNG 文件，请检查上方 mmdc 输出。`)
    process.exit(1)
  }

  const { size } = fs.statSync(pngPath)
  const kb = (size / 1024).toFixed(1)
  console.log(`✅  PNG 渲染完成：${pngPath}（${kb} KB）`)

  // ── 6. 生成包含 Mermaid 源码的 Markdown 文档 ──────────────────────────────
  const mdPath = path.join(outputDir, `${args.name}.md`)
  const mdFileContent = '```mermaid\n' + mmdContent.trim() + '\n```\n'
  fs.writeFileSync(mdPath, mdFileContent, 'utf-8')
  console.log(`✅  Markdown 文档已保存：${mdPath}`)

  console.log('')
  console.log('📦  输出文件：')
  console.log(`    .md   →  ${mdPath}`)
  console.log(`    .png  →  ${pngPath}`)

  // 输出结构化 JSON，供 Claude 解析两个文件路径
  console.log(JSON.stringify({ md: mdPath, png: pngPath }))

  return 0
}

// ─── 程序入口 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)

  // 未指定子命令或显式请求帮助时，打印帮助信息
  if (!args.command || args.command === 'help') {
    printHelp()
    process.exit(args.command === 'help' ? 0 : 1)
  }

  let exitCode = 1
  switch (args.command) {
    case 'render':
      exitCode = await cmdRender(args)
      break
    default:
      console.error(`未知子命令：${args.command}`)
      printHelp()
      exitCode = 1
  }

  process.exit(exitCode)
}

main()
