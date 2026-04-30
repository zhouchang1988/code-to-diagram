#!/usr/bin/env node
/**
 * code-to-diagram Skill 渲染脚本
 *
 * 渲染引擎
 * --------
 *   mermaid  默认使用 beautiful-mermaid → SVG → rsvg-convert → PNG
 *            不支持的图表类型自动回退到 mmdc (Mermaid CLI)
 *   svg      使用 rsvg-convert 渲染 .svg → .png
 *
 * 用法示例
 * --------
 *   node code_to_diagram.js render \
 *     --file <diagram.mmd> \
 *     --theme tokyo-night \
 *     --output-dir <保存目录>
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { renderMermaidSVG, THEMES } from 'beautiful-mermaid'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const BM_SUPPORTED_PREFIXES = [
  'graph', 'flowchart', 'statediagram', 'sequencediagram',
  'classdiagram', 'erdiagram', 'xychart',
]

const AVAILABLE_THEMES = Object.keys(THEMES)

const MMDC_THEME_MAP = {
  'github-dark': 'dark',
  'github-light': 'default',
  'tokyo-night': 'dark',
  'tokyo-night-storm': 'dark',
  'tokyo-night-light': 'default',
  'catppuccin-mocha': 'dark',
  'catppuccin-latte': 'default',
  'nord': 'dark',
  'nord-light': 'default',
  'dracula': 'dark',
  'one-dark': 'dark',
  'solarized-dark': 'dark',
  'solarized-light': 'default',
  'zinc-dark': 'dark',
  'zinc-light': 'default',
}

// ─── CSS 变量解析（rsvg-convert 不支持 var() 和 color-mix()）──────────────────

function hexToRgb(hex) {
  hex = hex.replace('#', '')
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2]
  return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)]
}

function rgbToHex(r, g, b) {
  return '#' + [r,g,b].map(v => Math.round(v).toString(16).padStart(2,'0')).join('')
}

function mixColors(color1, pct1, color2) {
  const [r1,g1,b1] = hexToRgb(color1)
  const [r2,g2,b2] = hexToRgb(color2)
  const p = pct1 / 100
  return rgbToHex(r1*p+r2*(1-p), g1*p+g2*(1-p), b1*p+b2*(1-p))
}

function resolveSvgCssVars(svgString, themeColors) {
  const vars = {
    '--bg': themeColors.bg,
    '--fg': themeColors.fg,
    '--line': themeColors.line,
    '--accent': themeColors.accent,
    '--muted': themeColors.muted,
    '--surface': themeColors.surface,
    '--border': themeColors.border,
  }

  const bg = themeColors.bg
  const fg = themeColors.fg

  const derived = {
    '--_text':         vars['--fg'],
    '--_text-sec':     vars['--muted'] || mixColors(fg, 60, bg),
    '--_text-muted':   vars['--muted'] || mixColors(fg, 40, bg),
    '--_text-faint':   mixColors(fg, 25, bg),
    '--_line':         vars['--line'] || mixColors(fg, 50, bg),
    '--_arrow':        vars['--accent'] || mixColors(fg, 85, bg),
    '--_node-fill':    vars['--surface'] || mixColors(fg, 3, bg),
    '--_node-stroke':  vars['--border'] || mixColors(fg, 20, bg),
    '--_group-fill':   bg,
    '--_group-hdr':    mixColors(fg, 5, bg),
    '--_inner-stroke': mixColors(fg, 12, bg),
    '--_key-badge':    mixColors(fg, 10, bg),
  }

  const allVars = { ...vars, ...derived }

  // Remove <style> block and @import (rsvg-convert can't use them)
  let result = svgString.replace(/<style>[\s\S]*?<\/style>/, '')

  // Replace inline style var() on <svg> tag with resolved background
  result = result.replace(/style="[^"]*"/, `style="background:${bg}"`)

  // Replace all var(--xxx) and var(--xxx, fallback) in attributes
  result = result.replace(/var\(([^)]+)\)/g, (match, inner) => {
    const parts = inner.split(',').map(s => s.trim())
    const varName = parts[0]
    if (allVars[varName]) return allVars[varName]
    // Handle fallback: var(--name, color-mix(...)) — use the derived value
    if (parts.length > 1) {
      const fallback = parts.slice(1).join(',').trim()
      if (fallback.startsWith('color-mix')) {
        // Parse: color-mix(in srgb, var(--fg) XX%, var(--bg))
        const mixMatch = fallback.match(/color-mix\(in srgb,\s*var\(([^)]+)\)\s+(\d+)%,\s*var\(([^)]+)\)\)/)
        if (mixMatch) {
          const c1 = allVars[mixMatch[1]] || fg
          const pct = parseInt(mixMatch[2])
          const c2 = allVars[mixMatch[3]] || bg
          return mixColors(c1, pct, c2)
        }
      }
      return fallback
    }
    return match
  })

  // Resolve any remaining color-mix() that weren't inside var()
  result = result.replace(/color-mix\(in srgb,\s*([^,]+?)\s+(\d+)%,\s*([^)]+)\)/g, (match, c1str, pct, c2str) => {
    let c1 = c1str.trim()
    let c2 = c2str.trim()
    if (c1.startsWith('var(')) c1 = allVars[c1.slice(4,-1)] || fg
    if (c2.startsWith('var(')) c2 = allVars[c2.slice(4,-1)] || bg
    if (c1.startsWith('#') && c2.startsWith('#')) {
      return mixColors(c1, parseInt(pct), c2)
    }
    return match
  })

  // Add font style inline (since @import was removed)
  const fontStyle = `<style>text { font-family: 'Inter', -apple-system, system-ui, sans-serif; }</style>`
  result = result.replace('</defs>', `</defs>${fontStyle}`)

  // Add background rect (rsvg-convert ignores CSS background property)
  if (!themeColors.transparent) {
    const vbMatch = result.match(/viewBox="([^"]+)"/)
    if (vbMatch) {
      const [x, y, w, h] = vbMatch[1].split(/\s+/).map(Number)
      const bgRect = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}"/>`
      // Insert right after <defs>...</defs><style>...</style>
      result = result.replace(/<\/style>/, `</style>${bgRect}`)
    }
  }

  return result
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function detectDiagramType(mmdContent) {
  const firstLine = mmdContent.trim().split('\n')[0].replace(/\s.*/, '').toLowerCase()
  // Handle stateDiagram-v2 → statediagram
  const normalized = firstLine.replace(/-v\d+$/, '')
  return BM_SUPPORTED_PREFIXES.includes(normalized) ? normalized : null
}

