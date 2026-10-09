Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$iconDirectory = Join-Path $projectRoot 'icons'
New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null

$sourcePath = Join-Path $iconDirectory 'output-onlinepngtools.png'
$original = [System.Drawing.Bitmap]::new($sourcePath)
$source = [System.Drawing.Bitmap]::new($original.Width, $original.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt $original.Height; $y++) {
    for ($x = 0; $x -lt $original.Width; $x++) {
        $pixel = $original.GetPixel($x, $y)
        $brightness = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
        if ($brightness -le 18) {
            $pixel = [System.Drawing.Color]::FromArgb(0, $pixel.R, $pixel.G, $pixel.B)
        } elseif ($brightness -lt 56) {
            $alpha = [int]($pixel.A * (($brightness - 18) / 38))
            $pixel = [System.Drawing.Color]::FromArgb($alpha, $pixel.R, $pixel.G, $pixel.B)
        }
        $source.SetPixel($x, $y, $pixel)
    }
}
$original.Dispose()
$source.Save((Join-Path $iconDirectory 'brand-logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)

foreach ($size in @(16, 32, 48, 128)) {
    $output = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $outputGraphics = [System.Drawing.Graphics]::FromImage($output)
    $outputGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $outputGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $outputGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $outputGraphics.DrawImage($source, 0, 0, $size, $size)
    $output.Save((Join-Path $iconDirectory "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $outputGraphics.Dispose()
    $output.Dispose()
}

$source.Dispose()
Write-Output "Generated Chrome icons in $iconDirectory"