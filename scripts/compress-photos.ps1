# compress-photos.ps1
# Uses Windows GDI+ (System.Drawing) — fast native JPEG encoding
# Resizes all photos to max 1200px wide, JPEG quality 75

Add-Type -AssemblyName System.Drawing

$photosDir = "d:\myp&v\photo-finder\public\photos"
$maxWidth  = 1200
$quality   = 75
$allowed   = @(".jpg",".jpeg",".png",".webp")

$files = Get-ChildItem $photosDir -File | Where-Object { $allowed -contains $_.Extension.ToLower() }

Write-Host ""
Write-Host "Compressing $($files.Count) photos -> max ${maxWidth}px @ ${quality}% quality"
Write-Host "Before: $([math]::Round(($files | Measure-Object -Property Length -Sum).Sum/1GB, 2)) GB"
Write-Host ""

$ok = 0; $fail = 0; $i = 0

# JPEG encoder with quality param
$jpgCodec  = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
    [System.Drawing.Imaging.Encoder]::Quality, [long]$quality
)

foreach ($file in $files) {
    $i++
    try {
        $src = [System.Drawing.Image]::FromFile($file.FullName)

        # Calculate new dimensions
        $newW = $src.Width
        $newH = $src.Height
        if ($src.Width -gt $maxWidth) {
            $newW = $maxWidth
            $newH = [int]($src.Height * ($maxWidth / $src.Width))
        }

        # Draw resized
        $bmp = New-Object System.Drawing.Bitmap($newW, $newH)
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($src, 0, 0, $newW, $newH)
        $g.Dispose()
        $src.Dispose()

        # Save as JPEG (always .jpg output)
        $outPath = [System.IO.Path]::ChangeExtension($file.FullName, ".jpg")
        $bmp.Save($outPath, $jpgCodec, $encParams)
        $bmp.Dispose()

        # Remove original if extension changed
        if ($outPath -ne $file.FullName -and (Test-Path $file.FullName)) {
            Remove-Item $file.FullName -Force
        }

        $ok++
    } catch {
        $fail++
        Write-Host "  FAIL $($file.Name): $_"
    }

    if ($i % 20 -eq 0 -or $i -eq $files.Count) {
        $pct = [math]::Round($i / $files.Count * 100)
        Write-Host -NoNewline "`r  [$($pct.ToString().PadLeft(3))%] $i/$($files.Count) -- OK:$ok  FAIL:$fail    "
    }
}

$afterFiles = Get-ChildItem $photosDir -File | Where-Object { $allowed -contains $_.Extension.ToLower() }
$afterMB    = [math]::Round(($afterFiles | Measure-Object -Property Length -Sum).Sum / 1MB, 0)

Write-Host ""
Write-Host ""
Write-Host "----------------------------------------"
Write-Host "Compressed : $ok"
Write-Host "Failed     : $fail"
Write-Host "After      : ${afterMB} MB"
Write-Host "----------------------------------------"

if ($afterMB -gt 900) {
    Write-Host "WARNING: >900MB, consider reducing maxWidth to 900"
} else {
    Write-Host "Done! Now add to git and push."
}
