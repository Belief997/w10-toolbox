'use strict';

// 编译亚克力底层 helper。用系统自带的 .NET Framework 编译器 + WinRT 元数据，
// 不需要装任何 SDK —— 这点很重要：整个工具链就是"有 Windows 就能编"。
//
//   node scripts/build-windows-backdrop.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function frameworkDir() {
  const windows = process.env.WINDIR || 'C:\\Windows';
  return path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
}

// GAC 里的程序集版本号不固定，扫一遍目录取最新的
function resolveGac(windows, name) {
  const base = path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL', name);
  for (const version of fs.readdirSync(base)) {
    const file = path.join(base, version, `${name}.dll`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`GAC 里找不到 ${name}.dll`);
}

function build({ root = path.resolve(__dirname, '..'), silent = false } = {}) {
  if (process.platform !== 'win32') throw new Error('亚克力 helper 只能在 Windows 上编译');
  const windows = process.env.WINDIR || 'C:\\Windows';
  const framework = frameworkDir();
  const metadata = path.join(windows, 'System32', 'WinMetadata');

  const output = path.join(root, 'build', 'windows-dock', 'GerritHelper.Backdrop.exe');
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const references = [
    path.join(framework, 'System.Web.Extensions.dll'),
    path.join(framework, 'System.Numerics.dll'),
    ...['Windows.UI', 'Windows.Graphics', 'Windows.Foundation']
      .map((name) => path.join(metadata, `${name}.winmd`)),
    path.join(framework, 'System.Runtime.WindowsRuntime.dll'),
    resolveGac(windows, 'System.Runtime'),
    resolveGac(windows, 'System.Numerics.Vectors')
  ];

  for (const file of references) {
    if (!fs.existsSync(file)) throw new Error(`缺少引用：${file}`);
  }

  const sources = ['CommandCurve.cs', 'BackdropHost.cs']
    .map((file) => path.join(root, 'src', 'windows-dock', file));

  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    `/out:${output}`,
    ...references.map((file) => `/r:${file}`),
    ...sources
  ], { stdio: silent ? 'pipe' : 'inherit', windowsHide: true });

  return output;
}

if (require.main === module) {
  try {
    console.log(`built ${build()}`);
  } catch (error) {
    console.error(`构建失败：${error.message}`);
    process.exit(1);
  }
}

module.exports = { build };
