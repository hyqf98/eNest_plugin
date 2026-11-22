$ErrorActionPreference = 'Stop'
$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = if ($env:WEBVIEW2_VERSION) { $env:WEBVIEW2_VERSION } else { '1.0.2903.40' }
$cache = Join-Path $PSScriptRoot ".cache\webview2-$version"
$output = Join-Path $pluginRoot 'helper-cache\win32-x64'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'

if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found: $csc" }
node (Join-Path $pluginRoot 'scripts\fetch-webview2.mjs')
if ($LASTEXITCODE -ne 0) { throw 'WebView2 SDK fetch failed' }

$core = Join-Path $cache 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$winforms = Join-Path $cache 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $cache 'runtimes\win-x64\native\WebView2Loader.dll'
foreach ($file in @($core, $winforms, $loader)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "missing WebView2 file: $file" }
}

New-Item -ItemType Directory -Force -Path $output | Out-Null
$exe = Join-Path $output 'wallpaper-host.exe'
$references = @(
  (Join-Path $framework 'System.dll'),
  (Join-Path $framework 'System.Core.dll'),
  (Join-Path $framework 'System.Windows.Forms.dll'),
  (Join-Path $framework 'System.Drawing.dll'),
  (Join-Path $framework 'System.Web.Extensions.dll'),
  $core,
  $winforms
) | ForEach-Object { "/reference:$_" }

& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$exe" @references (Join-Path $PSScriptRoot 'Program.cs') (Join-Path $PSScriptRoot 'LocalMediaServer.cs')
if ($LASTEXITCODE -ne 0) { throw "C# helper compilation failed with exit code $LASTEXITCODE" }

Copy-Item -LiteralPath $core -Destination $output -Force
Copy-Item -LiteralPath $winforms -Destination $output -Force
Copy-Item -LiteralPath $loader -Destination $output -Force
$manifest = @{
  version = '0.0.1'
  protocolVersion = 1
  target = 'win32-x64'
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $output 'helper.json') -Value $manifest -Encoding UTF8
Write-Output "Built $exe"
