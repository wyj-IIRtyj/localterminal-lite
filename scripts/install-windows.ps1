$ErrorActionPreference = "Stop"

$Version = if ($env:LOCALTERMINAL_LITE_VERSION) { $env:LOCALTERMINAL_LITE_VERSION } else { "v1.1.0" }
$Repository = "wyj-IIRtyj/localterminal-lite"
$InstallDir = if ($env:LOCALTERMINAL_LITE_HOME) { $env:LOCALTERMINAL_LITE_HOME } else { Join-Path $HOME "LocalTerminal-Lite" }
$LauncherDir = if ($env:LOCALTERMINAL_LITE_BIN_DIR) { $env:LOCALTERMINAL_LITE_BIN_DIR } else { Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "LocalTerminal-Lite\bin" }
$Asset = "localterminal-lite-windows-x64.zip"
$AssetUrl = if ($env:LOCALTERMINAL_LITE_ASSET_URL) { $env:LOCALTERMINAL_LITE_ASSET_URL } else { "https://github.com/$Repository/releases/download/$Version/$Asset" }
$ChecksumUrl = if ($env:LOCALTERMINAL_LITE_CHECKSUM_URL) { $env:LOCALTERMINAL_LITE_CHECKSUM_URL } else { "$AssetUrl.sha256" }
$TemporaryDir = Join-Path ([System.IO.Path]::GetTempPath()) ("localterminal-lite-" + [System.Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $TemporaryDir $Asset
$ChecksumFile = "$Archive.sha256"
$BackupDir = $null
$MigratingLegacy = $false
$Committed = $false

function Test-BinaryLayout {
  return (Test-Path (Join-Path $InstallDir "releases")) -and (Test-Path (Join-Path $InstallDir "current"))
}

function Test-LegacyLayout {
  $PackagePath = Join-Path $InstallDir "package.json"
  $CliPath = Join-Path $InstallDir "src\cli.ts"
  if (-not ((Test-Path $PackagePath) -and (Test-Path $CliPath))) { return $false }
  try { return ((Get-Content -Raw $PackagePath | ConvertFrom-Json).name -eq "localterminal-mcp-lite") }
  catch { return $false }
}

try {
  if (Test-Path $InstallDir) {
    if ((Test-Path (Join-Path $InstallDir ".git")) -and ($env:LOCALTERMINAL_LITE_ALLOW_SOURCE_UPDATE -ne "1")) {
      throw "Refusing to overwrite a Git source checkout: $InstallDir"
    }
    if (-not (Test-BinaryLayout) -and -not (Test-LegacyLayout)) {
      throw "The target exists but is not a recognized LocalTerminal Lite installation: $InstallDir"
    }
    if (Test-LegacyLayout) {
      $MigratingLegacy = $true
      $BackupDir = "$InstallDir.backup.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
      Move-Item -LiteralPath $InstallDir -Destination $BackupDir
    }
  }

  New-Item -ItemType Directory -Force -Path $TemporaryDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "releases") | Out-Null
  New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null

  Invoke-WebRequest $AssetUrl -OutFile $Archive
  Invoke-WebRequest $ChecksumUrl -OutFile $ChecksumFile
  $Expected = ((Get-Content -Raw $ChecksumFile).Trim() -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
  if (-not $Expected -or $Expected -ne $Actual) { throw "SHA-256 verification failed for $Asset" }

  $Expanded = Join-Path $TemporaryDir "expanded"
  Expand-Archive -Path $Archive -DestinationPath $Expanded
  $Binary = Join-Path $Expanded "localterminal-lite.exe"
  if (-not (Test-Path $Binary)) { throw "Release asset does not contain localterminal-lite.exe" }

  $ReleaseDir = Join-Path (Join-Path $InstallDir "releases") $Version
  $ReleaseStaging = Join-Path (Join-Path $InstallDir "releases") (".$Version.staging.$PID")
  Remove-Item -LiteralPath $ReleaseStaging -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $ReleaseStaging | Out-Null
  Copy-Item -LiteralPath $Binary -Destination (Join-Path $ReleaseStaging "localterminal-lite.exe")
  Remove-Item -LiteralPath $ReleaseDir -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $ReleaseStaging -Destination $ReleaseDir

  $CurrentTmp = Join-Path $InstallDir "current.tmp"
  $CurrentPath = Join-Path $InstallDir "current"
  Set-Content -Path $CurrentTmp -Value $Version -Encoding Ascii
  Move-Item -LiteralPath $CurrentTmp -Destination $CurrentPath -Force

  $PowerShellLauncher = Join-Path $LauncherDir "localterminal-lite.ps1"
  $CommandLauncher = Join-Path $LauncherDir "localterminal-lite.cmd"
  $EscapedInstallDir = $InstallDir.Replace("'", "''")
  @(
    '$ErrorActionPreference = "Stop"',
    "`$Root = '$EscapedInstallDir'",
    '$Version = (Get-Content -Raw (Join-Path $Root "current")).Trim()',
    '$Binary = Join-Path (Join-Path (Join-Path $Root "releases") $Version) "localterminal-lite.exe"',
    '& $Binary @args',
    'exit $LASTEXITCODE'
  ) | Set-Content -Path $PowerShellLauncher -Encoding UTF8
  @('@echo off', 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0localterminal-lite.ps1" %*') | Set-Content -Path $CommandLauncher -Encoding Ascii

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $Entries = @($UserPath -split ';' | Where-Object { $_ })
  if (-not ($Entries | Where-Object { $_.TrimEnd('\') -ieq $LauncherDir.TrimEnd('\') })) {
    $NewUserPath = if ($UserPath) { "$LauncherDir;$UserPath" } else { $LauncherDir }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
  }

  Get-ChildItem -Path (Join-Path $InstallDir "releases") -Directory -Filter "v*" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 2 |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  $Committed = $true
  Write-Host "Installed LocalTerminal Lite $Version: $InstallDir"
  Write-Host "User settings and workspace state were preserved."
  Write-Host "Start it with: localterminal-lite"
  if ($env:LOCALTERMINAL_LITE_INSTALL_ONLY -ne "1") { & $PowerShellLauncher }
} catch {
  if (-not $Committed -and $MigratingLegacy) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    if ($BackupDir -and (Test-Path $BackupDir)) { Move-Item -LiteralPath $BackupDir -Destination $InstallDir -ErrorAction SilentlyContinue }
  }
  throw
} finally {
  if ($Committed -and $BackupDir -and (Test-Path $BackupDir)) { Remove-Item -LiteralPath $BackupDir -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $TemporaryDir -Recurse -Force -ErrorAction SilentlyContinue
}
