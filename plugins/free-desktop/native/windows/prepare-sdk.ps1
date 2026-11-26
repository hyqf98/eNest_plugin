$ErrorActionPreference = 'Stop'
$version = '1.0.2903.40'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cache = Join-Path $root ('.cache\webview2-'+$version)
$required = @('lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll')
if ((Test-Path (Join-Path $cache 'LICENSE.txt')) -and -not ($required | Where-Object { -not (Test-Path (Join-Path $cache $_)) })) { return }
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ('free-desktop-sdk-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $package = Join-Path $temporary ('microsoft.web.webview2.'+$version+'.nupkg')
    Invoke-WebRequest -UseBasicParsing -Uri ("https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg") -OutFile $package
    & dotnet nuget verify $package --all
    if ($LASTEXITCODE -ne 0) { throw 'The pinned WebView2 SDK failed NuGet signature verification.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($package)
    try {
        $license = $archive.Entries | Where-Object { $_.FullName -match '^(?:license|licence|license\.txt|license\.md|webview2license\.txt)$' } | Select-Object -First 1
        if (-not $license) { throw 'The WebView2 SDK must include its redistribution license.' }
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        foreach ($path in $required) {
            $source = $archive.GetEntry($path)
            if (-not $source) { throw "The verified SDK is missing $path" }
            $destination = Join-Path $cache $path
            New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($source,$destination,$true)
        }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($license,(Join-Path $cache 'LICENSE.txt'),$true)
    } finally { $archive.Dispose() }
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
