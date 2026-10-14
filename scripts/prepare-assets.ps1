$ErrorActionPreference = 'Stop'
function Get-AssetHash([string]$FilePath) {
    $inputStream = [IO.File]::OpenRead($FilePath)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($inputStream))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $inputStream.Dispose() }
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$textureRoot = Join-Path $projectRoot 'src\renderer\assets'
[IO.Directory]::CreateDirectory($textureRoot) | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'minecraft-assets.json') -Raw | ConvertFrom-Json
foreach ($asset in $manifest) {
    if ($asset.file -notmatch '^[a-z_-]+\.png$') { throw 'Unexpected asset filename.' }
    $destination = Join-Path $textureRoot $asset.file
    $assetVerified = (Test-Path -LiteralPath $destination) -and ((Get-AssetHash $destination) -eq $asset.sha256)
    if (-not $assetVerified) { Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $destination }
    if ((Get-AssetHash $destination) -ne $asset.sha256) { throw "Asset integrity check failed: $($asset.file)" }
}

# Convert the original sprite into Windows icon containers; preserve its pixels.
Add-Type -AssemblyName System.Drawing
$sprite = [Drawing.Bitmap]::FromFile((Join-Path $textureRoot 'book-icon.png'))
$images = @()
try {
    foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
        $bitmap = New-Object Drawing.Bitmap($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object IO.MemoryStream
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
            $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.DrawImage($sprite, (New-Object Drawing.Rectangle(0, 0, $size, $size)), 0, 0, $sprite.Width, $sprite.Height, [Drawing.GraphicsUnit]::Pixel)
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $images += [PSCustomObject]@{ Size = $size; Bytes = $stream.ToArray() }
        } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $sprite.Dispose() }
$outRoot = Join-Path $projectRoot 'assets'
[IO.Directory]::CreateDirectory($outRoot) | Out-Null
[IO.File]::WriteAllBytes((Join-Path $outRoot 'book.png'), $images[-1].Bytes)
$iconStream = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter($iconStream)
try {
    $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($image in $images) {
        $dimension = if ($image.Size -eq 256) { 0 } else { $image.Size }
        $writer.Write([Byte]$dimension); $writer.Write([Byte]$dimension)
        $writer.Write([Byte]0); $writer.Write([Byte]0)
        $writer.Write([UInt16]1); $writer.Write([UInt16]32)
        $writer.Write([UInt32]$image.Bytes.Length); $writer.Write([UInt32]$offset)
        $offset += $image.Bytes.Length
    }
    foreach ($image in $images) { $writer.Write([Byte[]]$image.Bytes) }
    [IO.File]::WriteAllBytes((Join-Path $outRoot 'book.ico'), $iconStream.ToArray())
} finally { $writer.Dispose(); $iconStream.Dispose() }
Write-Output 'Book textures verified and Windows icon packaged.'
