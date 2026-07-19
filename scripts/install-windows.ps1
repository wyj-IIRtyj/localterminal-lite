$ErrorActionPreference = "Stop"

$Version = "v1.0.1"
$InstallDir = if ($env:LOCALTERMINAL_LITE_HOME) { $env:LOCALTERMINAL_LITE_HOME } else { Join-Path $HOME "LocalTerminal-Lite" }
$ArchiveUrl = if ($env:LOCALTERMINAL_LITE_ARCHIVE_URL) { $env:LOCALTERMINAL_LITE_ARCHIVE_URL } else { "https://github.com/wyj-IIRtyj/localterminal-lite/archive/refs/tags/$Version.zip" }
$LauncherDir = if ($env:LOCALTERMINAL_LITE_BIN_DIR) { $env:LOCALTERMINAL_LITE_BIN_DIR } else { Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "LocalTerminal-Lite\bin" }
$TemporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("localterminal-lite-" + [System.Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $TemporaryDir "localterminal-lite.zip"
$BackupDir = $null
$Committed = $false

try {
  if (Test-Path $InstallDir) {
    $PackagePath = Join-Path $InstallDir "package.json"
    $CliPath = Join-Path $InstallDir "src\cli.ts"
    $PackageName = if (Test-Path $PackagePath) { (Get-Content -Raw $PackagePath | ConvertFrom-Json).name } else { $null }
    if (($PackageName -ne "localterminal-mcp-lite") -or -not (Test-Path $CliPath)) {
      throw "The target exists but is not a LocalTerminal Lite installation: $InstallDir"
    }
    if ((Test-Path (Join-Path $InstallDir ".git")) -and ($env:LOCALTERMINAL_LITE_ALLOW_SOURCE_UPDATE -ne "1")) {
      throw "Refusing to overwrite a Git source checkout: $InstallDir. Use git pull or set LOCALTERMINAL_LITE_HOME to the release installation directory."
    }
  }

  $Bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $Bun) {
    Invoke-RestMethod https://bun.com/install.ps1 | Invoke-Expression
    $BunPath = Join-Path $HOME ".bun\bin\bun.exe"
    if (-not (Test-Path $BunPath)) { throw "Bun installation did not create $BunPath" }
  } else { $BunPath = $Bun.Source }

  New-Item -ItemType Directory -Path $TemporaryDir | Out-Null
  Invoke-WebRequest $ArchiveUrl -OutFile $Archive
  Expand-Archive -Path $Archive -DestinationPath $TemporaryDir
  $SourceDir = Get-ChildItem -Path $TemporaryDir -Directory | Where-Object { $_.Name -like "localterminal-lite-*" } | Select-Object -First 1
  if (-not $SourceDir) { throw "The LocalTerminal Lite archive could not be unpacked." }

  Push-Location $SourceDir.FullName
  try {
    & $BunPath install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
    & $BunPath run typecheck
    if ($LASTEXITCODE -ne 0) { throw "Downloaded release failed type checking." }
  } finally { Pop-Location }

  if (Test-Path $InstallDir) {
    $BackupDir = "$InstallDir.backup.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
    Move-Item -LiteralPath $InstallDir -Destination $BackupDir
  }
  Move-Item -LiteralPath $SourceDir.FullName -Destination $InstallDir

  New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null
  $PowerShellLauncher = Join-Path $LauncherDir "localterminal-lite.ps1"
  $CommandLauncher = Join-Path $LauncherDir "localterminal-lite.cmd"
  $EscapedInstallDir = $InstallDir.Replace("'", "''")
  $EscapedBunPath = $BunPath.Replace("'", "''")
  @('$ErrorActionPreference = "Stop"', "Set-Location -LiteralPath '$EscapedInstallDir'", "& '$EscapedBunPath' run src/cli.ts @args", 'exit $LASTEXITCODE') | Set-Content -Path $PowerShellLauncher -Encoding Unicode
  @('@echo off', 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0localterminal-lite.ps1" %*') | Set-Content -Path $CommandLauncher -Encoding Ascii

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $Entries = @($UserPath -split ';' | Where-Object { $_ })
  if (-not ($Entries | Where-Object { $_.TrimEnd('\') -ieq $LauncherDir.TrimEnd('\') })) {
    $NewUserPath = if ($UserPath) { "$LauncherDir;$UserPath" } else { $LauncherDir }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
  }
  $Committed = $true
  Write-Host "Installed LocalTerminal Lite $Version: $InstallDir"
  Write-Host "Start it with: localterminal-lite"
  if ($env:LOCALTERMINAL_LITE_INSTALL_ONLY -ne "1") { & $PowerShellLauncher }
} catch {
  if (-not $Committed) {
    if (Test-Path $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($BackupDir -and (Test-Path $BackupDir)) { Move-Item -LiteralPath $BackupDir -Destination $InstallDir -ErrorAction SilentlyContinue }
  }
  throw
} finally {
  if ($Committed -and $BackupDir -and (Test-Path $BackupDir)) { Remove-Item -LiteralPath $BackupDir -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $TemporaryDir -Recurse -Force -ErrorAction SilentlyContinue
}
