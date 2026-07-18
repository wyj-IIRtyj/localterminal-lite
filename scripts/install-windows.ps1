$ErrorActionPreference = "Stop"

$Version = "v1.0.0"
$InstallDir = if ($env:LOCALTERMINAL_LITE_HOME) { $env:LOCALTERMINAL_LITE_HOME } else { Join-Path $HOME "LocalTerminal-Lite" }

if (Test-Path $InstallDir) {
  throw "LocalTerminal Lite already exists at $InstallDir. Move that folder or set LOCALTERMINAL_LITE_HOME to a new location, then run this command again."
}

$Bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $Bun) {
  Invoke-RestMethod https://bun.com/install.ps1 | Invoke-Expression
  $BunPath = Join-Path $HOME ".bun\bin\bun.exe"
  if (-not (Test-Path $BunPath)) {
    throw "Bun installation did not create $BunPath"
  }
} else {
  $BunPath = $Bun.Source
}

$TemporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("localterminal-lite-" + [System.Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $TemporaryDir "localterminal-lite.zip"
New-Item -ItemType Directory -Path $TemporaryDir | Out-Null

try {
  Invoke-WebRequest "https://github.com/wyj-IIRtyj/localterminal-lite/archive/refs/tags/$Version.zip" -OutFile $Archive
  Expand-Archive -Path $Archive -DestinationPath $TemporaryDir
  $SourceDir = Get-ChildItem -Path $TemporaryDir -Directory | Where-Object { $_.Name -like "localterminal-lite-*" } | Select-Object -First 1
  if (-not $SourceDir) {
    throw "The LocalTerminal Lite archive could not be unpacked."
  }
  Move-Item -Path $SourceDir.FullName -Destination $InstallDir
} finally {
  Remove-Item -Path $TemporaryDir -Recurse -Force -ErrorAction SilentlyContinue
}

Set-Location $InstallDir
& $BunPath install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
& $BunPath run dev
