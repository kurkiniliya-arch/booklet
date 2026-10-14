param(
    [string]$VaultPath,
    [string]$BootstrapFile,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $projectRoot 'dist\win-unpacked'
$sourceExe = Join-Path $source 'Project Book.exe'
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw 'First build the app: npm run build'
}
$programsRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'))
$installRoot = [IO.Path]::GetFullPath((Join-Path $programsRoot 'Project Book'))
if ([IO.Path]::GetDirectoryName($installRoot) -ne $programsRoot) { throw 'Unexpected installation path.' }
if (Test-Path -LiteralPath $installRoot) {
    if ((Get-Item -LiteralPath $installRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directory must not be a junction.' }
}
$installedExe = Join-Path $installRoot 'Project Book.exe'
$running = Get-Process -Name 'Project Book' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedExe }
if ($running) { throw 'Close Project Book before installing an update.' }
[IO.Directory]::CreateDirectory($installRoot) | Out-Null
Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $installRoot -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $projectRoot 'assets\book.ico') -Destination (Join-Path $installRoot 'book.ico') -Force
if ((Get-FileHash -LiteralPath $installedExe).Hash -ne (Get-FileHash -LiteralPath $sourceExe).Hash) { throw 'Installed executable did not match the build.' }

$shellLink = New-Object -ComObject WScript.Shell
$shortcutPaths = @()
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $shortcutPath = Join-Path $folder 'Книга проектов.lnk'
    $shortcut = $shellLink.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $installedExe
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = 'Личная книга проектов'
    $shortcut.IconLocation = "$(Join-Path $installRoot 'book.ico'),0"
    $shortcut.Save()
    $shortcutPaths += $shortcutPath
    # Retire only the shortcut created by the previous product name.
    $legacyShortcutPath = Join-Path $folder 'Книга квестов.lnk'
    if (Test-Path -LiteralPath $legacyShortcutPath -PathType Leaf) {
        $legacyShortcut = $shellLink.CreateShortcut($legacyShortcutPath)
        $legacyExecutable = Join-Path $programsRoot 'Quest Book\Quest Book.exe'
        if ($legacyShortcut.TargetPath -eq $legacyExecutable) { Remove-Item -LiteralPath $legacyShortcutPath }
    }
}
if ($Launch) {
    $launchArguments = @()
    if ($VaultPath) { $launchArguments += '--vault'; $launchArguments += '"' + [IO.Path]::GetFullPath($VaultPath) + '"' }
    if ($BootstrapFile) { $launchArguments += '--bootstrap'; $launchArguments += '"' + [IO.Path]::GetFullPath($BootstrapFile) + '"' }
    if ($launchArguments.Count) { Start-Process -FilePath $installedExe -WorkingDirectory $installRoot -ArgumentList $launchArguments }
    else { Start-Process -FilePath $installedExe -WorkingDirectory $installRoot }
}
[PSCustomObject]@{ Executable = $installedExe; Shortcuts = $shortcutPaths } | ConvertTo-Json