function resolveMmdc() {
  try {
    const p = execSync('which mmdc', { encoding: 'utf8' }).trim()
    if (p) return p
  } catch (_) {}

  const local = path.resolve(__dirname, 'node_modules', '.bin', 'mmdc')
  if (fs.existsSync(local)) return local

  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8' }).trim()
    const p = path.join(prefix, 'bin', 'mmdc')
    if (fs.existsSync(p)) return p
  } catch (_) {}

  return null
}

function writePuppeteerConfig() {
  const cfg = { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  const file = path.join(os.tmpdir(), 'code_to_diagram_puppeteer.json')
  fs.writeFileSync(file, JSON.stringify(cfg))
  return file
}

function resolveRsvgConvert() {
  try {
    const p = execSync('which rsvg-convert', { encoding: 'utf8' }).trim()
    if (p) return p
  } catch (_) {}

  const candidates = [
    '/opt/homebrew/bin/rsvg-convert',
    '/usr/local/bin/rsvg-convert',
    '/usr/bin/rsvg-convert',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

function validateSvg(svgPath) {
  const scriptPath = path.join(__dirname, 'validate_svg.sh')
  if (!fs.existsSync(scriptPath)) return true
  const result = spawnSync('bash', [scriptPath, svgPath], { stdio: 'inherit' })
  return result.status === 0
}

// ─── 参数解析 ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    command:     null,
    content:     null,
    file:        null,
    name:        'diagram',
    outputDir:   null,
    theme:       'github-dark',
    renderer:    'auto',     // 'auto' | 'beautiful-mermaid' | 'mmdc'
    padding:     40,
    transparent: false,
    width:       2400,
    height:      4000,
    scale:       3,
    bg:          null,
    engine:      'mermaid',
    style:       'flat-icon',
    svgWidth:    1920,
  }

  let i = 2
  if (argv.length > i && !argv[i].startsWith('-')) {
    args.command = argv[i++]
  }

  while (i < argv.length) {
    const flag = argv[i]
    switch (flag) {
      case '--content':    case '-c': args.content     = argv[++i]; break
      case '--file':       case '-f': args.file         = argv[++i]; break
      case '--name':       case '-n': args.name         = argv[++i]; break
      case '--output-dir': case '-o': args.outputDir    = argv[++i]; break
      case '--theme':      case '-t': args.theme        = argv[++i]; break
      case '--renderer':              args.renderer     = argv[++i]; break
      case '--padding':               args.padding      = parseInt(argv[++i], 10); break
      case '--transparent':           args.transparent  = true; break
      case '--width':      case '-W': args.width        = parseInt(argv[++i], 10); break
      case '--height':     case '-H': args.height       = parseInt(argv[++i], 10); break
      case '--scale':      case '-s': args.scale        = parseFloat(argv[++i]);   break
      case '--bg':         case '-b': args.bg           = argv[++i]; break
      case '--engine':     case '-e': args.engine       = argv[++i]; break
      case '--style':                 args.style        = argv[++i]; break
      case '--svg-width':             args.svgWidth     = parseInt(argv[++i], 10); break
      case '--help':       case '-h': args.command      = 'help'; break
      default:
        console.error(`未知参数：${flag}`)
        process.exit(1)
    }
    i++
  }
  return args
}

// ─── beautiful-mermaid 渲染 ─────────────────────────────────────────────────

function renderWithBeautifulMermaid(mmdContent, args) {
  const themeColors = THEMES[args.theme]
  if (!themeColors) {
    console.error(`❌  未知主题：${args.theme}`)
    console.error(`    可用主题：${AVAILABLE_THEMES.join(', ')}`)
    process.exit(1)
  }

  const options = {
    ...themeColors,
    padding: args.padding,
    transparent: args.transparent,
  }

  if (args.bg) {
    options.bg = args.bg
  }

  console.log(`🎨  使用 beautiful-mermaid 渲染，主题：${args.theme}`)
  const svgString = renderMermaidSVG(mmdContent, options)

  // 解析 CSS 变量为实际颜色值（rsvg-convert 不支持 var()）
  const resolvedSvg = resolveSvgCssVars(svgString, { ...themeColors, ...(args.bg ? { bg: args.bg } : {}) })
  return resolvedSvg
}

function svgToPng(svgString, pngPath, width) {
  const rsvg = resolveRsvgConvert()
  if (!rsvg) {
    console.error('❌  未找到 rsvg-convert。请安装 librsvg：')
    console.error('    macOS:         brew install librsvg')
    console.error('    Debian/Ubuntu: apt-get install librsvg2-bin')
    process.exit(1)
  }

  const tmpSvg = path.join(os.tmpdir(), `bm_${Date.now()}.svg`)
  fs.writeFileSync(tmpSvg, svgString, 'utf-8')

  const rsvgArgs = ['-w', String(width), tmpSvg, '-o', pngPath]
  console.log(`    rsvg-convert -w ${width} → ${pngPath}`)

  const result = spawnSync(rsvg, rsvgArgs, { stdio: 'inherit' })

  try { fs.unlinkSync(tmpSvg) } catch (_) {}

  if (result.status !== 0) {
    console.error(`❌  rsvg-convert 退出码：${result.status}`)
    process.exit(result.status ?? 1)
  }
}

// ─── mmdc 回退渲染 ──────────────────────────────────────────────────────────

function renderWithMmdc(inputMmdPath, pngPath, args) {
  let mmdc = resolveMmdc()
  let useNpx = false
  if (!mmdc) {
    console.log('⚙️  未直接找到 mmdc，将通过 npx 调用 @mermaid-js/mermaid-cli …')
    useNpx = true
  } else {
    console.log(`🔧  回退使用 mmdc：${mmdc}`)
  }

  const puppeteerCfg = writePuppeteerConfig()
  const mmdcTheme = MMDC_THEME_MAP[args.theme] || 'dark'
  const bgColor = args.bg || (mmdcTheme === 'dark' ? '#0d1117' : '#ffffff')

  const mmdcArgs = [
    ...(useNpx ? ['mmdc'] : []),
    '-i', inputMmdPath,
    '-o', pngPath,
    '-t', mmdcTheme,
    '-b', bgColor,
    '-w', String(args.width),
    '-H', String(args.height),
    '-s', String(args.scale),
    '-p', puppeteerCfg,
  ]

  const cmd = useNpx ? 'npx' : mmdc
  console.log(`🎨  正在使用 mmdc 渲染 PNG …`)

  const result = spawnSync(cmd, mmdcArgs, { stdio: 'inherit', shell: false })

  try { fs.unlinkSync(puppeteerCfg) } catch (_) {}

  if (result.status !== 0) {
    console.error(`❌  mmdc 退出码：${result.status}`)
    process.exit(result.status ?? 1)
  }
}

// ─── 子命令实现 ───────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
code-to-diagram Skill —— 从代码分析结果生成 Markdown 文档和 PNG 图片

渲染引擎：
  mermaid  使用 beautiful-mermaid 渲染 .mmd → SVG → PNG（默认）
           不支持的图表类型自动回退到 mmdc
  svg      使用 rsvg-convert 渲染 .svg → .png

用法：
  node code_to_diagram.js render [选项]

通用选项：
  --file,       -f  <路径>      输入文件路径（.mmd 或 .svg）
  --content,    -c  <字符串>    Mermaid 源码（仅 mermaid 引擎，与 --file 二选一）
  --name,       -n  <字符串>    输出文件基础名（默认：diagram）
  --output-dir, -o  <路径>      输出目录（默认：当前工作目录）
  --engine,     -e  <引擎>      mermaid | svg（默认：mermaid）
  --help,       -h              显示帮助信息

Mermaid 引擎选项（beautiful-mermaid）：
  --theme,      -t  <主题>      ${AVAILABLE_THEMES.join(' | ')}
                                （默认：github-dark）
  --renderer        <渲染器>    auto | beautiful-mermaid | mmdc（默认：auto）
  --padding         <像素>      画布内边距（默认：40）
  --transparent                 透明背景
  --bg,         -b  <颜色>      自定义背景色（覆盖主题）

mmdc 回退选项（仅当 renderer=mmdc 或自动回退时）：
  --width,      -W  <像素>      画布宽度（默认：2400）
  --height,     -H  <像素>      画布高度（默认：4000）
  --scale,      -s  <倍数>      缩放系数（默认：3）

SVG 引擎选项：
  --style       <风格>          flat-icon | dark-terminal | blueprint | notion-clean | glassmorphism
  --svg-width   <像素>          输出宽度（默认：1920）

可用主题（15 个）：
  暗色：github-dark, tokyo-night, tokyo-night-storm, catppuccin-mocha,
        nord, dracula, one-dark, solarized-dark, zinc-dark
  亮色：github-light, tokyo-night-light, catppuccin-latte,
        nord-light, solarized-light, zinc-light

示例：
  # beautiful-mermaid 渲染（默认）
  node code_to_diagram.js render -f diagram.mmd -t tokyo-night -o ./output

  # 强制使用 mmdc
  node code_to_diagram.js render -f diagram.mmd --renderer mmdc -o ./output

  # SVG 引擎
  node code_to_diagram.js render -e svg -f arch.svg --style dark-terminal -o ./output
`)
}

async function cmdRender(args) {
  const outputDir = args.outputDir ? path.resolve(args.outputDir) : process.cwd()
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // 获取 Mermaid 源码
  let mmdContent
  let inputMmdPath
  let cleanupMmd = false

  if (args.file) {
    const src = path.resolve(args.file)
    if (!fs.existsSync(src)) {
      console.error(`❌  文件不存在：${src}`)
      process.exit(1)
    }
    mmdContent = fs.readFileSync(src, 'utf-8')
    inputMmdPath = src
  } else if (args.content) {
    mmdContent = args.content.replace(/\\n/g, '\n')
    inputMmdPath = path.join(os.tmpdir(), `code_to_diagram_${Date.now()}.mmd`)
    fs.writeFileSync(inputMmdPath, mmdContent, 'utf-8')
    cleanupMmd = true
  } else {
    console.error('❌  --content 或 --file 必须提供其中一个。')
    process.exit(1)
  }

  const pngPath = path.join(outputDir, `${args.name}.png`)

  // 选择渲染器
  const diagramType = detectDiagramType(mmdContent)
  let useBM = false

  if (args.renderer === 'mmdc') {
    useBM = false
  } else if (args.renderer === 'beautiful-mermaid') {
    useBM = true
  } else {
    // auto: 根据图表类型决定
    useBM = diagramType !== null
  }

  if (useBM) {
    try {
      const svgString = renderWithBeautifulMermaid(mmdContent, args)
      svgToPng(svgString, pngPath, args.svgWidth || 1920)
    } catch (err) {
      console.log(`⚠️  beautiful-mermaid 渲染失败，回退到 mmdc：${err.message}`)
      useBM = false
    }
  }

  if (!useBM) {
    if (!inputMmdPath) {
      inputMmdPath = path.join(os.tmpdir(), `code_to_diagram_${Date.now()}.mmd`)
      fs.writeFileSync(inputMmdPath, mmdContent, 'utf-8')
      cleanupMmd = true
    }
    renderWithMmdc(inputMmdPath, pngPath, args)
  }

  if (cleanupMmd && inputMmdPath) {
    try { fs.unlinkSync(inputMmdPath) } catch (_) {}
  }

  if (!fs.existsSync(pngPath)) {
    console.error('❌  渲染完成但未找到 PNG 文件。')
    process.exit(1)
  }

  const { size } = fs.statSync(pngPath)
  const kb = (size / 1024).toFixed(1)
  console.log(`✅  PNG 渲染完成：${pngPath}（${kb} KB）`)

  // 生成 Markdown 文档
  const mdPath = path.join(outputDir, `${args.name}.md`)
  const mdFileContent = '```mermaid\n' + mmdContent.trim() + '\n```\n'
  fs.writeFileSync(mdPath, mdFileContent, 'utf-8')
  console.log(`✅  Markdown 文档已保存：${mdPath}`)

  const renderer = useBM ? 'beautiful-mermaid' : 'mmdc'
  console.log(JSON.stringify({ md: mdPath, png: pngPath, engine: 'mermaid', theme: args.theme, renderer }))

  return 0
}

async function cmdRenderSvg(args) {
  const outputDir = args.outputDir ? path.resolve(args.outputDir) : process.cwd()
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  if (!args.file) {
    console.error('❌  SVG 引擎必须使用 --file 指定 .svg 文件路径。')
    process.exit(1)
  }

  const svgPath = path.resolve(args.file)
  if (!fs.existsSync(svgPath)) {
    console.error(`❌  文件不存在：${svgPath}`)
    process.exit(1)
  }

  const svgContent = fs.readFileSync(svgPath, 'utf-8')
  console.log(`📄  已加载 SVG 文件：${svgPath}`)

  console.log('🔍  正在验证 SVG …')
  if (!validateSvg(svgPath)) {
    console.error('❌  SVG 验证失败，请检查上方错误信息。')
    process.exit(1)
  }

  const pngPath = path.join(outputDir, `${args.name}.png`)
  svgToPng(svgContent, pngPath, args.svgWidth)

  if (!fs.existsSync(pngPath)) {
    console.error('❌  渲染完成但未找到 PNG 文件。')
    process.exit(1)
  }

  const { size } = fs.statSync(pngPath)
  const kb = (size / 1024).toFixed(1)
  console.log(`✅  PNG 渲染完成：${pngPath}（${kb} KB）`)

  const mdPath = path.join(outputDir, `${args.name}.md`)
  const mdFileContent = '```svg\n' + svgContent.trim() + '\n```\n'
  fs.writeFileSync(mdPath, mdFileContent, 'utf-8')
  console.log(`✅  Markdown 文档已保存：${mdPath}`)

  console.log(JSON.stringify({ md: mdPath, png: pngPath, engine: 'svg', style: args.style }))

  return 0
}

// ─── 程序入口 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)

  if (!args.command || args.command === 'help') {
    printHelp()
    process.exit(args.command === 'help' ? 0 : 1)
  }

  let exitCode = 1
  switch (args.command) {
    case 'render':
      if (args.engine === 'svg') {
        exitCode = await cmdRenderSvg(args)
      } else if (args.engine === 'mermaid') {
        exitCode = await cmdRender(args)
      } else {
        console.error(`❌  未知引擎：${args.engine}，可选值：mermaid | svg`)
        exitCode = 1
      }
      break
    default:
      console.error(`未知子命令：${args.command}`)
      printHelp()
      exitCode = 1
  }

  process.exit(exitCode)
}

main()
