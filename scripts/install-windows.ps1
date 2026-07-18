$ErrorActionPreference = "Stop"

$Version = "v1.0.1"
$InstallDir = if ($env:LOCALTERMINAL_LITE_HOME) { $env:LOCALTERMINAL_LITE_HOME } else { Join-Path $HOME "LocalTerminal-Lite" }
$ArchiveUrl = if ($env:LOCALTERMINAL_LITE_ARCHIVE_URL) {
  $env:LOCALTERMINAL_LITE_ARCHIVE_URL
} else {
  "https://github.com/wyj-IIRtyj/localterminal-lite/archive/refs/tags/$Version.zip"
}
$LauncherDir = if ($env:LOCALTERMINAL_LITE_BIN_DIR) {
  $env:LOCALTERMINAL_LITE_BIN_DIR
} else {
  Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "LocalTerminal-Lite\bin"
}

$ReuseExisting = $false
if (Test-Path $InstallDir) {
  $ExistingPackagePath = Join-Path $InstallDir "package.json"
  $ExistingCliPath = Join-Path $InstallDir "src\cli.ts"
  $ExistingPackageName = if (Test-Path $ExistingPackagePath) {
    (Get-Content -Raw $ExistingPackagePath | ConvertFrom-Json).name
  } else {
    $null
  }
  if (($ExistingPackageName -eq "localterminal-mcp-lite") -and (Test-Path $ExistingCliPath)) {
    $ReuseExisting = $true
    Write-Host "Reusing the existing LocalTerminal Lite installation at $InstallDir"
  } else {
    throw "The target exists but is not a LocalTerminal Lite installation: $InstallDir. Move that path or set LOCALTERMINAL_LITE_HOME to a different location."
  }
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

if (-not $ReuseExisting) {
  $TemporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("localterminal-lite-" + [System.Guid]::NewGuid().ToString("N"))
  $Archive = Join-Path $TemporaryDir "localterminal-lite.zip"
  New-Item -ItemType Directory -Path $TemporaryDir | Out-Null

  try {
    Invoke-WebRequest $ArchiveUrl -OutFile $Archive
    Expand-Archive -Path $Archive -DestinationPath $TemporaryDir
    $SourceDir = Get-ChildItem -Path $TemporaryDir -Directory | Where-Object { $_.Name -like "localterminal-lite-*" } | Select-Object -First 1
    if (-not $SourceDir) {
      throw "The LocalTerminal Lite archive could not be unpacked."
    }
    Move-Item -Path $SourceDir.FullName -Destination $InstallDir
  } finally {
    Remove-Item -Path $TemporaryDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Set-Location $InstallDir
& $BunPath install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null
$PowerShellLauncher = Join-Path $LauncherDir "localterminal-lite.ps1"
$CommandLauncher = Join-Path $LauncherDir "localterminal-lite.cmd"
$EscapedInstallDir = $InstallDir.Replace("'", "''")
$EscapedBunPath = $BunPath.Replace("'", "''")
@(
  '$ErrorActionPreference = "Stop"'
  "Set-Location -LiteralPath '$EscapedInstallDir'"
  "& '$EscapedBunPath' run src/cli.ts @args"
  'exit $LASTEXITCODE'
) | Set-Content -Path $PowerShellLauncher -Encoding Unicode
@(
  '@echo off'
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0localterminal-lite.ps1" %*'
) | Set-Content -Path $CommandLauncher -Encoding Ascii

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$UserPathEntries = @($UserPath -split ';' | Where-Object { $_ })
$LauncherPathExists = $UserPathEntries | Where-Object {
  $_.TrimEnd('\') -ieq $LauncherDir.TrimEnd('\')
}
if (-not $LauncherPathExists) {
  $NewUserPath = if ($UserPath) { "$LauncherDir;$UserPath" } else { $LauncherDir }
  [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
}
if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $LauncherDir.TrimEnd('\') })) {
  $env:Path = "$LauncherDir;$env:Path"
}

Write-Host "Installed the global command: localterminal-lite"
Write-Host "In future PowerShell or Command Prompt windows, start Lite by running: localterminal-lite"
if ($env:LOCALTERMINAL_LITE_INSTALL_ONLY -eq "1") {
  return
}
& $PowerShellLauncher
