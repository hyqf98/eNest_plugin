$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sdk = $env:WEBVIEW2_SDK_DIR
if (-not $sdk) { $sdk = Join-Path $root '.cache\webview2-1.0.2903.40' }
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$core = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll'
$license = @('LICENSE.txt','LICENSE','LICENSE.md') | ForEach-Object { Join-Path $sdk $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $license) { throw 'Set WEBVIEW2_SDK_DIR to an existing redistributable WebView2 SDK including its license.' }
foreach ($file in @($compiler,$core,$forms,$loader)) { if (-not (Test-Path -LiteralPath $file)) { throw "Missing prerequisite: $file" } }
$out = Join-Path $root 'helper-cache\win32-x64'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$refs = @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll') | ForEach-Object { '/reference:'+(Join-Path $framework $_) }
& $compiler /nologo /codepage:65001 /target:exe /platform:x64 /optimize+ ('/out:'+(Join-Path $out 'desktop-host.exe')) @refs ('/reference:'+$core) ('/reference:'+$forms) (Join-Path $PSScriptRoot 'Desktop.cs')
if ($LASTEXITCODE -ne 0) { throw 'Windows desktop helper compilation failed' }
foreach ($file in @($core,$forms,$loader)) { Copy-Item -LiteralPath $file -Destination $out -Force }
Copy-Item -LiteralPath $license -Destination (Join-Path $out 'WebView2-LICENSE.txt') -Force
