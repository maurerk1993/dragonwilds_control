param(
  [string]$InstallFolder = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$ShortcutName = 'Dragonwilds Server Control.lnk'
)

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $InstallFolder 'Start-DragonwildsControl.bat'
if (!(Test-Path -LiteralPath $launcher)) {
  throw "Launcher not found: $launcher"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop $ShortcutName
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $InstallFolder
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$shortcut.Description = 'Launch Dragonwilds Server Control'
$shortcut.Save()

Write-Output "Created desktop shortcut: $shortcutPath"
